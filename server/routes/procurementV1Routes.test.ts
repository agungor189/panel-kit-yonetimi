import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { ProcurementImportService } from "../modules/procurement/procurementImportService.js";
import { createProcurementV1Router } from "./procurementV1Routes.js";

let db: Database.Database;
let baseUrl = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  db = new Database(":memory:");
  initializeDatabase(db);
  new CatalogService(db).createProduct({ id: "part", sku: "PART", title: "Part", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO cash_accounts (id,name,currency) VALUES ('usd','USD','USD')").run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "owner", username: "Owner" } as typeof req.user; next(); });
  const allow: express.RequestHandler = (_req, _res, next) => next();
  app.use("/api/procurement/v1", createProcurementV1Router({ db, authorizeProcurement: allow, authorizeCostApproval: allow, authorizePayment: allow, authorizeFx: allow }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => { server?.close(); db?.close(); });

const post = (path: string, operationId: string, body: unknown) => fetch(`${baseUrl}/api/procurement/v1${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-operation-id": operationId }, body: JSON.stringify(body),
});

test('import apply fails closed without a catalog capability middleware', async () => {
  const response = await post('/imports/apply', 'unauthorized-import', { csv: 'untrusted' });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).error.code, 'CATALOG_AUTHORIZATION_REQUIRED');
});

test("procurement API requires operation identity and replays exact mutation results", async () => {
  assert.equal((await post("/fx/usd-try", "fx-40", { rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z" })).status, 201);
  assert.equal((await post("/suppliers", "supplier-create", { id: "supplier", name: "Supplier", defaultCurrency: "USD" })).status, 201);
  const body = { id: "purchase", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST", invoiceNumber: "INV-1", invoiceDate: "2026-09-20", lines: [{ id: "line", productId: "part", quantity: "1", quoteBasis: "piece", supplierUnitPriceMinor: 1000, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 2000 }] };
  const missing = await fetch(`${baseUrl}/api/procurement/v1/purchases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(missing.status, 400);
  const first = await (await post("/purchases", "purchase-create", body)).json() as any;
  const replay = await (await post("/purchases", "purchase-create", body)).json() as any;
  assert.equal(first.idempotent, false);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.data, first.data);
  assert.equal(db.prepare("SELECT COUNT(*) FROM purchase_orders WHERE id='purchase'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='procurement.purchase.create.v1'").pluck().get(), 1);
});

test('import draft cost mutations replay safely and FINAL conversion remains explicit', async () => {
  const records = [
    { record_type:'PURCHASE',record_id:'p',invoice_number:'ROUTE-DRAFT',invoice_date:'2026-09-20',supplier_name:'Supplier',currency:'USD' },
    { record_type:'LINE',record_id:'line',parent_ref:'p',sku:'PART',quantity:'1',unit_price:'10.00',amount:'10.00',currency:'USD',uom:'piece',pricing_basis:'BILLED' },
    { record_type:'PACKAGE_GROUP',record_id:'group',parent_ref:'p',package_count:'1',meta_json:'{"mixed":false}' },
    { record_type:'PACKAGE_ITEM',record_id:'item',parent_ref:'group',sku:'PART',purchase_line_ref:'line',quantity:'1',units_per_package:'1',uom:'piece' },
  ].map(row => ({ schema_version:'dsdst.procurement.import.v1', ...row }));
  const fields = [...new Set(records.flatMap(Object.keys))];
  const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"','""')}"`;
  const csv = fields.map(cell).join(',') + '\r\n' + records.map(row => fields.map(field => cell((row as any)[field])).join(',')).join('\r\n');
  const importer = new ProcurementImportService(db);
  const request = { csv, supplierId:'supplier' };
  const draft = importer.apply({ ...request, expectedPreviewHash:importer.preview(request).previewHash },'owner');
  const cost = { title:'Nakliye',amountMinor:100,currency:'USD',description:'fixture' };
  const first = await (await post(`/imports/drafts/${draft.id}/costs`,'draft-cost-add',cost)).json() as any;
  const replay = await (await post(`/imports/drafts/${draft.id}/costs`,'draft-cost-add',cost)).json() as any;
  assert.equal(replay.idempotent,true);
  assert.equal(first.data.draftCosts.length,1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_import_draft_costs WHERE draft_id=?').pluck().get(draft.id),1);
  const item = first.data.draftCosts[0];
  const update = await (await post(`/imports/drafts/${draft.id}/costs/${item.id}/update`,'draft-cost-update',{...cost,amountMinor:200,expectedVersion:1})).json() as any;
  assert.equal(update.data.draftCosts[0].amountMinor,200);
  const removed = await (await post(`/imports/drafts/${draft.id}/costs/${item.id}/remove`,'draft-cost-remove',{expectedVersion:2})).json() as any;
  assert.equal(removed.data.draftCosts.length,0);
  const decision = {
    vatMode:'EXCLUDED',vatRateBps:0,acquisitionCostVatPolicy:'VAT_EXCLUDED_FROM_INVENTORY_COST',
    includedCost:'NO_SEPARATE_CHARGE',stockCheck:'NO_PRIOR_RECEIPT',stockEvidence:'Synthetic empty DB',costDecisions:[],
  };
  const before = db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get() as number;
  const preview = await (await post(`/imports/drafts/${draft.id}/cost-preview`,'',decision)).json() as any;
  assert.equal(preview.data.readOnly,true);
  assert.equal(db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get(),before);
  const unapproved = await post(`/imports/drafts/${draft.id}/finalize`,'draft-unapproved',decision);
  assert.equal(unapproved.status,409);
  const final = await (await post(`/imports/drafts/${draft.id}/finalize`,'draft-finalize',{
    ...decision,expectedPreviewHash:preview.data.previewHash,approvePreview:true,
  })).json() as any;
  assert.equal(final.data.status,'APPROVED');
  assert.equal(db.prepare('SELECT COUNT(*) FROM inventory_ledger_events').pluck().get(),0);
});

test('cancel draft API requires operation identity, replays safely and removes the draft from purchase listing', async () => {
  const rows = [
    { record_type:'PURCHASE',record_id:'p',invoice_number:'ROUTE-CANCEL',invoice_date:'2026-09-20',supplier_name:'Supplier',currency:'USD' },
    { record_type:'LINE',record_id:'line',parent_ref:'p',sku:'PART',quantity:'1',unit_price:'1.00',amount:'1.00',currency:'USD',uom:'piece',pricing_basis:'BILLED' },
    { record_type:'PACKAGE_GROUP',record_id:'group',parent_ref:'p',package_count:'1',meta_json:'{"mixed":false}' },
    { record_type:'PACKAGE_ITEM',record_id:'item',parent_ref:'group',sku:'PART',purchase_line_ref:'line',quantity:'1',units_per_package:'1',uom:'piece' },
  ].map(row => ({ schema_version:'dsdst.procurement.import.v1',...row }));
  const fields = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value:unknown) => `"${String(value ?? '').replaceAll('"','""')}"`;
  const csv = fields.map(cell).join(',')+'\r\n'+rows.map(row => fields.map(field => cell((row as any)[field])).join(',')).join('\r\n');
  const importer = new ProcurementImportService(db);
  const input = { csv,supplierId:'supplier' };
  const draft = importer.apply({ ...input,expectedPreviewHash:importer.preview(input).previewHash },'owner');
  const missing = await fetch(`${baseUrl}/api/procurement/v1/imports/drafts/${draft.id}/cancel`,{ method:'POST',headers:{'content-type':'application/json'},body:'{}' });
  assert.equal(missing.status,400);
  const first = await (await post(`/imports/drafts/${draft.id}/cancel`,'draft-cancel',{})).json() as any;
  const replay = await (await post(`/imports/drafts/${draft.id}/cancel`,'draft-cancel',{})).json() as any;
  assert.equal(first.data.status,'CANCELLED');
  assert.equal(replay.idempotent,true);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_import_draft_lifecycle_events WHERE draft_id=?').pluck().get(draft.id),1);
  const list = await (await fetch(`${baseUrl}/api/procurement/v1/purchases`)).json() as any;
  assert.equal(list.data.some((item:any) => item.id === draft.id),false);
  assert.equal((await fetch(`${baseUrl}/api/procurement/v1/purchases/${draft.id}`)).status,404);
  assert.equal((await post(`/imports/drafts/${draft.id}/cancel`,'cancel-completed',{})).status,409);
});

test("cost finalization and payment are separate idempotent commands and do not create inventory", async () => {
  const stockBefore = db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get();
  const movementBefore = db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get();
  const finalized = await (await post("/purchases/purchase/finalize-costs", "purchase-finalize", { allocations: [] })).json() as any;
  assert.equal(finalized.data.lots.length, 1);
  assert.equal(finalized.data.lots[0].state, "COSTED_PENDING_RECEIPT");
  const paymentBody = { id: "payment", cashAccountId: "usd", amountMinor: 500, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z", reference: "BANK" };
  const first = await (await post("/purchases/purchase/payments", "purchase-payment", paymentBody)).json() as any;
  const replay = await (await post("/purchases/purchase/payments", "purchase-payment", paymentBody)).json() as any;
  assert.equal(first.data.paymentStatus, "PARTIAL");
  assert.equal(replay.idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM purchase_payments WHERE purchase_order_id='purchase'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE purchase_id='purchase'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM cash_transactions WHERE source_type='procurement_purchase_payment' AND source_id='payment'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get(), stockBefore);
  assert.equal(db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get(), movementBefore);
});

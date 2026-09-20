import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
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

test("procurement API requires operation identity and replays exact mutation results", async () => {
  assert.equal((await post("/fx/usd-try", "fx-40", { rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z" })).status, 201);
  assert.equal((await post("/suppliers", "supplier-create", { id: "supplier", name: "Supplier", defaultCurrency: "USD" })).status, 201);
  const body = { id: "purchase", supplierId: "supplier", invoiceNumber: "INV-1", invoiceDate: "2026-09-20", lines: [{ id: "line", productId: "part", quantity: "1", quoteBasis: "piece", supplierUnitPriceMinor: 1000, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 2000 }] };
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
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get(), stockBefore);
  assert.equal(db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get(), movementBefore);
});

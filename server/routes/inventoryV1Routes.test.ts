import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { ProcurementService } from "../modules/procurement/procurementService.js";
import { createInventoryV1Router } from "./inventoryV1Routes.js";

let db: Database.Database;
let baseUrl = "";
let costSnapshotId = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  new CatalogService(db).createProduct({ id: "route-part", sku: "ROUTE-PART", title: "Route part", catalog_type: "product", base_uom_code: "piece" });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "route-supplier", name: "Route supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({
    id: "route-purchase", supplierId: "route-supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{ id: "route-line", productId: "route-part", quantity: "2", quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
  });
  costSnapshotId = procurement.finalizeAcquisitionCosts("route-purchase", { allocations: [] }).lots[0].id;
  const allow: express.RequestHandler = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: "owner", username: "Owner" } as typeof req.user; next(); });
  app.use("/api/inventory/v1", createInventoryV1Router({
    db, authorizeRead: allow, authorizeReceipt: allow, authorizeReserve: allow, authorizeRelease: allow,
    authorizeWarehouse: allow, authorizeDispatch: allow, authorizeCorrection: allow,
  }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}/api/inventory/v1`;
});

after(() => { server?.close(); db?.close(); });

const post = (path: string, operationId: string, body: unknown) => fetch(`${baseUrl}${path}`, {
  method: "POST", headers: { "content-type": "application/json", "x-operation-id": operationId }, body: JSON.stringify(body),
});

test("versioned inventory API replays commands and closes direct dispatch behind physical handoff", async () => {
  const receiptBody = { receiptId: "route-receipt", costSnapshotId, receivedAt: "2026-09-20T08:00:00.000Z", location: { id: "pick-route", kind: "PICKING" } };
  const missing = await fetch(`${baseUrl}/receipts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(receiptBody) });
  assert.equal(missing.status, 400);
  const firstReceipt = await (await post("/receipts", "route-receipt-op", receiptBody)).json() as any;
  const replayReceipt = await (await post("/receipts", "route-receipt-op", receiptBody)).json() as any;
  assert.equal(firstReceipt.idempotent, false);
  assert.equal(replayReceipt.idempotent, true);
  assert.deepEqual(replayReceipt.data, firstReceipt.data);

  db.prepare("INSERT INTO sales (id,order_code,total_amount,platform) VALUES ('route-order','ROUTE-ORDER',0,'Direct')").run();
  const reservationBody = { reservationId: "route-reservation", lines: [{ productId: "route-part", quantityBaseInt: 2 }] };
  assert.equal((await post("/orders/route-order/reservation", "route-reserve-op", reservationBody)).status, 201);
  assert.equal((await post("/reservations/route-reservation/pick", "route-pick-op", {})).status, 200);
  assert.equal((await post("/reservations/route-reservation/pack", "route-pack-op", {})).status, 200);
  const dispatchBody = { shipmentId: "route-shipment", dispatchedAt: "2026-09-20T12:00:00.000Z" };
  const firstDispatch = await post("/reservations/route-reservation/dispatch", "route-dispatch-op", dispatchBody);
  const replayDispatch = await post("/reservations/route-reservation/dispatch", "route-dispatch-op", dispatchBody);
  assert.equal(firstDispatch.status, 409);
  assert.equal((await firstDispatch.json() as any).error.code, "PHYSICAL_HANDOFF_REQUIRED");
  assert.equal(replayDispatch.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type LIKE 'inventory.%'").pluck().get(), 4);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type LIKE 'inventory.%'").pluck().get(), 3);
  const reconciliation = await (await fetch(`${baseUrl}/products/route-part/reconciliation`)).json() as any;
  assert.equal(reconciliation.data.reconciled, true);
  assert.equal(reconciliation.data.onHandBaseInt, 2);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { ProcurementService } from "../modules/procurement/procurementService.js";
import { createWarehouseRouter } from "./warehouseRoutes.js";

let db: Database.Database;
let baseUrl = "";
let costSnapshotId = "";
let server: ReturnType<express.Express["listen"]>;

before(async () => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  new CatalogService(db).createProduct({ id: "route-warehouse-part", sku: "ROUTE-WH", title: "Route warehouse part", catalog_type: "product", base_uom_code: "piece" });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "route-warehouse-supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({
    id: "route-warehouse-purchase", supplierId: "route-warehouse-supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{ id: "route-warehouse-line", productId: "route-warehouse-part", quantity: "2", quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
  });
  costSnapshotId = procurement.finalizeAcquisitionCosts("route-warehouse-purchase", { allocations: [] }).lots[0].id;
  db.prepare(`INSERT INTO panel_api_keys (id,name,key_prefix,key_hash,last4,permissions,status)
    VALUES ('warehouse-v2-service','Warehouse V2','test','warehouse-v2-key','-key',?,'active')`)
    .run(JSON.stringify(["read:products", "write:warehouse_status"]));
  const app = express();
  app.use(express.json());
  app.use("/api/warehouse/v1", createWarehouseRouter({
    db,
    hashApiKey: (value) => value,
    logActivity: () => {},
    uploadsDir: process.cwd(),
    authenticateUserToken: (token) => token === "warehouse-v2-user"
      ? { id: "warehouse-v2-user", username: "Owner", role: "admin", permissions: {}, must_change_password: false }
      : null,
  }));
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not start");
  baseUrl = `http://127.0.0.1:${address.port}/api/warehouse/v1`;
});

after(() => { server?.close(); db?.close(); });

const post = (path: string, body: Record<string, unknown>) => fetch(`${baseUrl}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "warehouse-v2-key", authorization: "Bearer warehouse-v2-user" },
  body: JSON.stringify(body),
});

test("V2-08 execution API audits and replays receive/identify/place while legacy stock writers fail closed", async () => {
  const topology = {
    id: "route-topology", name: "Route topology", codeTemplate: "{rack}-K{level}-P{position}-{depth}",
    racks: [{
      code: "A1", levelCount: 1, positionCount: 6, active: true, role: "MIXED",
      allowMixedSku: true, allowMixedLot: true, placementPriority: 100,
      depths: [{ code: "FRONT", isFront: true, priority: 0 }, { code: "REAR_1", isFront: false, priority: 1 }],
      levels: [{ number: 1, role: "MIXED", heavyPenalty: 0 }],
    }],
  };
  assert.equal((await post("/execution/topology", { topology, idempotency_key: "route-topology-op" })).status, 200);
  const receipt = {
    receiptId: "route-receipt", receiptSeriesId: "route-series", stageIndex: 1, isFinal: true,
    costSnapshotId, supplierLotCode: "ROUTE-LOT", acceptedQuantityBaseInt: 2, damagedQuantityBaseInt: 0,
    receivedAt: "2026-09-20T08:00:00.000Z",
    packages: [{ id: "route-package", code: "ROUTE-PACKAGE", quantityBaseInt: 2 }],
    idempotency_key: "route-receipt-op",
  };
  const firstReceipt = await (await post("/execution/receipts", receipt)).json() as any;
  const replayReceipt = await (await post("/execution/receipts", receipt)).json() as any;
  assert.equal(firstReceipt.idempotent, false);
  assert.equal(replayReceipt.idempotent, true);
  assert.deepEqual(replayReceipt.data, firstReceipt.data);

  assert.equal((await post("/execution/packages/route-package/identity", { labelIdentity: "ROUTE-LABEL", idempotency_key: "route-label-op" })).status, 200);
  const suggestionResponse = await fetch(`${baseUrl}/execution/packages/route-package/suggestion`, {
    headers: { "x-api-key": "warehouse-v2-key", authorization: "Bearer warehouse-v2-user" },
  });
  const suggestion = await suggestionResponse.json() as any;
  assert.equal(suggestionResponse.status, 200, JSON.stringify(suggestion));
  const placementBody = { destinationCode: suggestion.data.code, scannedDestinationCode: suggestion.data.code, idempotency_key: "route-place-op" };
  const firstPlacementResponse = await post("/execution/packages/route-package/place", placementBody);
  const firstPlacement = await firstPlacementResponse.json() as any;
  assert.equal(firstPlacementResponse.status, 200, JSON.stringify(firstPlacement));
  const replayPlacementResponse = await post("/execution/packages/route-package/place", placementBody);
  const replayPlacement = await replayPlacementResponse.json() as any;
  assert.equal(replayPlacementResponse.status, 200, JSON.stringify(replayPlacement));
  assert.equal(firstPlacement.data.onHandBaseInt, 2);
  assert.equal(replayPlacement.idempotent, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM warehouse_package_movements_v2").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type LIKE 'warehouse.%'").pluck().get(), 4);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE topic='warehouse'").pluck().get(), 4);

  const legacy = await post("/admin/moves", { package_code: "ROUTE-PACKAGE", location_code: "A1", idempotency_key: "legacy" });
  assert.equal(legacy.status, 410);
  assert.equal(((await legacy.json()) as any).error.code, "V2_WAREHOUSE_EXECUTION_REQUIRED");
});

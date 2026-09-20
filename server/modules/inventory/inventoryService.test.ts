import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { InventoryService, InventoryValidationError } from "./inventoryService.js";

const actor = { human: { id: "inventory-owner", name: "Inventory Owner" } };

const execute = (
  db: Database.Database,
  operationId: string,
  commandType: string,
  payload: Record<string, unknown>,
  handler: () => any,
) => new CommandExecutor(db).execute<any>({
  operationId,
  commandType,
  payload,
  actor,
  authorization: { decision: "ALLOW", capability: "inventory:write" },
}, () => ({ statusCode: 200, body: handler() })).result.body as any;

const setup = (database: string | Buffer = ":memory:") => {
  const db = new Database(database);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "part", sku: "PART", title: "Part", catalog_type: "product", base_uom_code: "piece" });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  return { db, procurement, inventory: new InventoryService(db) };
};

const costedLot = (procurement: ProcurementService, id: string, quantity: number) => {
  procurement.createPurchase({
    id: `purchase-${id}`,
    supplierId: "supplier",
    acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    invoiceNumber: `INV-${id}`,
    invoiceDate: "2026-09-20",
    lines: [{
      id: `line-${id}`,
      productId: "part",
      quantity: String(quantity),
      quoteBasis: "piece",
      supplierUnitPriceMinor: 100,
      currency: "TRY",
      vatMode: "EXCLUDED",
      vatRateBps: 0,
    }],
  });
  return procurement.finalizeAcquisitionCosts(`purchase-${id}`, { allocations: [] }).lots[0];
};

const receive = (
  db: Database.Database,
  inventory: InventoryService,
  costSnapshotId: string,
  id: string,
  receivedAt: string,
  locationKind: "PICKING" | "RESERVE" = "PICKING",
) => execute(db, `receive-${id}`, "inventory.receipt.approve.v1", { costSnapshotId, id, receivedAt, locationKind }, () =>
  inventory.receiveCostedLot({
    receiptId: `receipt-${id}`,
    costSnapshotId,
    receivedAt,
    location: { id: `${locationKind.toLowerCase()}-${id}`, kind: locationKind },
    operationId: `receive-${id}`,
  }));

test("approved receipt posts one immutable IN and preserves the V2-06 cost snapshot", () => {
  const { db, procurement, inventory } = setup();
  const planned = costedLot(procurement, "one", 10);
  const snapshotBefore = db.prepare("SELECT * FROM acquisition_lot_cost_snapshots WHERE id=?").get(planned.id);
  const first = receive(db, inventory, planned.id, "one", "2026-09-20T08:00:00.000Z");
  const replay = execute(db, "receive-one", "inventory.receipt.approve.v1", {
    costSnapshotId: planned.id, id: "one", receivedAt: "2026-09-20T08:00:00.000Z", locationKind: "PICKING",
  }, () => { throw new Error("replay must not execute"); });

  assert.deepEqual(replay, first);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 10, reservedBaseInt: 0, availableBaseInt: 10 });
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get(), 10);
  assert.throws(() => db.prepare("UPDATE products SET central_stock=999 WHERE id='part'").run(), /projection/i);
  assert.deepEqual(db.prepare("SELECT * FROM acquisition_lot_cost_snapshots WHERE id=?").get(planned.id), snapshotBefore);
  db.close();
});

test("purchase order and cost finalization alone create no physical inventory", () => {
  const { db, procurement, inventory } = setup();
  costedLot(procurement, "planned", 7);
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 0, reservedBaseInt: 0, availableBaseInt: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events").pluck().get(), 0);
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get(), 0);
  db.close();
});

test("central_stock rejects non-ledger insert and update writes", () => {
  const { db } = setup();
  assert.throws(() => db.prepare(`INSERT INTO products
    (id,sku,title,name,product_type,central_stock) VALUES ('forged','FORGED','Forged','Forged','simple',1)`).run(), /projection/i);
  assert.throws(() => db.prepare("UPDATE products SET central_stock=1 WHERE id='part'").run(), /projection/i);
  db.close();
});

test("reservation changes available but not on-hand, rejects shortage atomically, and cancellation releases", () => {
  const { db, procurement, inventory } = setup();
  const planned = costedLot(procurement, "reserve", 5);
  receive(db, inventory, planned.id, "reserve", "2026-09-20T08:00:00.000Z");
  const reserved = execute(db, "reserve-order-1", "inventory.order.reserve.v1", { orderId: "order-1", quantity: 4 }, () =>
    inventory.reserveOrder({ reservationId: "reservation-1", orderId: "order-1", lines: [{ productId: "part", quantityBaseInt: 4 }], operationId: "reserve-order-1" }));
  assert.equal(reserved.status, "ACTIVE");
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 5, reservedBaseInt: 4, availableBaseInt: 1 });
  assert.throws(() => execute(db, "reserve-order-2", "inventory.order.reserve.v1", { orderId: "order-2", quantity: 2 }, () =>
    inventory.reserveOrder({ reservationId: "reservation-2", orderId: "order-2", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "reserve-order-2" })),
  (error: unknown) => error instanceof InventoryValidationError && error.code === "INSUFFICIENT_AVAILABLE_STOCK");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations").pluck().get(), 1);
  execute(db, "release-order-1", "inventory.reservation.release.v1", { reservationId: "reservation-1" }, () =>
    inventory.releaseReservation({ reservationId: "reservation-1", reason: "ORDER_CANCELLED", operationId: "release-order-1" }));
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 5, reservedBaseInt: 0, availableBaseInt: 5 });
  db.close();
});

test("FIFO allocates the older received lot first and splits only after it is exhausted", () => {
  const { db, procurement, inventory } = setup();
  const older = costedLot(procurement, "older", 3);
  const newer = costedLot(procurement, "newer", 5);
  const olderReceipt = receive(db, inventory, older.id, "older", "2026-09-20T08:00:00.000Z");
  const newerReceipt = receive(db, inventory, newer.id, "newer", "2026-09-20T09:00:00.000Z");
  const first = inventory.reserveOrder({ reservationId: "fifo-1", orderId: "order-fifo-1", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "fifo-1" });
  assert.deepEqual(first.allocations.map((row) => [row.lotId, row.quantityBaseInt]), [[olderReceipt.lot.id, 2]]);
  const split = inventory.reserveOrder({ reservationId: "fifo-2", orderId: "order-fifo-2", lines: [{ productId: "part", quantityBaseInt: 3 }], operationId: "fifo-2" });
  assert.deepEqual(split.allocations.map((row) => [row.lotId, row.quantityBaseInt]), [[olderReceipt.lot.id, 1], [newerReceipt.lot.id, 2]]);
  db.close();
});

test("pick and pack keep physical on-hand; approved dispatch consumes the reservation once", () => {
  const { db, procurement, inventory } = setup();
  const planned = costedLot(procurement, "dispatch", 4);
  receive(db, inventory, planned.id, "dispatch", "2026-09-20T08:00:00.000Z");
  inventory.reserveOrder({ reservationId: "dispatch-res", orderId: "dispatch-order", lines: [{ productId: "part", quantityBaseInt: 3 }], operationId: "reserve-dispatch" });
  inventory.markPicked({ reservationId: "dispatch-res", operationId: "pick-dispatch" });
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 4);
  inventory.markPacked({ reservationId: "dispatch-res", operationId: "pack-dispatch" });
  assert.equal(inventory.getProductAvailability("part").onHandBaseInt, 4);
  const first = execute(db, "dispatch-once", "inventory.reservation.dispatch.v1", { reservationId: "dispatch-res", shipmentId: "shipment-1" }, () =>
    inventory.dispatchReservation({ reservationId: "dispatch-res", shipmentId: "shipment-1", dispatchedAt: "2026-09-20T12:00:00.000Z", operationId: "dispatch-once" }));
  const replay = execute(db, "dispatch-once", "inventory.reservation.dispatch.v1", { reservationId: "dispatch-res", shipmentId: "shipment-1" }, () => { throw new Error("replay must not execute"); });
  assert.deepEqual(replay, first);
  assert.deepEqual(inventory.getProductAvailability("part"), { productId: "part", baseUomCode: "piece", onHandBaseInt: 1, reservedBaseInt: 0, availableBaseInt: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='part'").pluck().get(), 1);
  assert.deepEqual(inventory.getProductReconciliation("part"), {
    productId: "part", baseUomCode: "piece", onHandBaseInt: 1, reservedBaseInt: 0,
    availableBaseInt: 1, ledgerOnHandBaseInt: 1, locationOnHandBaseInt: 1, centralStockProjectionBaseInt: 1, reconciled: true,
  });
  db.close();
});

test("approved correction is explicit, reconciled, and cannot reduce below reserved stock", () => {
  const { db, procurement, inventory } = setup();
  const planned = costedLot(procurement, "correction", 3);
  const receipt = receive(db, inventory, planned.id, "correction", "2026-09-20T08:00:00.000Z");
  inventory.reserveOrder({ reservationId: "correction-res", orderId: "correction-order", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "reserve-correction" });
  assert.throws(() => inventory.correctLot({
    lotId: receipt.lot.id, locationId: "picking-correction", expectedOnHandBaseInt: 3,
    observedOnHandBaseInt: 1, reason: "COUNT", approvalReference: "approval-1", operationId: "correction-blocked",
  }), (error: unknown) => error instanceof InventoryValidationError && error.code === "CORRECTION_BELOW_RESERVED");
  inventory.releaseReservation({ reservationId: "correction-res", reason: "ORDER_CANCELLED", operationId: "release-correction" });
  inventory.correctLot({
    lotId: receipt.lot.id, locationId: "picking-correction", expectedOnHandBaseInt: 3,
    observedOnHandBaseInt: 2, reason: "APPROVED_COUNT_DIFFERENCE", approvalReference: "approval-2", operationId: "correction-approved",
  });
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='CORRECTION'").pluck().get(), 1);
  assert.equal(inventory.getProductReconciliation("part").reconciled, true);
  db.close();
});

test("same-lot reserve stock requires replenishment and a physical miss blocks newer-lot fallback", () => {
  const { db, procurement, inventory } = setup();
  const older = costedLot(procurement, "reserve-location", 3);
  const newer = costedLot(procurement, "newer-location", 3);
  const olderReceipt = receive(db, inventory, older.id, "reserve-location", "2026-09-20T08:00:00.000Z", "RESERVE");
  receive(db, inventory, newer.id, "newer-location", "2026-09-20T09:00:00.000Z", "PICKING");
  const reservation = inventory.reserveOrder({ reservationId: "same-lot", orderId: "same-lot-order", lines: [{ productId: "part", quantityBaseInt: 2 }], operationId: "reserve-same-lot" });
  assert.equal(reservation.allocations[0].lotId, olderReceipt.lot.id);
  assert.deepEqual(inventory.getFulfillmentState("same-lot").requirements, [{
    lotId: olderReceipt.lot.id,
    productId: "part",
    quantityBaseInt: 2,
    state: "REPLENISH_SAME_LOT",
    pickingQuantityBaseInt: 0,
    reserveQuantityBaseInt: 3,
    replenishmentQuantityBaseInt: 2,
  }]);
  assert.throws(() => inventory.markPicked({ reservationId: "same-lot", operationId: "pick-before-replenishment" }),
    (error: unknown) => error instanceof InventoryValidationError && error.code === "SAME_LOT_REPLENISHMENT_REQUIRED");
  inventory.reportStockDiscrepancy({ reservationId: "same-lot", lotId: olderReceipt.lot.id, locationId: "reserve-reserve-location", reason: "COUNT_REQUIRED", operationId: "discrepancy" });
  assert.equal(inventory.getFulfillmentState("same-lot").status, "STOCK_DISCREPANCY");
  assert.throws(() => inventory.reserveOrder({ reservationId: "no-fallback", orderId: "no-fallback-order", lines: [{ productId: "part", quantityBaseInt: 1 }], operationId: "no-fallback" }),
    (error: unknown) => error instanceof InventoryValidationError && error.code === "STOCK_DISCREPANCY");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservation_allocations WHERE reservation_id='no-fallback'").pluck().get(), 0);
  inventory.correctLot({
    lotId: olderReceipt.lot.id, locationId: "reserve-reserve-location", expectedOnHandBaseInt: 3,
    observedOnHandBaseInt: 2, reason: "APPROVED_COUNT", approvalReference: "count-approval",
    operationId: "correct-discrepancy",
  });
  assert.equal(inventory.getReservation("same-lot").status, "ACTIVE");
  assert.equal(inventory.getFulfillmentState("same-lot").requirements[0].state, "REPLENISH_SAME_LOT");
  db.close();
});

test("concurrent last-unit reservations cannot oversell", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-inventory-concurrency-"));
  const databasePath = path.join(directory, "panel.sqlite");
  const { db, procurement, inventory } = setup(databasePath);
  const planned = costedLot(procurement, "last-unit", 1);
  receive(db, inventory, planned.id, "last-unit", "2026-09-20T08:00:00.000Z");
  db.close();
  const workerPath = new URL("./inventoryService.concurrent.worker.ts", import.meta.url).pathname;
  const runWorker = (suffix: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, databasePath, suffix], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout.trim())) : reject(new Error(stderr)));
  });
  try {
    const results = await Promise.all([runWorker("a"), runWorker("b")]);
    assert.deepEqual(results.map((result) => result.code || "RESERVED").sort(), ["INSUFFICIENT_AVAILABLE_STOCK", "RESERVED"]);
    const verified = new Database(databasePath, { readonly: true });
    assert.deepEqual(verified.prepare("SELECT on_hand_base_int, reserved_base_int FROM inventory_lots").get(), { on_hand_base_int: 1, reserved_base_int: 1 });
    verified.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

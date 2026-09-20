import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { WarehouseExecutionError, WarehouseExecutionService, type WarehouseTopologyInput } from "./warehouseExecutionService.js";

const actor = { human: { id: "warehouse-owner", name: "Warehouse Owner" } };

const execute = <T>(db: Database.Database, operationId: string, commandType: string, payload: unknown, handler: () => T) =>
  new CommandExecutor(db).execute<any>({
    operationId,
    commandType,
    payload,
    actor,
    authorization: { decision: "ALLOW", capability: "warehouse:write" },
  }, () => ({ statusCode: 200, body: handler() as any })).result.body as T;

const rack = (code: string, levelCount = 4, positionCount = 6, lastResort = false): WarehouseTopologyInput["racks"][number] => ({
  code,
  levelCount,
  positionCount,
  active: true,
  role: "MIXED" as const,
  allowMixedSku: true,
  allowMixedLot: true,
  placementPriority: lastResort ? 900 : 100,
  lastResort,
  depths: [
    { code: "FRONT", isFront: true, priority: 0 },
    { code: "REAR_1", isFront: false, priority: 1 },
    { code: "REAR_2", isFront: false, priority: 2 },
  ],
  levels: Array.from({ length: levelCount }, (_, index) => ({
    number: index + 1,
    role: index + 1 === 4 ? "RESERVE" as const : "MIXED" as const,
    heavyPenalty: index + 1 === 4 ? 500 : 0,
  })),
});

const topology = (racks: WarehouseTopologyInput["racks"] = [rack("A1"), rack("C2", 4, 6, true)]): WarehouseTopologyInput => ({
  id: `topology-${racks.map((item) => item.code).join("-")}`,
  name: "Test warehouse",
  codeTemplate: "{rack}-K{level}-P{position}-{depth}",
  racks,
});

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  for (const [id, sku] of [["p1", "SKU-1"], ["p2", "SKU-2"], ["p3", "SKU-3"]] as const) {
    catalog.createProduct({ id, sku, title: sku, catalog_type: "product", base_uom_code: "piece" });
  }
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  return { db, procurement, warehouse: new WarehouseExecutionService(db) };
};

const costed = (procurement: ProcurementService, productId: string, id: string, quantity: number) => {
  procurement.createPurchase({
    id: `purchase-${id}`,
    supplierId: "supplier",
    acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    invoiceNumber: `INV-${id}`,
    invoiceDate: "2026-09-20",
    lines: [{
      id: `line-${id}`,
      productId,
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
  warehouse: WarehouseExecutionService,
  costSnapshotId: string,
  id: string,
  packages: Array<{ id: string; code: string; quantityBaseInt: number; weightGrams?: number; disposition?: "ACCEPTED" | "DAMAGED"; targetQuantityBaseInt?: number }>,
  acceptedQuantityBaseInt: number,
  damagedQuantityBaseInt = 0,
  extra: Record<string, unknown> = {},
) => execute(db, `receive-${id}`, "warehouse.goods-receipt.accept.v1", { id, packages, acceptedQuantityBaseInt, damagedQuantityBaseInt, ...extra }, () =>
  warehouse.receiveGoods({
    receiptId: `receipt-${id}`,
    receiptSeriesId: `series-${id}`,
    stageIndex: 1,
    isFinal: true,
    costSnapshotId,
    supplierLotCode: `SUPPLIER-LOT-${id}`,
    acceptedQuantityBaseInt,
    damagedQuantityBaseInt,
    receivedAt: "2026-09-20T08:00:00.000Z",
    packages,
    operationId: `receive-${id}`,
    ...extra,
  } as any));

test("topology is DB/config driven for the current 14x4x6x3 shape and future racks retain six positions", () => {
  const { db, warehouse } = setup();
  warehouse.configureTopology(topology(Array.from({ length: 14 }, (_, index) => rack(`R${String(index + 1).padStart(2, "0")}`))));
  assert.equal(warehouse.getTopology().summary.slotCount, 14 * 4 * 6 * 3);
  assert.equal(warehouse.getTopology().racks.length, 14);

  warehouse.configureTopology(topology([{
    ...rack("CUSTOM", 1, 6),
    depths: [{ code: "FRONT", isFront: true, priority: 0 }],
    levels: [{ number: 1, role: "PICKING", heavyPenalty: 0 }],
  }]));
  const custom = warehouse.getTopology();
  assert.equal(custom.summary.slotCount, 6);
  assert.equal(custom.racks[0].positionCount, 6);
  assert.deepEqual(db.prepare("SELECT level_number,role FROM warehouse_level_configs WHERE topology_id=? ORDER BY level_number").all(custom.id), [
    { level_number: 1, role: "PICKING" },
  ]);
  assert.throws(() => warehouse.configureTopology(topology([rack("INVALID", 1, 10)])),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "INVALID_POSITION_COUNT");
  db.close();
});

test("per-position mixed-SKU and mixed-lot policy filters placement candidates", () => {
  const { db, procurement, warehouse } = setup();
  warehouse.configureTopology(topology([{
    ...rack("M1", 1, 6),
    levels: [{ number: 1, role: "MIXED", heavyPenalty: 0 }],
    positions: [
      { level: 1, position: 1, allowMixedSku: false, allowMixedLot: false },
      { level: 1, position: 2, allowMixedSku: true, allowMixedLot: true },
    ],
  }]));
  const firstLot = costed(procurement, "p1", "mixed-owner", 2);
  receive(db, warehouse, firstLot.id, "mixed-owner", [
    { id: "owner-front", code: "OWNER-FRONT", quantityBaseInt: 1 },
    { id: "owner-rear", code: "OWNER-REAR", quantityBaseInt: 1 },
  ], 2);
  for (const id of ["owner-front", "owner-rear"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  warehouse.placePackage({ packageId: "owner-front", destinationCode: "M1-K1-P1-FRONT", scannedDestinationCode: "M1-K1-P1-FRONT", operationId: "owner-front-place" });

  const secondLot = costed(procurement, "p2", "mixed-guest", 2);
  receive(db, warehouse, secondLot.id, "mixed-guest", [
    { id: "guest-front", code: "GUEST-FRONT", quantityBaseInt: 1 },
    { id: "guest-rear", code: "GUEST-REAR", quantityBaseInt: 1 },
  ], 2);
  for (const id of ["guest-front", "guest-rear"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  warehouse.placePackage({ packageId: "guest-front", destinationCode: "M1-K1-P2-FRONT", scannedDestinationCode: "M1-K1-P2-FRONT", operationId: "guest-front-place" });
  const candidates = warehouse.listAvailableLocations("guest-rear");
  assert.equal(candidates.some((slot) => slot.positionNumber === 1), false);
  assert.equal(candidates.some((slot) => slot.positionNumber === 2 && !slot.isFront), true);
  db.close();
});

test("placement enforces pick faces, uses rear depth, prefers same-SKU rear pairs, honors mixed policy, weight and C2 priority", () => {
  const { db, procurement, warehouse } = setup();
  const configured = topology([
    {
      ...rack("A1"),
      positions: [
        { level: 1, position: 1, allowMixedSku: true, allowMixedLot: true },
        { level: 1, position: 2, allowMixedSku: false, allowMixedLot: false },
      ],
    },
    rack("C2", 4, 6, true),
  ]);
  warehouse.configureTopology(configured);
  warehouse.configureSettings({ watchThresholdPct: 20, prepareThresholdPct: 10, heavyPackageThresholdGrams: 20_000 });
  const lot = costed(procurement, "p1", "placement", 3);
  receive(db, warehouse, lot.id, "placement", [
    { id: "pkg-1", code: "PKG-1", quantityBaseInt: 1, weightGrams: 1_000 },
    { id: "pkg-2", code: "PKG-2", quantityBaseInt: 1, weightGrams: 30_000 },
    { id: "pkg-3", code: "PKG-3", quantityBaseInt: 1, weightGrams: 1_000 },
  ], 3);
  for (const id of ["pkg-1", "pkg-2", "pkg-3"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });

  const first = warehouse.suggestLocation("pkg-1");
  assert.equal(first.isFront, true, "a missing mandatory pick face must win");
  assert.notEqual(first.rackCode, "C2", "C2 is config-defined last resort");
  warehouse.placePackage({ packageId: "pkg-1", destinationCode: first.code, scannedDestinationCode: first.code, operationId: "place-1" });

  const second = warehouse.suggestLocation("pkg-2");
  assert.equal(second.levelNumber <= 3, true, "a heavy package avoids configured level 4 while another slot exists");
  assert.equal(second.isFront, false, "reserve cartons use rear depth after the pick face exists");
  warehouse.placePackage({ packageId: "pkg-2", destinationCode: second.code, scannedDestinationCode: second.code, operationId: "place-2" });
  const third = warehouse.suggestLocation("pkg-3");
  assert.equal(third.rackCode, second.rackCode);
  assert.equal(third.levelNumber, second.levelNumber);
  assert.equal(third.positionNumber, second.positionNumber);
  assert.notEqual(third.depthCode, second.depthCode, "REAR_1 + REAR_2 should prefer the same SKU");

  const oneCarton = costed(procurement, "p2", "one-carton", 1);
  receive(db, warehouse, oneCarton.id, "one-carton", [{ id: "one", code: "ONE", quantityBaseInt: 1 }], 1);
  warehouse.identifyPackage({ packageId: "one", labelIdentity: "LABEL-ONE" });
  const oneSuggestion = warehouse.suggestLocation("one");
  assert.equal(oneSuggestion.isFront, true);
  assert.equal(warehouse.getPositionOccupancy(oneSuggestion.rackCode, oneSuggestion.levelNumber, oneSuggestion.positionNumber).some((slot) => slot.depthCode.startsWith("REAR") && slot.packageId === null), true,
    "a one-carton SKU must not reserve or block rear slots");
  db.close();
});

test("goods receipt preserves V2-06 facts, records shortage, gates excess, quarantines damage, and rejects partial stages", () => {
  const { db, procurement, warehouse } = setup();
  const shortageLot = costed(procurement, "p1", "shortage", 10);
  const costBefore = db.prepare("SELECT * FROM acquisition_lot_cost_snapshots WHERE id=?").get(shortageLot.id);
  const shortage = receive(db, warehouse, shortageLot.id, "shortage", [{ id: "short", code: "SHORT", quantityBaseInt: 8 }], 8);
  assert.equal(shortage.expectedQuantityBaseInt, 10);
  assert.equal(shortage.varianceQuantityBaseInt, -2);
  assert.equal(shortage.shortageQuantityBaseInt, 2);
  assert.deepEqual(db.prepare("SELECT * FROM acquisition_lot_cost_snapshots WHERE id=?").get(shortageLot.id), costBefore);

  const excessLot = costed(procurement, "p2", "excess", 10);
  assert.throws(() => receive(db, warehouse, excessLot.id, "excess-no-approval", [{ id: "excess", code: "EXCESS", quantityBaseInt: 11 }], 11),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "EXCESS_APPROVAL_REQUIRED");
  const approval = execute(db, "approve-excess", "warehouse.goods-receipt.excess-approve.v1", { costSnapshotId: excessLot.id, approved: 1 }, () =>
    warehouse.approveExcess({ approvalId: "approval-excess", costSnapshotId: excessLot.id, maximumAcceptedQuantityBaseInt: 11, reason: "Supplier over-delivery", operationId: "approve-excess" }));
  const excess = receive(db, warehouse, excessLot.id, "excess", [{ id: "excess", code: "EXCESS", quantityBaseInt: 11 }], 11, 0, { excessApprovalId: approval.id });
  assert.equal(excess.excessQuantityBaseInt, 1);

  const damagedLot = costed(procurement, "p3", "damaged", 10);
  const damaged = receive(db, warehouse, damagedLot.id, "damaged", [
    { id: "ok", code: "OK", quantityBaseInt: 8 },
    { id: "damaged", code: "DAMAGED", quantityBaseInt: 2, disposition: "DAMAGED" },
  ], 8, 2);
  assert.equal(damaged.deliveredQuantityBaseInt, 10);
  assert.equal(damaged.varianceQuantityBaseInt, 0);
  assert.equal(damaged.shortageQuantityBaseInt, 0);
  assert.equal(damaged.excessQuantityBaseInt, 0);
  assert.equal(damaged.damagedQuantityBaseInt, 2);
  assert.equal(warehouse.getPackage("damaged").status, "QUARANTINE");
  assert.equal(warehouse.getAvailability("p3").availableBaseInt, 8);

  const deliveredExcessLot = costed(procurement, "p3", "delivered-excess", 10);
  const deliveredApproval = execute(db, "approve-delivered-excess", "warehouse.goods-receipt.excess-approve.v1", { costSnapshotId: deliveredExcessLot.id }, () =>
    warehouse.approveExcess({ approvalId: "approval-delivered-excess", costSnapshotId: deliveredExcessLot.id, maximumAcceptedQuantityBaseInt: 11, reason: "Only eleven delivered units approved", operationId: "approve-delivered-excess" }));
  assert.throws(() => receive(db, warehouse, deliveredExcessLot.id, "delivered-excess", [
    { id: "delivered-ok", code: "DELIVERED-OK", quantityBaseInt: 9 },
    { id: "delivered-damaged", code: "DELIVERED-DAMAGED", quantityBaseInt: 3, disposition: "DAMAGED" },
  ], 9, 3, { excessApprovalId: deliveredApproval.id }),
  (error: unknown) => error instanceof WarehouseExecutionError && error.code === "EXCESS_APPROVAL_REQUIRED");

  const partialLot = costed(procurement, "p3", "partial", 5);
  assert.throws(() => receive(db, warehouse, partialLot.id, "partial", [{ id: "partial", code: "PARTIAL", quantityBaseInt: 2 }], 2, 0, { isFinal: false }),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "PARTIAL_RECEIPT_DISABLED");
  assert.ok(db.prepare("PRAGMA table_info(warehouse_goods_receipts)").all().some((column: any) => column.name === "stage_index"));
  db.close();
});

test("configurable watch/prepare thresholds require same-lot replenishment and discrepancy blocks newer-lot fallback", () => {
  const { db, procurement, warehouse } = setup();
  warehouse.configureTopology(topology([rack("A1")]));
  assert.deepEqual(warehouse.getSettings(), { watchThresholdPct: 20, prepareThresholdPct: 10, heavyPackageThresholdGrams: 20_000 });
  db.prepare("DELETE FROM warehouse_execution_settings WHERE id='default'").run();
  assert.throws(() => warehouse.getSettings(),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "WAREHOUSE_SETTINGS_NOT_CONFIGURED");
  warehouse.configureSettings({ watchThresholdPct: 20, prepareThresholdPct: 10, heavyPackageThresholdGrams: 20_000 });
  assert.throws(() => warehouse.configureSettings({ watchThresholdPct: 10, prepareThresholdPct: 20, heavyPackageThresholdGrams: 20_000 }),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "INVALID_REPLENISHMENT_THRESHOLDS");

  const watchLot = costed(procurement, "p2", "watch", 100);
  receive(db, warehouse, watchLot.id, "watch", [
    { id: "pick-watch", code: "PICK-WATCH", quantityBaseInt: 20, targetQuantityBaseInt: 100 },
    { id: "reserve-watch", code: "RESERVE-WATCH", quantityBaseInt: 80 },
  ], 100);
  for (const id of ["pick-watch", "reserve-watch"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  const watchPickSlot = warehouse.suggestLocation("pick-watch");
  warehouse.placePackage({ packageId: "pick-watch", destinationCode: watchPickSlot.code, scannedDestinationCode: watchPickSlot.code, operationId: "place-pick-watch" });
  const watchReserveSlot = warehouse.suggestLocation("reserve-watch");
  warehouse.placePackage({ packageId: "reserve-watch", destinationCode: watchReserveSlot.code, scannedDestinationCode: watchReserveSlot.code, operationId: "place-reserve-watch" });
  assert.equal(warehouse.prepareReplenishment({ productId: "p2", operationId: "watch-20" }).state, "LOW_WATCH");

  const older = costed(procurement, "p1", "fifo-old", 100);
  const olderReceipt = receive(db, warehouse, older.id, "fifo-old", [
    { id: "pick-old", code: "PICK-OLD", quantityBaseInt: 10, targetQuantityBaseInt: 100 },
    { id: "reserve-old", code: "RESERVE-OLD", quantityBaseInt: 90 },
  ], 100);
  for (const id of ["pick-old", "reserve-old"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  const pickSlot = warehouse.suggestLocation("pick-old");
  warehouse.placePackage({ packageId: "pick-old", destinationCode: pickSlot.code, scannedDestinationCode: pickSlot.code, operationId: "place-pick-old" });
  const reserveSlot = warehouse.suggestLocation("reserve-old");
  warehouse.placePackage({ packageId: "reserve-old", destinationCode: reserveSlot.code, scannedDestinationCode: reserveSlot.code, operationId: "place-reserve-old" });
  const prepared = execute(db, "prepare-old", "warehouse.replenishment.prepare.v1", { productId: "p1" }, () => warehouse.prepareReplenishment({ productId: "p1", operationId: "prepare-old" }));
  assert.equal(prepared.state, "PREPARE_REPLENISHMENT");
  assert.equal(prepared.sourcePackageId, "reserve-old");
  assert.equal(prepared.lotId, olderReceipt.inventoryLotId);

  db.prepare("UPDATE warehouse_execution_packages SET status='DISCREPANCY' WHERE id='reserve-old'").run();
  const newer = costed(procurement, "p1", "fifo-new", 50);
  receive(db, warehouse, newer.id, "fifo-new", [{ id: "reserve-new", code: "RESERVE-NEW", quantityBaseInt: 50 }], 50, 0,
    { receivedAt: "2026-09-20T09:00:00.000Z" });
  warehouse.identifyPackage({ packageId: "reserve-new", labelIdentity: "LABEL-NEW" });
  const discrepancy = execute(db, "prepare-missing", "warehouse.replenishment.prepare.v1", { productId: "p1", retry: true }, () => warehouse.prepareReplenishment({ productId: "p1", operationId: "prepare-missing" }));
  assert.equal(discrepancy.state, "STOCK_DISCREPANCY");
  assert.equal(discrepancy.lotId, olderReceipt.inventoryLotId);
  assert.notEqual(discrepancy.sourcePackageId, "reserve-new");
  db.close();
});

test("topology policy edits and rack additions preserve slot identity while occupied geometry cannot be removed", () => {
  const { db, procurement, warehouse } = setup();
  const initial = topology([rack("A1"), rack("C2", 4, 6, true)]);
  warehouse.configureTopology(initial);
  const planned = costed(procurement, "p1", "topology-edit", 1);
  receive(db, warehouse, planned.id, "topology-edit", [{ id: "stable-package", code: "STABLE-PACKAGE", quantityBaseInt: 1 }], 1);
  warehouse.identifyPackage({ packageId: "stable-package", labelIdentity: "STABLE-LABEL" });
  warehouse.placePackage({
    packageId: "stable-package",
    destinationCode: "C2-K1-P1-FRONT",
    scannedDestinationCode: "C2-K1-P1-FRONT",
    operationId: "stable-place",
  });
  const stableSlotId = warehouse.getPackage("stable-package").currentSlotId;

  const edited: WarehouseTopologyInput = {
    ...topology([rack("A1"), { ...rack("C2"), placementPriority: 25, lastResort: false }, rack("D1", 2, 6)]),
    id: "topology-policy-edit-add-rack",
  };
  const configured = warehouse.configureTopology(edited);
  assert.equal(configured.racks.length, 3);
  assert.equal(warehouse.getPackage("stable-package").currentSlotId, stableSlotId);
  assert.equal(db.prepare("SELECT last_resort FROM warehouse_location_slots WHERE id=?").pluck().get(stableSlotId), 0);

  assert.throws(() => warehouse.configureTopology({ ...topology([rack("A1"), rack("D1", 2, 6)]), id: "topology-destructive" }),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "TOPOLOGY_GEOMETRY_OCCUPIED");
  assert.equal(warehouse.getTopology().id, edited.id);
  assert.equal(warehouse.getPackage("stable-package").currentSlotId, stableSlotId);
  db.close();
});

test("dispatch consumes the matching picking package and leaves lot, ledger, location, package, and central projection reconciled", () => {
  const { db, procurement, warehouse } = setup();
  warehouse.configureTopology(topology([rack("A1")]));
  const planned = costed(procurement, "p1", "dispatch-reconcile", 100);
  receive(db, warehouse, planned.id, "dispatch-reconcile", [
    { id: "dispatch-pick", code: "DISPATCH-PICK", quantityBaseInt: 20, targetQuantityBaseInt: 100 },
    { id: "dispatch-reserve", code: "DISPATCH-RESERVE", quantityBaseInt: 80 },
  ], 100);
  for (const id of ["dispatch-pick", "dispatch-reserve"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  const pick = warehouse.suggestLocation("dispatch-pick");
  warehouse.placePackage({ packageId: "dispatch-pick", destinationCode: pick.code, scannedDestinationCode: pick.code, operationId: "dispatch-pick-place" });
  const reserve = warehouse.suggestLocation("dispatch-reserve");
  warehouse.placePackage({ packageId: "dispatch-reserve", destinationCode: reserve.code, scannedDestinationCode: reserve.code, operationId: "dispatch-reserve-place" });

  const inventory = new InventoryService(db);
  inventory.reserveOrder({ reservationId: "dispatch-reservation", orderId: "dispatch-order", lines: [{ productId: "p1", quantityBaseInt: 10 }], operationId: "dispatch-reserve-op" });
  inventory.markPicked({ reservationId: "dispatch-reservation", operationId: "dispatch-pick-op" });
  inventory.markPacked({ reservationId: "dispatch-reservation", operationId: "dispatch-pack-op" });
  execute(db, "dispatch-op", "inventory.reservation.dispatch.v1", { reservationId: "dispatch-reservation" }, () =>
    inventory.dispatchReservation({ reservationId: "dispatch-reservation", shipmentId: "dispatch-shipment", dispatchedAt: "2026-09-20T12:00:00.000Z", operationId: "dispatch-op" }));

  assert.equal(warehouse.getPackage("dispatch-pick").remainingQuantityBaseInt, 10);
  assert.deepEqual(warehouse.getReconciliation("p1"), {
    productId: "p1",
    lotOnHandBaseInt: 90,
    ledgerOnHandBaseInt: 90,
    locationOnHandBaseInt: 90,
    packageOnHandBaseInt: 90,
    centralStockProjectionBaseInt: 90,
    reconciled: true,
  });
  const replenishment = warehouse.prepareReplenishment({ productId: "p1", operationId: "dispatch-replenishment" });
  assert.equal(replenishment.state, "PREPARE_REPLENISHMENT");
  assert.equal(replenishment.currentPct, 10);
  assert.equal(replenishment.sourcePackageId, "dispatch-reserve");
  db.close();
});

test("placement and moves are idempotent, preserve on-hand, and reconcile package/location/lot/ledger", () => {
  const { db, procurement, warehouse } = setup();
  warehouse.configureTopology(topology([rack("A1")]));
  const planned = costed(procurement, "p1", "move", 10);
  receive(db, warehouse, planned.id, "move", [
    { id: "move-a", code: "MOVE-A", quantityBaseInt: 5 },
    { id: "move-b", code: "MOVE-B", quantityBaseInt: 5 },
  ], 10);
  for (const id of ["move-a", "move-b"]) warehouse.identifyPackage({ packageId: id, labelIdentity: `LABEL-${id}` });
  const destination = warehouse.suggestLocation("move-a");
  const placed = execute(db, "place-once", "warehouse.package.place.v1", { packageId: "move-a", destination: destination.code }, () =>
    warehouse.placePackage({ packageId: "move-a", destinationCode: destination.code, scannedDestinationCode: destination.code, operationId: "place-once" }));
  const replay = execute(db, "place-once", "warehouse.package.place.v1", { packageId: "move-a", destination: destination.code }, () => { throw new Error("placement replay executed"); });
  assert.deepEqual(replay, placed);
  const before = warehouse.getAvailability("p1").onHandBaseInt;

  const secondDestination = warehouse.suggestLocation("move-b");
  warehouse.placePackage({ packageId: "move-b", destinationCode: secondDestination.code, scannedDestinationCode: secondDestination.code, operationId: "place-b" });
  const moveTarget = warehouse.listAvailableLocations("move-b").find((slot) => slot.code !== secondDestination.code && !slot.isFront)!;
  const moved = execute(db, "move-once", "warehouse.package.move.v1", { packageId: "move-b", destination: moveTarget.code }, () =>
    warehouse.movePackage({ packageId: "move-b", destinationCode: moveTarget.code, scannedDestinationCode: moveTarget.code, operationId: "move-once" }));
  const moveReplay = execute(db, "move-once", "warehouse.package.move.v1", { packageId: "move-b", destination: moveTarget.code }, () => { throw new Error("move replay executed"); });
  assert.deepEqual(moveReplay, moved);
  assert.equal(warehouse.getAvailability("p1").onHandBaseInt, before);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE product_id='p1'").pluck().get(), 1, "place/move must not post physical inventory");
  assert.deepEqual(warehouse.getReconciliation("p1"), {
    productId: "p1",
    lotOnHandBaseInt: 10,
    ledgerOnHandBaseInt: 10,
    locationOnHandBaseInt: 10,
    packageOnHandBaseInt: 10,
    centralStockProjectionBaseInt: 10,
    reconciled: true,
  });
  db.close();
});

test("count corrections require approval, reconcile every balance, and cannot create negative inventory", () => {
  const { db, procurement, warehouse } = setup();
  warehouse.configureTopology(topology([rack("A1")]));
  const planned = costed(procurement, "p1", "count", 5);
  receive(db, warehouse, planned.id, "count", [{ id: "count-package", code: "COUNT-PACKAGE", quantityBaseInt: 5 }], 5);
  warehouse.identifyPackage({ packageId: "count-package", labelIdentity: "LABEL-COUNT" });
  const destination = warehouse.suggestLocation("count-package");
  warehouse.placePackage({ packageId: "count-package", destinationCode: destination.code, scannedDestinationCode: destination.code, operationId: "count-place" });

  const count = execute(db, "count-observe", "warehouse.stock-count.record.v1", { observed: 3 }, () =>
    warehouse.recordCount({ countId: "count-1", packageId: "count-package", observedQuantityBaseInt: 3, reason: "Physical recount", operationId: "count-observe" }));
  assert.equal(count.status, "PENDING_APPROVAL");
  assert.equal(warehouse.getAvailability("p1").onHandBaseInt, 5, "an unapproved count is not an inventory mutation");
  execute(db, "count-approve", "warehouse.stock-count.approve.v1", { countId: count.id }, () =>
    warehouse.approveCount({ countId: count.id, approvalReference: "OWNER-APPROVAL-1", operationId: "count-approve" }));
  assert.equal(warehouse.getAvailability("p1").onHandBaseInt, 3);
  assert.equal(warehouse.getReconciliation("p1").reconciled, true);

  const impossible = execute(db, "count-impossible", "warehouse.stock-count.record.v1", { observed: 0 }, () =>
    warehouse.recordCount({ countId: "count-2", packageId: "count-package", observedQuantityBaseInt: 0, reason: "Reserved units protect underflow", operationId: "count-impossible" }));
  db.prepare("UPDATE inventory_lots SET reserved_base_int=1 WHERE product_id='p1'").run();
  assert.throws(() => warehouse.approveCount({ countId: impossible.id, approvalReference: "OWNER-APPROVAL-2", operationId: "count-approve-impossible" }),
    (error: unknown) => error instanceof WarehouseExecutionError && error.code === "COUNT_WOULD_CREATE_NEGATIVE_INVENTORY");
  assert.equal(warehouse.getAvailability("p1").onHandBaseInt, 3);
  db.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { InventoryService, InventoryValidationError } from "./inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { PublishedKitService, authoredKitContentHash, type KitPublicationProposal } from "../kits/publishedKitService.js";
import { ProfileCutInventoryService } from "./profileCutInventoryService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { ReturnsService, ReturnsValidationError } from "../returns/returnsService.js";
import { runMigrations } from "../../migrations/runner.js";
import { applySchema } from "../../db/schema.js";
import { ReconciliationService } from "../reconciliation/reconciliationService.js";

const setup = (cutLengthMm = 1800) => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "profile", sku: "P-3000", title: "Profile", catalog_type: "profile", base_uom_code: "meter", profile: { material: "ALUMINUM", form: "square", width_mm: "40", height_mm: "40", wall_thickness_mm: "2", standard_purchase_lengths_mm: [3000], custom_length_allowed: false } });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({ id: "purchase", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST", invoiceNumber: "INV", invoiceDate: "2026-09-23", lines: [
    { id: "line", productId: "profile", quantity: "1", quoteBasis: "profile_bar", profileLengthMm: 3000, supplierUnitPriceMinor: 3000, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 },
  ] });
  const cost = procurement.finalizeAcquisitionCosts("purchase", { allocations: [] }).lots[0];
  const inventory = new InventoryService(db);
  const receipt = inventory.receiveCostedLot({ receiptId: "receipt", costSnapshotId: cost.id, receivedAt: "2026-09-23T09:00:00.000Z", location: { id: "pick", kind: "PICKING" }, operationId: "receive" });
  const proposalBase = {
    workspaceKitId: "workspace-kit", workspaceVersionId: "workspace-v1", publishedKitId: null,
    sku: "KIT-CUT", title: "Cut kit", components: [],
    profileCutPlan: { profileProductId: "profile", catalogVersionRef: String(db.prepare("SELECT catalog_version_ref FROM products WHERE id='profile'").pluck().get()), cuts: [{ quantity: 1, lengthMm: cutLengthMm }] },
    packagingPlan: { packageCount: 1, instructionVersion: "pack:v1", installationGuideVersion: "guide:v1", packages: [{ packageNumber: 1, items: [{ productId: "profile", quantityBaseInt: cutLengthMm }] }] },
    finalSalePriceMinor: 4000, currency: "TRY",
  } satisfies Omit<KitPublicationProposal, "authoredContentHash">;
  const proposal = { ...proposalBase, authoredContentHash: authoredKitContentHash(proposalBase) };
  const publisher = new PublishedKitService(db);
  const preview = publisher.preview(proposal);
  const publication = publisher.publish({ proposal, approvedContentHash: preview.contentHash, approvedPolicyHash: preview.corePolicyHash, operationId: "publish", actor: { id: "owner" }, publishedAt: "2026-09-23T09:30:00.000Z" });
  return { db, inventory, profileCuts: new ProfileCutInventoryService(db), publication, receipt };
};

test("profile receipt creates exact integer-mm physical pieces with lot and acquisition-cost provenance", () => {
  const { db, receipt } = setup();
  assert.deepEqual(db.prepare(`SELECT inventory_lot_id,original_length_mm,current_length_mm,historical_cost_minor,status
    FROM profile_inventory_pieces`).all(), [{ inventory_lot_id: receipt.lot.id, original_length_mm: 3000, current_length_mm: 3000, historical_cost_minor: 3000, status: "AVAILABLE" }]);
  db.close();
});

test("reservation plans whole physical pieces and rejects an unfittable cut atomically", () => {
  const { db, inventory, publication } = setup();
  const reserved = inventory.reserveOrder({
    reservationId: "reservation", orderId: "order", operationId: "reserve",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }],
  });
  assert.equal(reserved.allocations[0].quantityBaseInt, 1800);
  assert.equal(db.prepare("SELECT reserved_base_int FROM inventory_lots").pluck().get(), 1803);
  assert.deepEqual(db.prepare("SELECT cut_length_total_mm,kerf_total_mm,consumed_length_mm,planned_remnant_length_mm,status FROM profile_piece_reservations").get(), {
    cut_length_total_mm: 1800, kerf_total_mm: 3, consumed_length_mm: 1803, planned_remnant_length_mm: 1197, status: "ACTIVE",
  });
  assert.throws(() => inventory.reserveOrder({
    reservationId: "shortage", orderId: "shortage-order", operationId: "shortage",
    lines: [{ productId: "profile", quantityBaseInt: 3600 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }, { lengthMm: 1800 }] }],
  }), (error: unknown) => error instanceof InventoryValidationError && error.code === "INSUFFICIENT_PROFILE_PIECES");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations WHERE id='shortage'").pluck().get(), 0);
  assert.throws(() => inventory.reserveOrder({
    reservationId: "tampered", orderId: "tampered-order", operationId: "tampered",
    lines: [{ productId: "profile", quantityBaseInt: 1000 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1000 }] }],
  }), (error: unknown) => error instanceof InventoryValidationError && error.code === "PROFILE_CUT_PLAN_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations WHERE id='tampered'").pluck().get(), 0);
  db.close();
});

test("reconciliation uses profile cut reservation evidence so valid kerf produces no false finding", () => {
  const { db, inventory, publication } = setup();
  inventory.reserveOrder({ reservationId: "reconcile-profile", orderId: "profile-order", operationId: "reconcile-reserve",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }] });
  const run = new ReconciliationService(db).run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "profile-valid-scan" });
  assert.equal(run.findings.some((finding) => finding.code === "INVENTORY_RESERVED_MISMATCH" || finding.code === "PROFILE_CUT_RESERVATION_MISMATCH"), false);
  db.close();
});

test("reconciliation reports a real profile reserved-balance mismatch", () => {
  const { db, inventory, publication } = setup();
  inventory.reserveOrder({ reservationId: "reconcile-profile-bad", orderId: "profile-order-bad", operationId: "reconcile-reserve-bad",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }] });
  db.prepare("UPDATE inventory_lots SET reserved_base_int=reserved_base_int-1").run();
  const run = new ReconciliationService(db).run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "profile-bad-scan" });
  assert.equal(run.findings.some((finding) => finding.code === "INVENTORY_RESERVED_MISMATCH" && finding.affectedId === "P-3000"), true);
  db.close();
});

test("a one-millimeter positive remnant remains an exact physical inventory piece", () => {
  const { db, inventory, profileCuts, publication } = setup(2996);
  inventory.reserveOrder({
    reservationId: "one-mm-reservation", orderId: "one-mm-order", operationId: "one-mm-reserve",
    lines: [{ productId: "profile", quantityBaseInt: 2996 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 2996 }] }],
  });
  const result = profileCuts.executeReservationCuts({ reservationId: "one-mm-reservation", operationId: "one-mm-cut", actorId: "cutter" });
  assert.equal(result.executions[0].remnantLengthMm, 1);
  assert.deepEqual(db.prepare("SELECT current_length_mm,historical_cost_minor,status FROM profile_inventory_pieces WHERE status='AVAILABLE'").all(), [
    { current_length_mm: 1, historical_cost_minor: 1, status: "AVAILABLE" },
  ]);
  db.close();
});

test("cut execution preserves every positive remnant and conserves exact historical cost", () => {
  const { db, inventory, profileCuts, publication } = setup();
  inventory.reserveOrder({
    reservationId: "reservation", orderId: "order", operationId: "reserve",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }],
  });
  const first = profileCuts.executeReservationCuts({ reservationId: "reservation", operationId: "cut", actorId: "cutter", executedAt: "2026-09-23T10:00:00.000Z" });
  const replay = profileCuts.executeReservationCuts({ reservationId: "reservation", operationId: "cut", actorId: "cutter", executedAt: "2026-09-23T10:00:00.000Z" });
  assert.deepEqual(replay, first);
  assert.equal(first.executions[0].consumedLengthMm, 1803);
  assert.equal(first.executions[0].remnantLengthMm, 1197);
  assert.equal(first.executions[0].consumedCostMinor + first.executions[0].remnantCostMinor, 3000);
  assert.deepEqual(db.prepare("SELECT current_length_mm,reserved_length_mm,historical_cost_minor,status FROM profile_inventory_pieces ORDER BY piece_sequence").all(), [
    { current_length_mm: 0, reserved_length_mm: 0, historical_cost_minor: 3000, status: "CUT" },
    { current_length_mm: 1800, reserved_length_mm: 1800, historical_cost_minor: 1803, status: "RESERVED" },
    { current_length_mm: 1197, reserved_length_mm: 0, historical_cost_minor: 1197, status: "AVAILABLE" },
  ]);
  assert.deepEqual(db.prepare("SELECT on_hand_base_int,reserved_base_int FROM inventory_lots").get(), { on_hand_base_int: 2997, reserved_base_int: 1800 });
  assert.equal(db.prepare("SELECT waste_length_mm FROM profile_cut_waste_facts").pluck().get(), 3);
  assert.equal(inventory.getProductReconciliation("profile").reconciled, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM profile_cut_executions").pluck().get(), 1);
  db.close();
});

test("cut then cancel releases only the deliverable cut and never resurrects kerf", () => {
  const { db, inventory, profileCuts, publication } = setup();
  inventory.reserveOrder({ reservationId: "cancel-reservation", orderId: "cancel-order", operationId: "reserve-cancel",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }] });
  profileCuts.executeReservationCuts({ reservationId: "cancel-reservation", operationId: "cut-cancel", actorId: "cutter" });
  inventory.releaseReservation({ reservationId: "cancel-reservation", reason: "customer cancelled", operationId: "release-cancel" });
  assert.deepEqual(db.prepare("SELECT on_hand_base_int,reserved_base_int FROM inventory_lots").get(), { on_hand_base_int: 2997, reserved_base_int: 0 });
  assert.deepEqual(db.prepare(`SELECT current_length_mm,status FROM profile_inventory_pieces
    WHERE current_length_mm>0 ORDER BY current_length_mm`).all(), [
    { current_length_mm: 1197, status: "AVAILABLE" },
    { current_length_mm: 1800, status: "AVAILABLE" },
  ]);
  assert.equal(inventory.getProductReconciliation("profile").reconciled, true);
  db.close();
});

test("cut then dispatch ships 1800 only, includes kerf in historical COGS, and caps return restoration at the sold recipe", () => {
  const { db, inventory, profileCuts, publication } = setup();
  db.prepare("INSERT INTO sales (id,customer_name,total_amount,platform) VALUES ('profile-sale','Customer',40,'Store')").run();
  db.prepare(`INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price)
    VALUES ('profile-sale-line','profile-sale',?,'Cut kit',1,40)`).run(publication.productId);
  const finance = new SalesFinancialService(db);
  const sale = finance.createOrderSnapshot({ saleId: "profile-sale", currency: "TRY", sourceChannel: "Store",
    discountMinor: 0, commissionRatePercent: 0, commissionCalculationBasis: "GROSS_AFTER_DISCOUNT",
    commissionTerms: { source: "test" }, lines: [{ saleLineId: "profile-sale-line", productId: publication.productId,
      quantity: 1, unitGrossMinor: 4000, vatRateBps: 2000 }], operationId: "sale-snapshot", actor: { id: "seller" } });
  inventory.reserveOrder({ reservationId: "dispatch-reservation", orderId: "profile-sale", operationId: "reserve-dispatch",
    lines: [{ productId: "profile", quantityBaseInt: 1800 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }] });
  profileCuts.executeReservationCuts({ reservationId: "dispatch-reservation", operationId: "cut-dispatch", actorId: "cutter" });
  inventory.markPicked({ reservationId: "dispatch-reservation", operationId: "pick" });
  inventory.markPacked({ reservationId: "dispatch-reservation", operationId: "pack" });
  inventory.dispatchReservation({ reservationId: "dispatch-reservation", shipmentId: "shipment", dispatchedAt: "2026-09-23T11:00:00.000Z", operationId: "dispatch" });
  const finalized = finance.finalizeDispatch({ reservationId: "dispatch-reservation", operationId: "dispatch", actor: { id: "dispatcher" } });
  assert.deepEqual(db.prepare("SELECT on_hand_base_int,reserved_base_int FROM inventory_lots").get(), { on_hand_base_int: 1197, reserved_base_int: 0 });
  assert.equal(db.prepare("SELECT -quantity_delta_base_int FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1800);
  assert.equal(finalized.totals.actualCogsTryMinor, 1803);
  assert.deepEqual(db.prepare("SELECT quantity_base_int,cost_base_try_minor FROM sale_financial_cogs_allocations").get(), {
    quantity_base_int: 1800, cost_base_try_minor: 1803,
  });
  const returns = new ReturnsService(db);
  const approved = returns.createReturnRequest({ saleId: "profile-sale", lines: [{ financialLineId: sale.lines[0].id,
    quantityBaseInt: 1, reasonCode: "CUSTOMER_CHANGED_MIND" }], operationId: "return", actor: { id: "agent" } });
  assert.equal(approved.lines[0].cogs[0].quantityBaseInt, 1800);
  assert.throws(() => returns.createReturnRequest({ saleId: "profile-sale", lines: [{ financialLineId: sale.lines[0].id,
    quantityBaseInt: 1, reasonCode: "CUSTOMER_CHANGED_MIND" }], operationId: "return-over", actor: { id: "agent" } }),
  (error: unknown) => error instanceof ReturnsValidationError && error.code === "RETURN_QUANTITY_EXCEEDED");
  db.prepare("INSERT INTO warehouse_topologies (id,name,code_template,config_json,config_hash,active) VALUES ('profile-return','Profile return','{rack}','{}','profile-return',1)").run();
  db.prepare(`INSERT INTO warehouse_rack_configs
    (id,topology_id,rack_code,level_count,position_count,depth_count,role,allow_mixed_sku,allow_mixed_lot,placement_priority,config_json)
    VALUES ('profile-return-rack','profile-return','R',1,1,1,'PICKING',1,1,1,'{}')`).run();
  db.prepare(`INSERT INTO warehouse_level_configs
    (id,topology_id,rack_code,level_number,role,allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES ('profile-return-level','profile-return','R',1,'PICKING',1,1,1)`).run();
  db.prepare(`INSERT INTO warehouse_position_configs
    (id,topology_id,rack_code,level_number,position_number,role,allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES ('profile-return-position','profile-return','R',1,1,'PICKING',1,1,1)`).run();
  db.prepare(`INSERT INTO warehouse_location_slots
    (id,topology_id,code,rack_code,level_number,position_number,depth_code,depth_index,is_front,role,allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES ('PROFILE-RETURN','profile-return','PROFILE-RETURN','R',1,1,'A',0,1,'PICKING',1,1,1)`).run();
  returns.receiveReturn({ returnId: approved.id, lines: [{ returnLineId: approved.lines[0].id, quantityBaseInt: 1,
    disposition: "SELLABLE", locationId: "PROFILE-RETURN" }], operationId: "receive-return", actor: { id: "receiver" } });
  assert.equal(db.prepare("SELECT on_hand_base_int FROM inventory_lots").pluck().get(), 2997);
  assert.deepEqual(db.prepare(`SELECT length_mm,historical_cost_minor FROM profile_return_piece_restorations`).get(), {
    length_mm: 1800, historical_cost_minor: 1803,
  });
  assert.deepEqual(db.prepare(`SELECT current_length_mm,status FROM profile_inventory_pieces
    WHERE status='AVAILABLE' ORDER BY current_length_mm`).all(), [
    { current_length_mm: 1197, status: "AVAILABLE" }, { current_length_mm: 1800, status: "AVAILABLE" },
  ]);
  assert.equal(inventory.getProductReconciliation("profile").reconciled, true);
  db.close();
});

test("v78 derives only pristine receipt-proven pieces and blocks unsafe legacy profile stock", () => {
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  applySchema(legacy);
  runMigrations(legacy, 76, { allowUntrackedSchemaBootstrap: true });
  const catalog = new CatalogService(legacy);
  catalog.createProduct({ id: "legacy-profile", sku: "LEGACY-P", title: "Legacy profile", catalog_type: "profile", base_uom_code: "meter",
    profile: { material: "ALUMINUM", form: "square", width_mm: "40", height_mm: "40", wall_thickness_mm: "2", standard_purchase_lengths_mm: [3000], custom_length_allowed: false } });
  const procurement = new ProcurementService(legacy);
  procurement.registerSupplier({ id: "legacy-supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({ id: "legacy-purchase", supplierId: "legacy-supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    invoiceNumber: "LEGACY", invoiceDate: "2026-09-23", lines: [{ id: "legacy-line", productId: "legacy-profile", quantity: "1",
      quoteBasis: "profile_bar", profileLengthMm: 3000, supplierUnitPriceMinor: 3000, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }] });
  const cost = procurement.finalizeAcquisitionCosts("legacy-purchase", { allocations: [] }).lots[0];
  const inventory = new InventoryService(legacy);
  const legacyLotId = "legacy-lot";
  legacy.prepare(`INSERT INTO inventory_lots
    (id,receipt_id,acquisition_cost_snapshot_id,purchase_order_id,purchase_line_id,product_id,base_uom_code_snapshot,
     received_quantity_base_int,on_hand_base_int,reserved_base_int,status,received_at,receipt_operation_id)
    VALUES (?,?,?,?,?,?,?,3000,2997,0,'USABLE','2026-09-23T09:00:00.000Z','legacy-receive')`).run(
      legacyLotId, "legacy-receipt", cost.id, "legacy-purchase", "legacy-line", "legacy-profile", "meter",
    );
  legacy.prepare(`INSERT INTO inventory_lot_location_balances
    (id,lot_id,location_id,location_kind,quantity_base_int,active,physical_state)
    VALUES ('legacy-balance',?,'legacy-pick','PICKING',2997,1,'CONFIRMED')`).run(legacyLotId);
  legacy.prepare(`INSERT INTO inventory_ledger_events
    (id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,reason_code,reference_type,reference_id,occurred_at)
    VALUES ('legacy-receipt-event','legacy-receive','RECEIPT','legacy-profile',?,3000,'meter','APPROVED_GOODS_RECEIPT','goods_receipt','legacy-receipt','2026-09-23T09:00:00.000Z')`).run(legacyLotId);
  legacy.prepare(`INSERT INTO inventory_ledger_events
    (id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,reason_code,reference_type,reference_id,occurred_at)
    VALUES ('legacy-unknown-loss','legacy-unknown-loss','CORRECTION','legacy-profile',?,-3,'meter','UNKNOWN_LEGACY_LOSS','legacy','unknown','2026-09-23T10:00:00.000Z')`).run(legacyLotId);
  runMigrations(legacy);
  assert.equal(legacy.prepare("SELECT reason_code FROM profile_piece_migration_blocks WHERE inventory_lot_id=?").pluck().get(legacyLotId), "PROFILE_PIECE_MIGRATION_REQUIRED");
  assert.throws(() => inventory.getProductAvailability("legacy-profile"),
    (error: unknown) => error instanceof InventoryValidationError && error.code === "PROFILE_PIECE_MIGRATION_REQUIRED");
  assert.equal(legacy.prepare("SELECT COUNT(*) FROM profile_inventory_pieces WHERE inventory_lot_id=?").pluck().get(legacyLotId), 0);
  legacy.close();
});

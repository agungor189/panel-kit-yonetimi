import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { InventoryService, InventoryValidationError } from "./inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { PublishedKitService, authoredKitContentHash, type KitPublicationProposal } from "../kits/publishedKitService.js";
import { ProfileCutInventoryService } from "./profileCutInventoryService.js";

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
    packagingPlan: { packageCount: 1, instructionVersion: "pack:v1", installationGuideVersion: "guide:v1", packages: [{ packageNumber: 1, items: [{ productId: "profile", quantityBaseInt: cutLengthMm + 3 }] }] },
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
    lines: [{ productId: "profile", quantityBaseInt: 1803 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }],
  });
  assert.equal(reserved.allocations[0].quantityBaseInt, 1803);
  assert.deepEqual(db.prepare("SELECT cut_length_total_mm,kerf_total_mm,consumed_length_mm,planned_remnant_length_mm,status FROM profile_piece_reservations").get(), {
    cut_length_total_mm: 1800, kerf_total_mm: 3, consumed_length_mm: 1803, planned_remnant_length_mm: 1197, status: "ACTIVE",
  });
  assert.throws(() => inventory.reserveOrder({
    reservationId: "shortage", orderId: "shortage-order", operationId: "shortage",
    lines: [{ productId: "profile", quantityBaseInt: 3606 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }, { lengthMm: 1800 }] }],
  }), (error: unknown) => error instanceof InventoryValidationError && error.code === "INSUFFICIENT_PROFILE_PIECES");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations WHERE id='shortage'").pluck().get(), 0);
  assert.throws(() => inventory.reserveOrder({
    reservationId: "tampered", orderId: "tampered-order", operationId: "tampered",
    lines: [{ productId: "profile", quantityBaseInt: 1003 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1000 }] }],
  }), (error: unknown) => error instanceof InventoryValidationError && error.code === "PROFILE_CUT_PLAN_INVALID");
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_reservations WHERE id='tampered'").pluck().get(), 0);
  db.close();
});

test("a one-millimeter positive remnant remains an exact physical inventory piece", () => {
  const { db, inventory, profileCuts, publication } = setup(2996);
  inventory.reserveOrder({
    reservationId: "one-mm-reservation", orderId: "one-mm-order", operationId: "one-mm-reserve",
    lines: [{ productId: "profile", quantityBaseInt: 2999 }],
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
    lines: [{ productId: "profile", quantityBaseInt: 1803 }],
    profileCutPlans: [{ publishedKitVersionId: publication.versionId, productId: "profile", kerfMm: 3, cuts: [{ lengthMm: 1800 }] }],
  });
  const first = profileCuts.executeReservationCuts({ reservationId: "reservation", operationId: "cut", actorId: "cutter", executedAt: "2026-09-23T10:00:00.000Z" });
  const replay = profileCuts.executeReservationCuts({ reservationId: "reservation", operationId: "cut", actorId: "cutter", executedAt: "2026-09-23T10:00:00.000Z" });
  assert.deepEqual(replay, first);
  assert.equal(first.executions[0].consumedLengthMm, 1803);
  assert.equal(first.executions[0].remnantLengthMm, 1197);
  assert.equal(first.executions[0].consumedCostMinor + first.executions[0].remnantCostMinor, 3000);
  assert.deepEqual(db.prepare("SELECT current_length_mm,historical_cost_minor,status FROM profile_inventory_pieces ORDER BY piece_sequence").all(), [
    { current_length_mm: 0, historical_cost_minor: 3000, status: "CUT" },
    { current_length_mm: 1197, historical_cost_minor: 1197, status: "AVAILABLE" },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM profile_cut_executions").pluck().get(), 1);
  db.close();
});

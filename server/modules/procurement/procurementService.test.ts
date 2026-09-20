import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { ExchangeRateService } from "../finance/exchangeRates.js";
import { ProcurementService, type PurchaseCostInput, type PurchaseInput, type PurchaseLineInput } from "./procurementService.js";

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "part-a", sku: "PART-A", title: "Part A", catalog_type: "product", base_uom_code: "piece" });
  catalog.createProduct({ id: "part-b", sku: "PART-B", title: "Part B", catalog_type: "product", base_uom_code: "piece" });
  catalog.createProduct({
    id: "profile", sku: "PROFILE", title: "Profile", catalog_type: "profile", base_uom_code: "meter",
    profile: { material: "STEEL", form: "square", width_mm: 30, height_mm: 30, wall_thickness_mm: 2, standard_purchase_lengths_mm: [1000, 2000, 3000, 6000], custom_length_allowed: true },
  });
  catalog.createProduct({ id: "fabric", sku: "FABRIC", title: "Fabric", catalog_type: "complementary", base_uom_code: "square_meter", material_behavior: "continuous_cut" });
  catalog.createProduct({ id: "roll", sku: "ROLL", title: "Roll", catalog_type: "complementary", base_uom_code: "roll" });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "USD" });
  return { db, procurement, fx: new ExchangeRateService(db) };
};

const line = (overrides: Partial<PurchaseLineInput> = {}): PurchaseLineInput => ({
  id: "line-a",
  productId: "part-a",
  quantity: "10",
  quoteBasis: "piece",
  supplierUnitPriceMinor: 1_000,
  currency: "USD",
  vatMode: "EXCLUDED",
  vatRateBps: 2_000,
  ...overrides,
});

const purchase = (id: string, lines: PurchaseLineInput[] = [line()], acquisitionCosts: PurchaseCostInput[] = []): PurchaseInput => ({
  id,
  supplierId: "supplier",
  acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
  invoiceNumber: `INV-${id}`,
  invoiceDate: "2026-09-20",
  notes: "synthetic purchase",
  attachments: [{ id: `${id}-invoice`, kind: "INVOICE" as const, fileName: "invoice.pdf", mediaType: "application/pdf", sizeBytes: 1200, sha256: "a".repeat(64) }],
  lines,
  acquisitionCosts,
});

test("USD purchase snapshots FX while a later purchase uses the changed current rate", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  const lotA = procurement.createPurchase(purchase("po-a"));
  fx.recordCurrentUsdTry({ rate: "45", source: "MANUAL", changedAt: "2026-09-20T10:00:00.000Z", actorId: "finance-owner" });
  const lotB = procurement.createPurchase(purchase("po-b", [line({ id: "line-b" })]));

  assert.deepEqual(lotA.lines[0].fx, { observationId: lotA.lines[0].fx.observationId, numerator: 40, denominator: 1, source: "MANUAL", observedAt: "2026-09-20T09:00:00.000Z", direction: "USD_TO_TRY" });
  assert.equal(lotA.lines[0].amounts.baseTry.netMinor, 400_000);
  assert.equal(lotB.lines[0].amounts.baseTry.netMinor, 450_000);
  assert.equal(procurement.getPurchase("po-a")!.lines[0].amounts.baseTry.netMinor, 400_000);
  db.close();
});

test("VAT included and excluded inputs produce the same exact net, VAT and gross minor units", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  const excluded = procurement.createPurchase(purchase("po-vat-ex", [line({ quantity: "1", supplierUnitPriceMinor: 10_000 })]));
  const included = procurement.createPurchase(purchase("po-vat-in", [line({ id: "line-b", productId: "part-b", quantity: "1", supplierUnitPriceMinor: 12_000, vatMode: "INCLUDED" })]));
  assert.deepEqual(excluded.lines[0].amounts.supplier, { netMinor: 10_000, vatMinor: 2_000, grossMinor: 12_000 });
  assert.deepEqual(included.lines[0].amounts.supplier, excluded.lines[0].amounts.supplier);
  db.close();
});

test("purchase value allocation suggestion is deterministic and manual override never gets overwritten", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "1", source: "TEST", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  const created = procurement.createPurchase(purchase("po-allocation", [
    line({ id: "line-a", quantity: "1", supplierUnitPriceMinor: 100 }),
    line({ id: "line-b", productId: "part-b", quantity: "1", supplierUnitPriceMinor: 100 }),
  ], [{ id: "freight", category: "FREIGHT", amountMinor: 101, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 0, notes: "shared" }]));
  assert.deepEqual(created.allocationSuggestions.map((entry) => ({ lineId: entry.lineId, amount: entry.amountTryMinor, adjustment: entry.roundingAdjustmentMinor })), [
    { lineId: "line-a", amount: 51, adjustment: 1 },
    { lineId: "line-b", amount: 50, adjustment: 0 },
  ]);
  assert.equal(created.allocationRuns[0].roundingResidualMinor, 1);

  const finalized = procurement.finalizeAcquisitionCosts("po-allocation", {
    allocations: [{ componentId: "freight", mode: "MANUAL", lineAllocations: [{ lineId: "line-a", amountTryMinor: 40 }, { lineId: "line-b", amountTryMinor: 50 }] }],
  });
  assert.deepEqual(finalized.allocations.map((entry) => ({ lineId: entry.lineId, amount: entry.amountTryMinor, provenance: entry.provenance })), [
    { lineId: "line-a", amount: 40, provenance: "MANUAL" },
    { lineId: "line-b", amount: 50, provenance: "MANUAL" },
  ]);
  assert.equal(finalized.unallocatedCosts[0].amountTryMinor, 11);
  assert.throws(() => db.prepare("UPDATE purchase_cost_allocations SET amount_try_minor=999").run(), /immutable/i);
  db.close();
});

test("planned lot A/B costs remain independent and profile per-meter/per-bar normalize identically", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  procurement.createPurchase(purchase("po-lot-a", [line({ quantity: "1" })]));
  const finalizedA = procurement.finalizeAcquisitionCosts("po-lot-a", { allocations: [] });
  fx.recordCurrentUsdTry({ rate: "45", source: "MANUAL", changedAt: "2026-09-20T10:00:00.000Z", actorId: "finance-owner" });
  procurement.createPurchase(purchase("po-lot-b", [line({ id: "line-b", quantity: "1" })]));
  const finalizedB = procurement.finalizeAcquisitionCosts("po-lot-b", { allocations: [] });
  assert.equal(finalizedA.lots[0].landedCostTryMinor, 40_000);
  assert.equal(finalizedB.lots[0].landedCostTryMinor, 45_000);
  assert.equal(procurement.getPurchase("po-lot-a")!.lots[0].landedCostTryMinor, 40_000);

  const perMeter = procurement.createPurchase(purchase("po-meter", [line({ id: "meter", productId: "profile", quantity: "6", quoteBasis: "meter", supplierUnitPriceMinor: 1_000 })]));
  const perBar = procurement.createPurchase(purchase("po-bar", [line({ id: "bar", productId: "profile", quantity: "1", quoteBasis: "profile_bar", profileLengthMm: 6000, supplierUnitPriceMinor: 6_000 })]));
  assert.equal(perMeter.lines[0].normalizedQuantity.baseQuantity, 6000);
  assert.equal(perBar.lines[0].normalizedQuantity.baseQuantity, 6000);
  assert.deepEqual(perMeter.lines[0].normalizedMerchandiseUnitCostTry, perBar.lines[0].normalizedMerchandiseUnitCostTry);
  db.close();
});

test("square-meter and roll quote provenance is retained and PO/payment never posts physical stock", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  db.prepare("INSERT INTO cash_accounts (id,name,currency) VALUES ('usd-account','USD account','USD')").run();
  const beforeStock = db.prepare("SELECT id, central_stock FROM products ORDER BY id").all();
  const beforeMovements = db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get();
  const created = procurement.createPurchase(purchase("po-uom", [
    line({ id: "sqm", productId: "fabric", quantity: "2.5", quoteBasis: "square_meter", supplierUnitPriceMinor: 1_000 }),
    line({ id: "roll", productId: "roll", quantity: "2", quoteBasis: "roll", supplierUnitPriceMinor: 2_000 }),
  ]));
  procurement.finalizeAcquisitionCosts("po-uom", { allocations: [] });
  const paid = procurement.recordPayment("po-uom", { id: "payment-1", cashAccountId: "usd-account", amountMinor: 1_000, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z", reference: "BANK-1" });
  assert.equal(created.lines[0].quote.basis, "square_meter");
  assert.equal(created.lines[0].quote.originalQuantity, "2.5");
  assert.equal(created.lines[1].quote.basis, "roll");
  assert.equal(paid.paymentStatus, "PARTIAL");
  assert.equal(paid.outstandingMinor, paid.totalGrossMinor - 1_000);
  assert.deepEqual(db.prepare("SELECT id, central_stock FROM products ORDER BY id").all(), beforeStock);
  assert.equal(db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get(), beforeMovements);
  assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE purchase_id='po-uom'").pluck().get(), 1);
  db.close();
});

test("duplicate command replays the purchase result without a second purchase, lot or cash effect", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  const commands = new CommandExecutor(db);
  const payload = purchase("po-replay");
  const execute = () => commands.execute({
    operationId: "create-po-replay", commandType: "procurement.purchase.create.v1", payload,
    actor: { human: { id: "buyer" } }, authorization: { decision: "ALLOW", capability: "procurement:write" },
  }, () => ({ statusCode: 201, body: { success: true, purchaseId: procurement.createPurchase(payload).id } }));
  assert.equal(execute().replayed, false);
  assert.equal(execute().replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM purchase_orders WHERE id='po-replay'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='procurement.purchase.create.v1'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings").pluck().get(), 0);
  db.close();
});

test("actual purchase payment projects once into the canonical cash ledger and decreases balance exactly once", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  db.prepare("INSERT INTO cash_accounts (id,name,currency,opening_balance) VALUES ('canonical-usd','Canonical USD','USD',100)").run();
  procurement.createPurchase(purchase("po-cash"));
  const commands = new CommandExecutor(db);
  const payload = { id: "payment-cash", cashAccountId: "canonical-usd", amountMinor: 1_000, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z" };
  const execute = () => commands.execute({
    operationId: "pay-po-cash", commandType: "procurement.purchase-payment.record.v1", payload,
    actor: { human: { id: "buyer" } }, authorization: { decision: "ALLOW", capability: "finance:write" },
  }, () => ({ statusCode: 201, body: procurement.recordPayment("po-cash", payload) }));
  assert.equal(execute().replayed, false);
  assert.equal(execute().replayed, true);
  const ledger = db.prepare("SELECT type,amount,currency,source_type,source_id FROM cash_transactions WHERE account_id='canonical-usd'").all();
  assert.deepEqual(ledger, [{ type: "OUT", amount: 10, currency: "USD", source_type: "procurement_purchase_payment", source_id: "payment-cash" }]);
  const balance = db.prepare(`SELECT a.opening_balance + COALESCE(SUM(CASE WHEN t.type='IN' THEN t.amount WHEN t.type='OUT' THEN -t.amount ELSE 0 END),0)
    FROM cash_accounts a LEFT JOIN cash_transactions t ON t.account_id=a.id AND t.is_deleted=0 WHERE a.id='canonical-usd' GROUP BY a.id`).pluck().get();
  assert.equal(balance, 90);
  assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE payment_id='payment-cash'").pluck().get(), 1);
  assert.throws(() => db.prepare("UPDATE cash_transactions SET amount=999 WHERE source_id='payment-cash'").run(), /immutable/i);
  db.close();
});

test("cash-ledger projection failure atomically rolls back payment provenance and purchase status", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  db.prepare("INSERT INTO cash_accounts (id,name,currency,opening_balance) VALUES ('atomic-usd','Atomic USD','USD',100)").run();
  procurement.createPurchase(purchase("po-atomic-cash"));
  db.prepare(`INSERT INTO cash_transactions (id,account_id,type,amount,currency,source_type,source_id,is_deleted)
    VALUES ('procurement-payment:payment-atomic','atomic-usd','OUT',1,'USD','test_fixture','collision',0)`).run();
  assert.throws(() => procurement.recordPayment("po-atomic-cash", {
    id: "payment-atomic", cashAccountId: "atomic-usd", amountMinor: 1_000, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z",
  }), /unique/i);
  assert.equal(db.prepare("SELECT COUNT(*) FROM purchase_payments WHERE id='payment-atomic'").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE payment_id='payment-atomic'").pluck().get(), 0);
  assert.deepEqual(db.prepare("SELECT paid_minor,payment_status FROM purchase_orders WHERE id='po-atomic-cash'").get(), { paid_minor: 0, payment_status: "UNPAID" });
  db.close();
});

test("third-party acquisition components retain independent currencies and never increase goods-supplier payable", () => {
  const { db, procurement, fx } = setup();
  fx.recordCurrentUsdTry({ rate: "40", source: "MANUAL", changedAt: "2026-09-20T09:00:00.000Z", actorId: "finance-owner" });
  const created = procurement.createPurchase(purchase("po-mixed-cost", [line({ quantity: "1", supplierUnitPriceMinor: 1_000 })], [
    { id: "freight-usd", category: "FREIGHT", amountMinor: 100, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 0 },
    { id: "customs-try", category: "CUSTOMS", amountMinor: 500, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 },
  ]));
  assert.equal(created.totalGrossMinor, 1_200);
  assert.equal(created.outstandingMinor, 1_200);
  assert.deepEqual(created.acquisitionCosts.map((cost: any) => ({ id: cost.id, currency: cost.currency, fx: cost.fx, net: cost.amounts.baseTry.netMinor })), [
    { id: "customs-try", currency: "TRY", fx: { observationId: null, numerator: 1, denominator: 1, source: "BASE_CURRENCY", observedAt: created.acquisitionCosts[0].fx.observedAt, direction: "TRY_TO_TRY" }, net: 500 },
    { id: "freight-usd", currency: "USD", fx: { observationId: created.acquisitionCosts[1].fx.observationId, numerator: 40, denominator: 1, source: "MANUAL", observedAt: "2026-09-20T09:00:00.000Z", direction: "USD_TO_TRY" }, net: 4_000 },
  ]);
  db.close();
});

test("purchase VAT policy is explicit, immutable, and controls whether VAT enters historical lot cost", () => {
  const { db, procurement } = setup();
  const missingPolicy: any = purchase("po-vat-policy-missing", [line({ currency: "TRY" })]);
  delete missingPolicy.acquisitionCostVatPolicy;
  assert.throws(() => procurement.createPurchase(missingPolicy as PurchaseInput), /explicitly include or exclude VAT/i);
  const excluded = purchase("po-vat-policy-ex", [line({ quantity: "1", supplierUnitPriceMinor: 10_000, currency: "TRY" })], [
    { id: "freight-ex", category: "FREIGHT", amountMinor: 1_000, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 2_000 },
  ]);
  excluded.acquisitionCostVatPolicy = "VAT_EXCLUDED_FROM_INVENTORY_COST";
  procurement.createPurchase(excluded);
  const excludedLot = procurement.finalizeAcquisitionCosts("po-vat-policy-ex", { allocations: [{ componentId: "freight-ex", mode: "ACCEPT_SUGGESTION" }] });

  const included = purchase("po-vat-policy-in", [line({ id: "line-in", quantity: "1", supplierUnitPriceMinor: 12_000, currency: "TRY", vatMode: "INCLUDED" })], [
    { id: "freight-in", category: "FREIGHT", amountMinor: 1_200, currency: "TRY", vatMode: "INCLUDED", vatRateBps: 2_000 },
  ]);
  included.acquisitionCostVatPolicy = "VAT_INCLUDED_IN_INVENTORY_COST";
  procurement.createPurchase(included);
  const includedLot = procurement.finalizeAcquisitionCosts("po-vat-policy-in", { allocations: [{ componentId: "freight-in", mode: "ACCEPT_SUGGESTION" }] });

  assert.equal(excludedLot.vatPolicy, "VAT_EXCLUDED_FROM_INVENTORY_COST");
  assert.equal(excludedLot.lots[0].vatPolicy, "VAT_EXCLUDED_FROM_INVENTORY_COST");
  assert.equal(excludedLot.lots[0].landedCostTryMinor, 11_000);
  assert.equal(excludedLot.lots[0].vatTryMinor, 2_200);
  assert.equal(includedLot.lots[0].landedCostTryMinor, 13_200);
  assert.equal(includedLot.lots[0].vatTryMinor, 2_200);
  assert.throws(() => db.prepare("UPDATE purchase_orders SET acquisition_cost_vat_policy='VAT_INCLUDED_IN_INVENTORY_COST' WHERE id='po-vat-policy-ex'").run(), /immutable/i);
  assert.equal(procurement.getPurchase("po-vat-policy-ex")!.lots[0].landedCostTryMinor, 11_000);
  db.close();
});

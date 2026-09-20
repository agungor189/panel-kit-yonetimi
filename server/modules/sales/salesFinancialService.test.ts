import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { ExchangeRateService } from "../finance/exchangeRates.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { SalesFinancialService } from "./salesFinancialService.js";

const actor = { id: "sales-owner", name: "Sales Owner" };

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "part", sku: "PART", title: "Part", catalog_type: "product", base_uom_code: "piece" });
  catalog.createProduct({ id: "kit", sku: "KIT", title: "Kit", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO product_bom (id,parent_product_id,component_product_id,quantity_per_unit,component_role) VALUES ('kit-part','kit','part',2,'BODY')").run();
  db.prepare("INSERT INTO sales (id,order_code,total_amount,platform) VALUES ('sale','DS-TEST',0,'Marketplace')").run();
  db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price) VALUES ('sale-line','sale','kit','Kit',2,0)").run();
  return { db, finance: new SalesFinancialService(db), procurement: new ProcurementService(db), inventory: new InventoryService(db) };
};

const receive = (fixture: ReturnType<typeof setup>, id: string, quantity: number, unitCostMinor: number, receivedAt: string) => {
  fixture.procurement.registerSupplier({ id: `supplier-${id}`, name: `Supplier ${id}`, defaultCurrency: "TRY" });
  fixture.procurement.createPurchase({
    id: `po-${id}`, supplierId: `supplier-${id}`, acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    lines: [{ id: `po-line-${id}`, productId: "part", quantity: String(quantity), quoteBasis: "piece", supplierUnitPriceMinor: unitCostMinor, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
  });
  const cost = fixture.procurement.finalizeAcquisitionCosts(`po-${id}`, { allocations: [] }).lots[0];
  return fixture.inventory.receiveCostedLot({
    receiptId: `receipt-${id}`, costSnapshotId: cost.id, receivedAt,
    location: { id: "pick", kind: "PICKING" }, operationId: `receive-${id}`,
  }).lot;
};

test("order snapshot freezes VAT-included economics, commission, FX, catalog and UNKNOWN expenses", () => {
  const fixture = setup();
  new ExchangeRateService(fixture.db).recordCurrentUsdTry({ rate: "40", source: "OWNER", changedAt: "2026-09-20T08:00:00.000Z", actorId: actor.id });
  const snapshot = fixture.finance.createOrderSnapshot({
    saleId: "sale", currency: "USD", sourceChannel: "Marketplace", discountMinor: 1,
    commissionRatePercent: "15", commissionCalculationBasis: "GROSS_BEFORE_DISCOUNT",
    commissionTerms: { source: "marketplace-settings", version: "terms-v1" },
    expenses: { shipping: { state: "KNOWN", amountMinor: 25, currency: "USD", provenance: { source: "quote", id: "Q1" } } },
    lines: [{ saleLineId: "sale-line", productId: "kit", quantity: 2, unitGrossMinor: 6_000, vatRateBps: 2_000 }],
    operationId: "sale-create", actor, createdAt: "2026-09-20T09:00:00.000Z",
  });

  assert.equal(snapshot.state, "COGS_PENDING");
  assert.deepEqual(snapshot.totals, {
    grossBeforeDiscountMinor: 12_000, discountMinor: 1, grossMinor: 11_999,
    vatMinor: 2_000, netRevenueMinor: 9_999, commissionMinor: 1_800,
    grossTryMinor: 479_960, vatTryMinor: 80_000, netRevenueTryMinor: 399_960,
    commissionTryMinor: 72_000, actualCogsTryMinor: null, grossProfitTryMinor: null,
    knownExpenseTryMinor: 1_000, provisionalNetContributionTryMinor: null, netContributionTryMinor: null,
  });
  assert.equal(snapshot.lines[0].catalogVersionRef.startsWith("catalog-product:"), true);
  assert.deepEqual(snapshot.lines[0].components.map((item) => ({ productId: item.productId, quantityBaseInt: item.quantityBaseInt })), [{ productId: "part", quantityBaseInt: 4 }]);
  assert.equal(snapshot.expenses.shipping.state, "KNOWN");
  assert.equal(snapshot.expenses.packaging.state, "UNKNOWN");
  assert.equal(snapshot.expenses.advertising.state, "UNKNOWN");
  assert.equal(snapshot.expenses.other.state, "UNKNOWN");

  new ExchangeRateService(fixture.db).recordCurrentUsdTry({ rate: "50", source: "OWNER", changedAt: "2026-09-20T10:00:00.000Z", actorId: actor.id });
  fixture.db.prepare("UPDATE products SET sale_price=999,purchase_cost=999,catalog_version=catalog_version+1 WHERE id='kit'").run();
  const frozen = fixture.finance.getSaleFinancial("sale");
  assert.deepEqual(frozen?.totals, snapshot.totals);
  assert.equal(frozen?.fx.numerator, 40);
  assert.equal(frozen?.commission.rate.numerator, 3);
  assert.equal(frozen?.commission.rate.denominator, 20);
  assert.throws(() => fixture.db.prepare("UPDATE sale_financial_snapshots SET net_revenue_minor=0 WHERE sale_id='sale'").run(), /immutable/i);
  fixture.db.close();
});

test("dispatch binds exact multi-lot BOM FIFO costs once and expense versions govern FINAL state", () => {
  const fixture = setup();
  new ExchangeRateService(fixture.db).recordCurrentUsdTry({ rate: "2", source: "OWNER", changedAt: "2026-09-20T07:00:00.000Z", actorId: actor.id });
  receive(fixture, "a", 3, 100, "2026-09-20T08:00:00.000Z");
  receive(fixture, "b", 3, 250, "2026-09-20T09:00:00.000Z");
  fixture.finance.createOrderSnapshot({
    saleId: "sale", currency: "USD", sourceChannel: "Direct", discountMinor: 0,
    commissionRatePercent: "10", commissionCalculationBasis: "GROSS_BEFORE_DISCOUNT", commissionTerms: { version: "direct-v1" },
    lines: [{ saleLineId: "sale-line", productId: "kit", quantity: 2, unitGrossMinor: 1_200, vatRateBps: 2_000 }],
    operationId: "sale-create", actor,
  });
  fixture.inventory.reserveOrder({ reservationId: "reservation", orderId: "sale", lines: [{ productId: "part", quantityBaseInt: 4 }], operationId: "reserve" });
  fixture.inventory.markPicked({ reservationId: "reservation", operationId: "pick" });
  fixture.inventory.markPacked({ reservationId: "reservation", operationId: "pack" });
  fixture.inventory.dispatchReservation({ reservationId: "reservation", shipmentId: "shipment", dispatchedAt: "2026-09-20T12:00:00.000Z", operationId: "dispatch" });

  const finalized = fixture.finance.finalizeDispatch({ reservationId: "reservation", operationId: "dispatch", actor, finalizedAt: "2026-09-20T12:00:00.000Z" });
  assert.equal(finalized?.state, "PROVISIONAL");
  assert.equal(finalized?.totals.actualCogsTryMinor, 550);
  assert.equal(finalized?.totals.grossProfitTryMinor, 3_450);
  assert.equal(finalized?.totals.netContributionTryMinor, null);
  assert.deepEqual(finalized?.lines[0].cogsAllocations.map((row) => ({ lotId: row.inventoryLotId, quantity: row.quantityBaseInt, cost: row.costTryMinor })), [
    { lotId: "inventory-lot:receipt-a", quantity: 3, cost: 300 },
    { lotId: "inventory-lot:receipt-b", quantity: 1, cost: 250 },
  ]);
  const replay = fixture.finance.finalizeDispatch({ reservationId: "reservation", operationId: "dispatch", actor, finalizedAt: "2026-09-20T12:00:00.000Z" });
  assert.equal(replay?.totals.actualCogsTryMinor, 550);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_allocations").pluck().get(), 2);
  fixture.db.prepare("UPDATE products SET purchase_cost=999,sale_price=999 WHERE id IN ('part','kit')").run();
  new ExchangeRateService(fixture.db).recordCurrentUsdTry({ rate: "9", source: "OWNER", changedAt: "2026-09-20T13:00:00.000Z", actorId: actor.id });
  assert.equal(fixture.finance.getSaleFinancial("sale")?.totals.grossProfitTryMinor, 3_450);

  for (const [index, category] of ["shipping", "packaging", "advertising", "other"].entries()) {
    fixture.finance.recordExpenseFact({ saleId: "sale", category: category as any, state: "KNOWN", amountMinor: index + 1, currency: "TRY", provenance: { source: "invoice", index }, operationId: `expense-${category}`, actor });
  }
  const complete = fixture.finance.getSaleFinancial("sale");
  assert.equal(complete?.state, "FINAL");
  assert.equal(complete?.totals.netContributionTryMinor, 2_960);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts").pluck().get(), 8);
  fixture.db.close();
});

test("pre-dispatch cancellation has no COGS and legacy sale is explicitly unsnapshotted", () => {
  const fixture = setup();
  assert.equal(fixture.finance.getSaleFinancial("sale")?.state, "LEGACY_UNSNAPSHOTTED");
  assert.equal(fixture.finance.finalizeDispatch({ reservationId: "missing", operationId: "dispatch", actor }), null);
  assert.equal(fixture.db.prepare("SELECT COUNT(*) FROM sale_financial_cogs_allocations").pluck().get(), 0);
  fixture.db.close();
});

test("line discount, VAT and FX rounding conserve immutable header totals", () => {
  const fixture = setup();
  fixture.db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price) VALUES ('sale-line-2','sale','part','Part',1,0)").run();
  new ExchangeRateService(fixture.db).recordCurrentUsdTry({ rate: "3.333333", source: "OWNER", changedAt: "2026-09-20T08:00:00.000Z", actorId: actor.id });
  const financial = fixture.finance.createOrderSnapshot({
    saleId: "sale", currency: "USD", sourceChannel: "Direct", discountMinor: 2,
    commissionRatePercent: "7.5", commissionCalculationBasis: "GROSS_AFTER_DISCOUNT", commissionTerms: { version: "rounding-v1" },
    lines: [
      { saleLineId: "sale-line", productId: "kit", quantity: 2, unitGrossMinor: 101, vatRateBps: 2_000 },
      { saleLineId: "sale-line-2", productId: "part", quantity: 1, unitGrossMinor: 99, vatRateBps: 2_000 },
    ],
    operationId: "sale-rounding", actor,
  });
  assert.equal(financial.lines.reduce((sum: number, line: any) => sum + line.discountMinor, 0), financial.totals.discountMinor);
  assert.equal(financial.lines.reduce((sum: number, line: any) => sum + line.grossMinor, 0), financial.totals.grossMinor);
  assert.equal(financial.totals.netRevenueMinor + financial.totals.vatMinor, financial.totals.grossMinor);
  assert.equal(financial.totals.netRevenueTryMinor + financial.totals.vatTryMinor, financial.totals.grossTryMinor);
  fixture.db.close();
});

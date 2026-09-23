import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService } from "../catalog/catalogService.js";
import { InventoryService } from "../inventory/inventoryService.js";
import { ProcurementService } from "../procurement/procurementService.js";
import { SalesFinancialService } from "../sales/salesFinancialService.js";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { WarehouseExecutionError, WarehouseExecutionService } from "../warehouse/warehouseExecutionService.js";
import { ReturnsService, ReturnsValidationError } from "./returnsService.js";
import { createReturnsV1Router } from "../../routes/returnsV1Routes.js";

const actor = { id: "return-owner", name: "Return Owner" };

const addOrderBlock = (db: Database.Database, orderId: string) => {
  const key = `order-${orderId}`.padEnd(64, "0").slice(0, 64);
  db.prepare("INSERT INTO reconciliation_runs (id,operation_id,trigger_type,actor_type,actor_id,status,started_at) VALUES (?,?,?,?,?,'COMPLETED',?)")
    .run(`block-run-${orderId}`, `block-op-${orderId}`, "MANUAL", "HUMAN", "admin", "2026-09-23T00:00:00Z");
  db.prepare(`INSERT INTO reconciliation_findings (id,identity_key,domain,code,severity,affected_type,affected_id,source_ref,expected_json,actual_json,status,repair_status,first_run_id,last_run_id,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,'ORDER',?,?,?,?,'OPEN','APPROVAL_REQUIRED',?,?,?,?)`).run(`block-finding-${orderId}`, key, "TEST", "TEST_ORDER_BLOCK", "CRITICAL", orderId, orderId, "{}", "{}", `block-run-${orderId}`, `block-run-${orderId}`, "2026-09-23T00:00:00Z", "2026-09-23T00:00:00Z");
  db.prepare("INSERT INTO reconciliation_blocks (id,finding_id,affected_type,affected_id,status,reason,created_at) VALUES (?,?, 'ORDER',?,'ACTIVE','TEST_ORDER_BLOCK',?)")
    .run(`block-${orderId}`, `block-finding-${orderId}`, orderId, "2026-09-23T00:00:00Z");
};

test("ORDER reconciliation block stops the affected return flow while an unrelated block does not", () => {
  const blocked = setup();
  addOrderBlock(blocked.db, "sale");
  assert.throws(() => blocked.service.createReturnRequest({ saleId: "sale", lines: [{ financialLineId: blocked.financialLineId, quantityBaseInt: 1, reasonCode: "DAMAGED" }], operationId: "blocked-return", actor }),
    (error: any) => error.code === "RECONCILIATION_SCOPE_BLOCKED");
  blocked.db.close();

  const unrelated = setup();
  addOrderBlock(unrelated.db, "some-other-order");
  assert.equal(unrelated.service.createReturnRequest({ saleId: "sale", lines: [{ financialLineId: unrelated.financialLineId, quantityBaseInt: 1, reasonCode: "DAMAGED" }], operationId: "allowed-return", actor }).saleId, "sale");
  unrelated.db.close();
});

const addLocation = (db: Database.Database, code: string, role: "PICKING" | "QUARANTINE") => {
  const rack = role === "PICKING" ? "S" : "Q";
  db.prepare("INSERT OR IGNORE INTO warehouse_topologies (id,name,code_template,config_json,config_hash,active) VALUES ('returns','Returns','{rack}','{}','returns',1)").run();
  db.prepare(`INSERT OR IGNORE INTO warehouse_rack_configs
    (id,topology_id,rack_code,level_count,position_count,depth_count,role,allow_mixed_sku,allow_mixed_lot,placement_priority,config_json)
    VALUES (?, 'returns',?,1,1,1,?,1,1,1,'{}')`).run(`rack-${rack}`, rack, role);
  db.prepare(`INSERT OR IGNORE INTO warehouse_level_configs
    (id,topology_id,rack_code,level_number,role,allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES (?, 'returns',?,1,?,1,1,1)`).run(`level-${rack}`, rack, role);
  db.prepare(`INSERT OR IGNORE INTO warehouse_position_configs
    (id,topology_id,rack_code,level_number,position_number,role,allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES (?, 'returns',?,1,1,?,1,1,1)`).run(`position-${rack}`, rack, role);
  db.prepare(`INSERT OR IGNORE INTO warehouse_location_slots
    (id,topology_id,code,rack_code,level_number,position_number,depth_code,depth_index,is_front,role,
     allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES (?, 'returns',?,?,1,1,'A',0,1,?,1,1,1)`).run(code, code, rack, role);
};

const setup = (sourceChannel = "Direct", saleId = "sale") => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: `part-${saleId}`, sku: `PART-${saleId}`, title: "Part", catalog_type: "product", base_uom_code: "piece" });
  catalog.createProduct({ id: `kit-${saleId}`, sku: `KIT-${saleId}`, title: "Kit", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO product_bom (id,parent_product_id,component_product_id,quantity_per_unit,component_role) VALUES (?,?,?,?,?)")
    .run(`bom-${saleId}`, `kit-${saleId}`, `part-${saleId}`, 2, "BODY");
  db.prepare("INSERT INTO cash_accounts (id,name,currency,type) VALUES (?,?,?,?)")
    .run(`original-${saleId}`, "Original", "TRY", sourceChannel === "Trendyol" ? "platform" : "cash");
  db.prepare("INSERT INTO cash_accounts (id,name,currency,type) VALUES (?,?,?,?)").run(`refund-${saleId}`, "Refund", "TRY", "bank");
  db.prepare("INSERT INTO sales (id,order_code,total_amount,platform,cash_account_id) VALUES (?,?,?,?,?)")
    .run(saleId, `ORDER-${saleId}`, 0, sourceChannel, `original-${saleId}`);
  db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity,unit_price) VALUES (?,?,?,?,?,0)")
    .run(`sale-line-${saleId}`, saleId, `kit-${saleId}`, "Kit", 3);
  const procurement = new ProcurementService(db);
  const inventory = new InventoryService(db);
  const receive = (suffix: string, quantity: number, unitCost: number, receivedAt: string) => {
    procurement.registerSupplier({ id: `supplier-${saleId}-${suffix}`, name: `Supplier ${suffix}`, defaultCurrency: "TRY" });
    procurement.createPurchase({
      id: `po-${saleId}-${suffix}`, supplierId: `supplier-${saleId}-${suffix}`, acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
      lines: [{ id: `po-line-${saleId}-${suffix}`, productId: `part-${saleId}`, quantity: String(quantity), quoteBasis: "piece", supplierUnitPriceMinor: unitCost, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
    });
    const cost = procurement.finalizeAcquisitionCosts(`po-${saleId}-${suffix}`, { allocations: [] }).lots[0];
    inventory.receiveCostedLot({ receiptId: `receipt-${saleId}-${suffix}`, costSnapshotId: cost.id, receivedAt,
      location: { id: `dispatch-${saleId}`, kind: "PICKING" }, operationId: `receive-${saleId}-${suffix}` });
  };
  receive("a", 3, 100, "2026-09-20T08:00:00.000Z");
  receive("b", 3, 250, "2026-09-20T09:00:00.000Z");
  const finance = new SalesFinancialService(db);
  finance.createOrderSnapshot({ saleId, currency: "TRY", sourceChannel, discountMinor: 1, commissionRatePercent: "10",
    commissionCalculationBasis: "GROSS_AFTER_DISCOUNT", commissionTerms: { channel: sourceChannel, version: "accepted-v2-09" },
    expenses: { shipping: { state: "KNOWN", amountMinor: 77, currency: "TRY", provenance: { source: "seller-invoice" } },
      packaging: { state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: { source: "test" } },
      other: { state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: { source: "test" } } },
    lines: [{ saleLineId: `sale-line-${saleId}`, productId: `kit-${saleId}`, quantity: 3, unitGrossMinor: 1_200, vatRateBps: 2_000 }],
    operationId: `sale-create-${saleId}`, actor });
  inventory.reserveOrder({ reservationId: `reservation-${saleId}`, orderId: saleId,
    lines: [{ productId: `part-${saleId}`, quantityBaseInt: 6 }], operationId: `reserve-${saleId}` });
  inventory.markPicked({ reservationId: `reservation-${saleId}`, operationId: `pick-${saleId}` });
  inventory.markPacked({ reservationId: `reservation-${saleId}`, operationId: `pack-${saleId}` });
  inventory.dispatchReservation({ reservationId: `reservation-${saleId}`, shipmentId: `shipment-${saleId}`,
    dispatchedAt: "2026-09-20T12:00:00.000Z", operationId: `dispatch-${saleId}` });
  finance.finalizeDispatch({ reservationId: `reservation-${saleId}`, operationId: `dispatch-${saleId}`, actor });
  addLocation(db, `SELL-${saleId}`, "PICKING");
  addLocation(db, `QUAR-${saleId}`, "QUARANTINE");
  return { db, service: new ReturnsService(db), financialLineId: db.prepare("SELECT id FROM sale_financial_lines WHERE sale_line_id=?").pluck().get(`sale-line-${saleId}`) as string };
};

test("partial BOM returns conserve original money/FIFO and receipt dispositions post only inspected stock/loss", () => {
  const { db, service, financialLineId } = setup();
  const originalSellerShipping = db.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE category='SHIPPING'").pluck().get();
  const originalCashCount = db.prepare("SELECT COUNT(*) FROM cash_transactions").pluck().get();
  const originalOnHand = db.prepare("SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id='part-sale'").pluck().get();
  const create = (suffix: string, reasonCode: any = "CUSTOMER_CHANGED_MIND", shipping = 0) => service.createReturnRequest({
    saleId: "sale", lines: [{ financialLineId, quantityBaseInt: 1, reasonCode }],
    customerShippingRefund: { selected: shipping > 0, amountMinor: shipping }, operationId: `return-${suffix}`, actor,
  });

  const sellable = create("sellable", "CUSTOMER_CHANGED_MIND", 100);
  assert.equal(db.prepare("SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id='part-sale'").pluck().get(), originalOnHand);
  assert.equal(db.prepare("SELECT COUNT(*) FROM cash_transactions").pluck().get(), originalCashCount);
  assert.equal(sellable.lines[0].cogs.reduce((sum: number, row: any) => sum + row.costTryMinor, 0), 200);
  assert.equal(sellable.financialReversal.netMinor + sellable.financialReversal.vatMinor, sellable.financialReversal.grossMinor);

  const missing = create("missing", "MISSING_PART");
  const damaged = create("damaged", "DAMAGED");
  assert.equal(missing.lines[0].cogs.reduce((sum: number, row: any) => sum + row.costTryMinor, 0), 350);
  assert.equal(damaged.lines[0].cogs.reduce((sum: number, row: any) => sum + row.costTryMinor, 0), 500);
  const conserved = [sellable, damaged, missing].reduce((totals, item) => ({
    grossBeforeDiscountMinor: totals.grossBeforeDiscountMinor + item.financialReversal.grossBeforeDiscountMinor,
    discountMinor: totals.discountMinor + item.financialReversal.discountMinor,
    grossMinor: totals.grossMinor + item.financialReversal.grossMinor,
    vatMinor: totals.vatMinor + item.financialReversal.vatMinor,
    netMinor: totals.netMinor + item.financialReversal.netMinor,
  }), { grossBeforeDiscountMinor: 0, discountMinor: 0, grossMinor: 0, vatMinor: 0, netMinor: 0 });
  assert.deepEqual(conserved, db.prepare(`SELECT gross_before_discount_minor AS grossBeforeDiscountMinor,
    discount_minor AS discountMinor,gross_amount_minor AS grossMinor,vat_amount_minor AS vatMinor,
    net_revenue_minor AS netMinor FROM sale_financial_snapshots WHERE sale_id='sale'`).get());
  assert.throws(() => create("over"), (error: any) => error instanceof ReturnsValidationError && error.code === "RETURN_QUANTITY_EXCEEDED");

  db.prepare("UPDATE products SET purchase_cost=99999 WHERE id='part-sale'").run();
  const receiptPayload = { returnId: sellable.id, lines: [{ returnLineId: sellable.lines[0].id, quantityBaseInt: 1, disposition: "SELLABLE" as const, locationId: "SELL-sale" }], operationId: "receive-sellable", actor };
  const command = new CommandExecutor(db);
  const receiptCommand = { operationId: "receive-sellable", commandType: "returns.receipt.inspect.v1", payload: receiptPayload,
    actor: { human: actor }, authorization: { decision: "ALLOW" as const, capability: "warehouse:accept_returns" } };
  const received = command.execute(receiptCommand, () => ({ statusCode: 201, body: service.receiveReturn(receiptPayload) })).result.body as any;
  const replay = command.execute(receiptCommand, () => { throw new Error("return receipt replay executed"); });
  assert.deepEqual(replay.result.body, received);
  const afterSellable = Number(db.prepare("SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id='part-sale'").pluck().get());
  assert.equal(afterSellable, Number(originalOnHand) + 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RETURN'").pluck().get(), 1);
  const returnPackage = db.prepare(`SELECT origin_type,receipt_id,return_receipt_id,return_receipt_inventory_allocation_id,
    origin_inventory_lot_id,inventory_lot_id,acquisition_cost_snapshot_id,remaining_quantity_base_int,disposition,status,current_slot_id
    FROM warehouse_execution_packages WHERE origin_type='RETURN_RECEIPT' AND disposition='ACCEPTED'`).get() as any;
  assert.equal(returnPackage.receipt_id, null);
  assert.equal(returnPackage.origin_inventory_lot_id, returnPackage.inventory_lot_id);
  assert.equal(returnPackage.remaining_quantity_base_int, 2);
  assert.equal(returnPackage.current_slot_id, "SELL-sale");
  assert.equal(db.prepare("SELECT COUNT(*) FROM warehouse_execution_packages WHERE origin_type='RETURN_RECEIPT' AND disposition='ACCEPTED'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM warehouse_package_movements_v2 WHERE package_id LIKE 'return-package:%'").pluck().get(), 1);
  assert.deepEqual(new WarehouseExecutionService(db).getReconciliation("part-sale"), {
    productId: "part-sale", lotOnHandBaseInt: 2, ledgerOnHandBaseInt: 2, locationOnHandBaseInt: 2,
    packageOnHandBaseInt: 2, centralStockProjectionBaseInt: 2, reconciled: true,
  });

  service.receiveReturn({ returnId: missing.id, lines: [{ returnLineId: missing.lines[0].id, quantityBaseInt: 1, disposition: "MISSING_NOT_RECEIVED" }], operationId: "receive-missing", actor });
  const damagedResult = service.receiveReturn({ returnId: damaged.id, lines: [{ returnLineId: damaged.lines[0].id, quantityBaseInt: 1, disposition: "DAMAGED", locationId: "QUAR-sale" }], operationId: "receive-damaged", actor });
  assert.equal(damagedResult.returnLossTryMinor, 500);
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_quarantine_facts").pluck().get(), 1);
  assert.deepEqual(db.prepare(`SELECT disposition,status,current_slot_id,inventory_lot_id,origin_inventory_lot_id,
    acquisition_cost_snapshot_id,remaining_quantity_base_int FROM warehouse_execution_packages
    WHERE origin_type='RETURN_RECEIPT' AND disposition='DAMAGED'`).get(), {
    disposition: "DAMAGED", status: "QUARANTINE", current_slot_id: "QUAR-sale", inventory_lot_id: null,
    origin_inventory_lot_id: damaged.lines[0].cogs[0].inventoryLotId,
    acquisition_cost_snapshot_id: damaged.lines[0].cogs[0].acquisitionCostSnapshotId,
    remaining_quantity_base_int: 2,
  });
  assert.equal(Number(db.prepare("SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id='part-sale'").pluck().get()), afterSellable);
  assert.equal(new WarehouseExecutionService(db).getReconciliation("part-sale").reconciled, true);
  assert.equal(Number(db.prepare("SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id='part-sale'").pluck().get()), afterSellable);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE category='SHIPPING'").pluck().get(), originalSellerShipping);
  assert.equal(db.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE category='ADVERTISING'").pluck().get(), 0);
  assert.throws(() => db.prepare("UPDATE return_requests SET requested_by_actor_id='changed' WHERE id=?").run(sellable.id), /immutable/i);

  const firstRefund = service.approveRefund({ returnId: sellable.id, amountMinor: 600, cashAccountId: "refund-sale", approvalReference: "APPROVAL-1", operationId: "refund-1", actor });
  const remaining = firstRefund.refundable.remainingMinor;
  const completeRefund = service.approveRefund({ returnId: sellable.id, amountMinor: remaining, cashAccountId: "refund-sale", approvalReference: "APPROVAL-2", operationId: "refund-2", actor });
  assert.equal(completeRefund.refundable.remainingMinor, 0);
  assert.throws(() => service.approveRefund({ returnId: sellable.id, amountMinor: 1, cashAccountId: "refund-sale", approvalReference: "OVER", operationId: "refund-over", actor }),
    (error: any) => error.code === "REFUND_AMOUNT_EXCEEDED");
  assert.equal(db.prepare("SELECT COUNT(*) FROM refund_cash_postings").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM cash_transactions WHERE source_type='v2_return_refund_projection'").pluck().get(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM marketplace_commission_reversal_facts WHERE state='PENDING_SETTLEMENT'").pluck().get(), 0);
  db.close();
});

test("SELLABLE return placement rejects inactive, full, and mixed-lot destinations atomically", () => {
  const { db, service, financialLineId } = setup("Direct", "policy");
  db.prepare("UPDATE warehouse_location_slots SET allow_mixed_lot=0 WHERE id='SELL-policy'").run();
  db.prepare("UPDATE warehouse_position_configs SET allow_mixed_lot=0 WHERE id='position-S'").run();
  db.prepare(`INSERT INTO warehouse_location_slots
    (id,topology_id,code,rack_code,level_number,position_number,depth_code,depth_index,is_front,role,
     allow_mixed_sku,allow_mixed_lot,placement_priority)
    VALUES ('SELL-policy-REAR','returns','SELL-policy-REAR','S',1,1,'B',1,0,'PICKING',1,0,1)`).run();
  const request = (suffix: string) => service.createReturnRequest({
    saleId: "policy", lines: [{ financialLineId, quantityBaseInt: 1, reasonCode: "WRONG_PRODUCT" }],
    operationId: `policy-request-${suffix}`, actor,
  });
  const first = request("first");
  const middle = request("middle");
  const last = request("last");
  const receiveSellable = (item: any, locationId: string, operationId: string) => service.receiveReturn({
    returnId: item.id,
    lines: [{ returnLineId: item.lines[0].id, quantityBaseInt: 1, disposition: "SELLABLE", locationId }],
    operationId,
    actor,
  });
  const before = new WarehouseExecutionService(db).getReconciliation("part-policy");

  db.prepare("UPDATE warehouse_location_slots SET active=0 WHERE id='SELL-policy'").run();
  assert.throws(() => receiveSellable(first, "SELL-policy", "policy-inactive"),
    (error: any) => error instanceof WarehouseExecutionError && error.code === "LOCATION_POLICY_VIOLATION");
  assert.deepEqual(new WarehouseExecutionService(db).getReconciliation("part-policy"), before);
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_receipts").pluck().get(), 0);
  db.prepare("UPDATE warehouse_location_slots SET active=1 WHERE id='SELL-policy'").run();

  receiveSellable(first, "SELL-policy", "policy-first");
  const afterFirst = new WarehouseExecutionService(db).getReconciliation("part-policy");
  assert.equal(afterFirst.reconciled, true);
  assert.throws(() => receiveSellable(middle, "SELL-policy", "policy-full"),
    (error: any) => error instanceof WarehouseExecutionError && error.code === "LOCATION_POLICY_VIOLATION");
  assert.deepEqual(new WarehouseExecutionService(db).getReconciliation("part-policy"), afterFirst);

  service.receiveReturn({
    returnId: middle.id,
    lines: [{ returnLineId: middle.lines[0].id, quantityBaseInt: 1, disposition: "MISSING_NOT_RECEIVED" }],
    operationId: "policy-middle-missing",
    actor,
  });
  assert.throws(() => receiveSellable(last, "SELL-policy-REAR", "policy-mixed-lot"),
    (error: any) => error instanceof WarehouseExecutionError && error.code === "LOCATION_POLICY_VIOLATION");
  assert.deepEqual(new WarehouseExecutionService(db).getReconciliation("part-policy"), afterFirst);
  assert.equal(db.prepare("SELECT COUNT(*) FROM warehouse_execution_packages WHERE origin_type='RETURN_RECEIPT'").pluck().get(), 1);
  db.close();
});

test("marketplace refund stays in settlement/receivable and never posts physical cash", () => {
  const { db, service, financialLineId } = setup("Trendyol", "market");
  const request = service.createReturnRequest({ saleId: "market", lines: [{ financialLineId, quantityBaseInt: 1, reasonCode: "WRONG_PRODUCT" }],
    operationId: "market-return", actor });
  service.receiveReturn({ returnId: request.id, lines: [{ returnLineId: request.lines[0].id, quantityBaseInt: 1, disposition: "MISSING_NOT_RECEIVED" }], operationId: "market-inspect", actor });
  const cashBefore = db.prepare("SELECT COUNT(*) FROM cash_transactions").pluck().get();
  const result = service.approveRefund({ returnId: request.id, amountMinor: request.refundable.maximumMinor, approvalReference: "MARKET-APPROVAL", operationId: "market-refund", actor });
  assert.equal(result.refunds[0].paymentMode, "MARKETPLACE_SETTLEMENT");
  assert.equal(result.refundMode, "MARKETPLACE_SETTLEMENT");
  assert.equal(result.commissionReversalState, "PENDING_SETTLEMENT");
  assert.equal(db.prepare("SELECT COUNT(*) FROM cash_transactions").pluck().get(), cashBefore);
  assert.equal(db.prepare("SELECT COUNT(*) FROM refund_cash_postings").pluck().get(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM refund_settlement_postings WHERE state='PENDING_SETTLEMENT'").pluck().get(), 1);
  db.close();
});

test("pre-dispatch is cancellation and legacy return facts remain explicitly unknown", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "product", sku: "PRODUCT", title: "Product", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO sales (id,order_code,platform,status) VALUES ('legacy','LEGACY','Direct','İade Edildi')").run();
  db.prepare("INSERT INTO sales (id,order_code,platform) VALUES ('pending','PENDING','Direct')").run();
  db.prepare("INSERT INTO sale_items (id,sale_id,product_id,product_name,quantity) VALUES ('pending-line','pending','product','Product',1)").run();
  new SalesFinancialService(db).createOrderSnapshot({ saleId: "pending", currency: "TRY", sourceChannel: "Direct", discountMinor: 0,
    commissionRatePercent: "0", commissionCalculationBasis: "GROSS_AFTER_DISCOUNT", commissionTerms: {},
    lines: [{ saleLineId: "pending-line", productId: "product", quantity: 1, unitGrossMinor: 100, vatRateBps: 0 }], operationId: "pending-sale", actor });
  const service = new ReturnsService(db);
  assert.equal(service.getSaleReturns("legacy").legacyUnknown, true);
  const financialLineId = db.prepare("SELECT id FROM sale_financial_lines WHERE sale_line_id='pending-line'").pluck().get() as string;
  assert.throws(() => service.createReturnRequest({ saleId: "pending", lines: [{ financialLineId, quantityBaseInt: 1, reasonCode: "OTHER", explanation: "test" }], operationId: "pending-return", actor }),
    (error: any) => error.code === "PRE_DISPATCH_USE_CANCELLATION");
  db.close();
});

test("real Panel return route enforces authorization and idempotent replay/mismatch", async () => {
  const { db, financialLineId } = setup("Direct", "route");
  const allow: express.RequestHandler = (_req, _res, next) => next();
  const deny: express.RequestHandler = (_req, res) => { res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } }); };
  const build = (authorizeCreate: express.RequestHandler) => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: "owner", username: "Owner" } as typeof req.user; next(); });
    app.use("/api/returns/v1", createReturnsV1Router({ db, authorizeRead: allow, authorizeCreate, authorizeRefund: allow }));
    return app.listen(0);
  };
  const body = { lines: [{ financialLineId, quantityBaseInt: 1, reasonCode: "INCOMPATIBLE" }], customerShippingRefund: { selected: false, amountMinor: 0 } };
  const deniedServer = build(deny); await new Promise<void>((resolve) => deniedServer.once("listening", resolve));
  const deniedAddress = deniedServer.address(); assert.ok(deniedAddress && typeof deniedAddress !== "string");
  const denied = await fetch(`http://127.0.0.1:${deniedAddress.port}/api/returns/v1/sales/route`, { method: "POST", headers: { "content-type": "application/json", "x-operation-id": "denied" }, body: JSON.stringify(body) });
  assert.equal(denied.status, 403); assert.equal(db.prepare("SELECT COUNT(*) FROM return_requests").pluck().get(), 0);
  await new Promise<void>((resolve) => deniedServer.close(() => resolve()));

  const server = build(allow); await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const post = (payload: unknown) => fetch(`http://127.0.0.1:${address.port}/api/returns/v1/sales/route`, { method: "POST", headers: { "content-type": "application/json", "x-operation-id": "route-return" }, body: JSON.stringify(payload) });
  const first = await post(body); const replay = await post(body); const mismatch = await post({ ...body, customerShippingRefund: { selected: true, amountMinor: 1 } });
  assert.equal(first.status, 201); assert.equal((await replay.json() as any).idempotent, true); assert.equal(mismatch.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) FROM return_requests").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='returns.request.create.v1'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_outbox WHERE event_type='returns.request.approved.v1'").pluck().get(), 1);
  await new Promise<void>((resolve) => server.close(() => resolve())); db.close();
});

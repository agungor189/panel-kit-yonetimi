import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcurementImport, expandSourcePackages } from './procurementImport.js';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/initialize.js';
import { CatalogService } from '../catalog/catalogService.js';
import { ProcurementImportService, type ImportRequest, type ImportCostDecision } from './procurementImportService.js';
import { ProcurementService } from './procurementService.js';
import { ExchangeRateService } from '../finance/exchangeRates.js';
import { CommandExecutor } from '../commands/commandFoundation.js';
import { WarehouseExecutionService } from '../warehouse/warehouseExecutionService.js';
import { productPackages } from '../warehouse/productPackages.js';
import { finalLandedCostSource } from '../pricing/finalLandedCostSource.js';
import { ProductPricingService } from '../pricing/productPricingService.js';
import { InventoryService } from '../inventory/inventoryService.js';
import { PrintingService } from '../printing/printingService.js';

const rows = () => [
  { record_type: 'PURCHASE', record_id: 'p', invoice_number: 'SYNTHETIC', invoice_date: '2026-01-01', supplier_name: 'Fixture', currency: 'USD' },
  { record_type: 'PRODUCT', record_id: 'a', parent_ref: 'p', sku: 'A', product_type: 'component', uom: 'piece', name_en: 'Fixture part' },
  { record_type: 'LINE', record_id: 'l', parent_ref: 'p', product_ref: 'a', sku: 'A', quantity: '100', unit_price: '2', amount: '200', currency: 'USD', uom: 'piece', pricing_basis: 'BILLED' },
  { record_type: 'PACKAGE_GROUP', record_id: 'g1', parent_ref: 'p', package_count: '3', gross_weight_kg: '6', net_weight_kg: '5', meta_json: '{"mixed":false}' },
  { record_type: 'PACKAGE_GROUP', record_id: 'g2', parent_ref: 'p', package_count: '1', gross_weight_kg: '1', net_weight_kg: '0.5', meta_json: '{"mixed":false}' },
  { record_type: 'PACKAGE_ITEM', record_id: 'i1', parent_ref: 'g1', product_ref: 'a', purchase_line_ref: 'l', sku: 'A', quantity: '90', units_per_package: '30', uom: 'piece' },
  { record_type: 'PACKAGE_ITEM', record_id: 'i2', parent_ref: 'g2', product_ref: 'a', purchase_line_ref: 'l', sku: 'A', quantity: '10', units_per_package: '10', uom: 'piece' },
].map(r => ({ schema_version: 'dsdst.procurement.import.v1', ...r }));
export function fixtureCsv(input: any[] = rows()) {
  const keys = [...new Set(input.flatMap(Object.keys))];
  const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  return '\ufeff' + keys.map(cell).join(',') + '\r\n' + input.map(r => keys.map(k => cell(r[k])).join(',')).join('\r\n');
}
test('source packages preserve 3 × 30 + 1 × 10 without stock or weight multiplication', () => {
  const parsed = parseProcurementImport(fixtureCsv());
  assert.deepEqual(expandSourcePackages(parsed).map(p => p.quantity), ['30', '30', '30', '10']);
  assert.equal(parsed.summary.sourceCartons, 4);
  assert.equal(parsed.summary.grossWeightKg, '7');
});
test('record references, SKU contradictions, duplicate IDs and blank quantities fail closed', () => {
  for (const change of [ { product_ref: 'missing' }, { sku: 'WRONG' }, { quantity: '' }, { record_id: 'p' } ]) {
    const data = rows(); Object.assign(data[2], change);
    assert.throws(() => parseProcurementImport(fixtureCsv(data)));
  }
});
test('registered SKU can be supplied without PRODUCT or BOM', () => {
  const data = rows().filter(r => r.record_type !== 'PRODUCT').map(r => ({ ...r, product_ref: '' }));
  assert.equal(parseProcurementImport(fixtureCsv(data)).lines[0].sku, 'A');
});

const setup = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initializeDatabase(db);
  const procurement = new ProcurementService(db), importer = new ProcurementImportService(db), catalog = new CatalogService(db);
  procurement.registerSupplier({ id: 'supplier', name: 'Fixture', defaultCurrency: 'USD' });
  new ExchangeRateService(db).recordCurrentUsdTry({ rate: '40', source: 'MANUAL', changedAt: '2026-01-01T00:00:00.000Z', actorId: 'tester' });
  const request = (data = rows()): ImportRequest => {
    const input: ImportRequest = { csv: fixtureCsv(data), supplierId: 'supplier' };
    input.expectedPreviewHash = importer.preview(input).previewHash;
    return input;
  };
  const decision: ImportCostDecision = { vatMode: 'EXCLUDED', vatRateBps: 0, acquisitionCostVatPolicy: 'VAT_EXCLUDED_FROM_INVENTORY_COST', includedCost: 'NO_SEPARATE_CHARGE', stockCheck: 'NO_PRIOR_RECEIPT', stockEvidence: 'Synthetic empty database' };
  const execute = (key: string, input: ImportRequest) => new CommandExecutor(db).execute<any>({ operationId: key, commandType: 'procurement.import.apply.v1', payload: input, actor: { human: { id: 'tester' } }, authorization: { decision: 'ALLOW', capability: 'procurement:write+catalog:write' } }, () => {
    const draft = importer.apply(input, 'tester');
    return { statusCode: 201, body: draft.costDecisionPending ? importer.completeDraft(draft.id, decision, 'tester') as any : draft };
  });
  return { db, procurement, importer, catalog, request, execute, decision };
};

test('CSV apply creates only catalog and incomplete purchase intent; financial purchase waits for explicit cost decision', () => {
  const { db, importer, request, decision } = setup();
  const input = request();
  const draft = importer.apply(input, 'tester');
  assert.equal(draft.status, 'INCOMPLETE');
  assert.equal(draft.totalGrossMinor, null);
  assert.equal(draft.lines.length, 1);
  assert.equal(importer.apply(input, 'tester').id, draft.id);
  for (const table of ['purchase_orders','purchase_order_lines','procurement_imports','procurement_package_plan','inventory_ledger_events','cash_transactions'])
    assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  assert.equal(db.prepare('SELECT COUNT(*) FROM products').pluck().get(), 1);
  assert.equal(importer.listDrafts().length, 1);
  assert.throws(() => importer.completeDraft(draft.id, { ...decision, stockEvidence: '' }, 'tester'), /DECISION REQUIRED/);
  assert.throws(() => importer.completeDraft(draft.id, { ...decision, includedCost: '' } as any, 'tester'), /DECISION REQUIRED/);
  assert.throws(() => importer.apply({ ...input, policy: decision } as any, 'tester'), /Maliyet kararları CSV importunda alınmaz/);
  const purchase = importer.completeDraft(draft.id, decision, 'tester');
  assert.equal(purchase.lines.length, 1);
  assert.equal(importer.completeDraft(draft.id, decision, 'tester').id, purchase.id);
  assert.equal(importer.listDrafts().length, 0);
  db.close();
});

test('preview is read-only; import is atomic, invoice/source/operation replay-safe and preserves four packages', () => {
  const { db, importer, request, execute } = setup();
  const input = request();
  assert.equal(db.prepare('SELECT COUNT(*) FROM products').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get(), 0);
  const first = execute('import-1', input);
  assert.equal(execute('import-1', input).replayed, true);
  assert.equal(execute('import-2', input).result.body.id, first.result.body.id);
  assert.throws(() => execute('import-1', { ...input, supplierId: 'other' }), /different canonical payload/);
  assert.throws(() => importer.apply({ ...input, csv: input.csv.replace('Fixture part', 'Fixture renamed') }, 'tester'), /farklı içerikle/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_package_plan').pluck().get(), 4);
  assert.equal(db.prepare('SELECT COUNT(*) FROM inventory_ledger_events').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_import_records').pluck().get(), rows().length);
  db.close();
});

test('missing FX leaves an incomplete draft and blocks financial purchase completion', () => {
  const { db, request, importer, decision } = setup();
  const input = request();
  input.csv = input.csv.replaceAll('USD', 'EUR');
  input.expectedPreviewHash = importer.preview(input).previewHash;
  const draft = importer.apply(input, 'tester');
  assert.equal(draft.status, 'INCOMPLETE');
  assert.throws(() => importer.completeDraft(draft.id, decision, 'tester'));
  for (const table of ['purchase_orders','procurement_imports','procurement_package_plan']) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  assert.equal(db.prepare('SELECT COUNT(*) FROM products').pluck().get(), 1);
  db.close();
});

test('plan binds packages to exact line/cost; one receipt activates physical components without selling; read-only totals exclude pending and empty', () => {
  const { db, procurement, request, execute } = setup();
  const purchase: any = execute('create', request()).result.body;
  const productId = purchase.lines[0].productId;
  assert.deepEqual(productPackages(db, productId).planned.map(p => p.remaining), [30,30,30,10]);
  assert.equal(productPackages(db, productId).physicalCount, 0);
  procurement.finalizeAcquisitionCosts(purchase.id, { allocations: [] }); procurement.approveForReceipt(purchase.id, 'tester');
  const intent = procurement.listReceiptReady()[0], plan = intent.packagePlan!;
  const warehouse = new WarehouseExecutionService(db);
  const input = { receiptId: 'receipt', receiptSeriesId: 'receipt', stageIndex: 1, isFinal: true, costSnapshotId: intent.costSnapshotId,
    supplierLotCode: 'FIXTURE-LOT', acceptedQuantityBaseInt: 100, damagedQuantityBaseInt: 0, receivedAt: '2026-01-02T00:00:00Z', operationId: 'receive', planVersion: plan.version,
    packages: plan.packages.map(p => ({ id: p.id, code: p.code, quantityBaseInt: p.quantityBaseInt, targetQuantityBaseInt: p.quantityBaseInt })) };
  assert.throws(() => warehouse.receiveGoods({ ...input, planVersion: 'wrong' }), /sürümü/);
  assert.throws(() => warehouse.receiveGoods({ ...input, packages: input.packages.map((p,i) => i ? p : { ...p, id: 'wrong-line' }) }), /maliyet bağı/);
  assert.throws(() => new InventoryService(db).receiveCostedLot({ receiptId: 'bypass', costSnapshotId: intent.costSnapshotId, receivedAt: input.receivedAt, operationId: 'bypass', location: { id: 'x', kind: 'RESERVE' } }), /package receipt/);
  const command = () => new CommandExecutor(db).execute<any>({ operationId: 'receive', commandType: 'warehouse.goods-receipt.accept.v1', payload: input, actor: { human: { id: 'tester' } }, authorization: { decision: 'ALLOW', capability: 'warehouse:receive' } }, () => ({ statusCode: 200, body: warehouse.receiveGoods(input) as any }));
  command(); assert.equal(command().replayed, true);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  assert.deepEqual(db.prepare('SELECT central_stock,status,is_sellable,procurement_activation_pending FROM products WHERE id=?').get(productId), { central_stock: 100, status: 'Passive', is_sellable: 0, procurement_activation_pending: 0 });
  const view = productPackages(db, productId);
  assert.equal(view.physicalCount, 4); assert.equal(view.remainingQuantity, 100); assert.deepEqual(view.distribution, [{ count: 3, quantity: 30 }, { count: 1, quantity: 10 }]); assert.equal(view.planned.length, 0);
  const snapshot = new PrintingService(db).packageSnapshot(plan.packages[0].id);
  assert.equal(snapshot.payload.Package_code, plan.packages[0].code); assert.ok('Kaynak_koli' in snapshot.payload && snapshot.payload.Kaynak_koli);
  db.prepare('UPDATE warehouse_execution_packages SET remaining_quantity_base_int=0 WHERE id=?').run(plan.packages[0].id);
  assert.equal(productPackages(db, productId).physicalCount, 3); assert.equal(productPackages(db, productId).physical.length, 4);
  db.close();
});

test('same-SKU prices use weighted FINAL sources; BOM uses component FINAL only and invalidates stale pricing', () => {
  const { db, catalog, procurement } = setup();
  const part = catalog.createProduct({ sku: 'PART', title: 'Part', catalog_type: 'product', base_uom_code: 'piece', product_type: 'component' });
  const assembly = catalog.createProduct({ sku: 'ASSEMBLY', title: 'Assembly', catalog_type: 'product', base_uom_code: 'piece', product_type: 'assembly' });
  catalog.replaceBom(assembly.id, catalog.readBom(assembly.id).version, [{ componentId: part.id, quantity: 2 }]);
  assert.equal(finalLandedCostSource(db, assembly.id), null);
  const purchase = procurement.createPurchase({ supplierId: 'supplier', acquisitionCostVatPolicy: 'VAT_EXCLUDED_FROM_INVENTORY_COST', lines: [
    { productId: part.id, quantity: '3', quoteBasis: 'piece', supplierUnitPriceMinor: 100, currency: 'USD', vatMode: 'EXCLUDED', vatRateBps: 0 },
    { productId: part.id, quantity: '1', quoteBasis: 'piece', supplierUnitPriceMinor: 300, currency: 'USD', vatMode: 'EXCLUDED', vatRateBps: 0 },
  ] });
  procurement.finalizeAcquisitionCosts(purchase.id, { allocations: [] });
  const cost = finalLandedCostSource(db, part.id)!;
  assert.equal(cost.numerator / cost.denominator, 6000); assert.equal(cost.sources.length, 2); assert.match(cost.reference, /^purchase-final:/);
  const bomCost = finalLandedCostSource(db, assembly.id)!;
  assert.equal(bomCost.numerator / bomCost.denominator, 12000);
  assert.equal(productPackages(db, assembly.id).bomTracked, true); assert.equal(productPackages(db, assembly.id).physicalCount, 0);
  catalog.updateProduct(assembly.id, catalog.getProduct(assembly.id)!.catalog_version, { sku: 'ASSEMBLY', title: 'Renamed assembly', catalog_type: 'product', base_uom_code: 'piece', product_type: 'assembly' });
  assert.equal(finalLandedCostSource(db, assembly.id)!.reference, bomCost.reference);
  new ProductPricingService(db).applyMany({ approvals: [{ productId: assembly.id, approvedSalePrice: 120, expectedLandedCostSnapshotId: bomCost.reference, expectedLandedCostNumerator: bomCost.numerator, expectedLandedCostDenominator: bomCost.denominator, expectedPriceLocked: false, expectedSalePrice: 0 }], settings: { bufferPercentage: 0, profitPercentage: 0 }, reason: 'same-record rename and price', operationId: 'rename-price' });
  catalog.replaceBom(assembly.id, catalog.readBom(assembly.id).version, [{ componentId: part.id, quantity: 3 }]);
  assert.notEqual(finalLandedCostSource(db, assembly.id)!.reference, bomCost.reference);
  assert.throws(() => new ProductPricingService(db).applyMany({ approvals: [{ productId: assembly.id, approvedSalePrice: 120, expectedLandedCostSnapshotId: bomCost.reference, expectedLandedCostNumerator: bomCost.numerator, expectedLandedCostDenominator: bomCost.denominator, expectedPriceLocked: false, expectedSalePrice: 120 }], settings: { bufferPercentage: 0, profitPercentage: 0 }, reason: 'fixture', operationId: 'stale' }), /changed after preview/);
  db.close();
});

test('mixed carton creates two singly counted children, preserves source weight and requires split/measurement', () => {
  const { db, procurement, request, execute } = setup();
  const data: any[] = [rows()[0], rows()[1], { ...rows()[1], record_id: 'b', sku: 'B' },
    { ...rows()[2], quantity: '30', amount: '60' }, { ...rows()[2], record_id: 'lb', product_ref: 'b', sku: 'B', quantity: '10', amount: '20' },
    { ...rows()[3], package_count: '1', meta_json: '{"mixed":true}' },
    { ...rows()[5], quantity: '30' }, { ...rows()[6], parent_ref: 'g1', product_ref: 'b', sku: 'B', purchase_line_ref: 'lb' }];
  const purchase: any = execute('mixed', request(data)).result.body;
  const plans = db.prepare('SELECT source_carton_id,gross_weight_kg_estimate FROM procurement_package_plan').all() as any[];
  assert.equal(plans.length, 2); assert.equal(plans[0].source_carton_id, plans[1].source_carton_id);
  assert.ok(plans.every(p => p.gross_weight_kg_estimate === null));
  assert.equal(purchase.sourcePacking.filter((r: any) => r.record_type === 'PACKAGE_GROUP').length, 1);
  procurement.finalizeAcquisitionCosts(purchase.id, { allocations: [] }); procurement.approveForReceipt(purchase.id, 'tester');
  const intent = procurement.listReceiptReady()[0], p = intent.packagePlan!.packages[0];
  const input = { receiptId: 'mixed-receipt', receiptSeriesId: 'mixed-receipt', stageIndex: 1, isFinal: true, costSnapshotId: intent.costSnapshotId, planVersion: intent.packagePlan!.version,
    supplierLotCode: 'MIXED', acceptedQuantityBaseInt: p.quantityBaseInt, damagedQuantityBaseInt: 0, receivedAt: '2026-01-02T00:00:00Z', operationId: 'mixed-receive',
    packages: [{ id: p.id, code: p.code, quantityBaseInt: p.quantityBaseInt, targetQuantityBaseInt: p.quantityBaseInt }] };
  const warehouse = new WarehouseExecutionService(db);
  assert.throws(() => warehouse.receiveGoods(input), /ayrılıp tartılmalı/);
  assert.throws(() => warehouse.receiveGoods({ ...input, packages: [{ ...input.packages[0], splitConfirmed: true }] }), /ayrılıp tartılmalı/);
  warehouse.receiveGoods({ ...input, packages: [{ ...input.packages[0], splitConfirmed: true, weightGrams: 1000 }] });
  assert.equal(db.prepare('SELECT COUNT(*) FROM warehouse_execution_packages').pluck().get(), 1);
  assert.equal(productPackages(db, intent.productId).physicalCount, 1);
  const printing = new PrintingService(db), snapshot = printing.packageSnapshot(p.id);
  db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES ('printer','printer','synthetic','admin',1)").run();
  const template = { id: 'template-v2', name: 'Package', purpose: 'goods_receipt' as const, width: 100, height: 150, version: 2, contentHash: 'a'.repeat(64), elements: [{ type: 'barcode', value: '{Package_code}' }] };
  const first = printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template, operationId: 'print-one', actorId: 'printer' });
  assert.equal(printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template, operationId: 'print-two', actorId: 'printer' }).id, first.id);
  assert.throws(() => printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template: { ...template, elements: [{ type: 'barcode', value: '{SKU}' }] }, operationId: 'wrong-barcode', actorId: 'printer' }), /Package_code/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  db.close();
});

test('automatic SKU matching keeps existing cards, checks supplier identity and rejects mismatched catalog types', () => {
  const { db, request, importer, catalog, execute } = setup();
  const existing = catalog.createProduct({ sku: 'A', title: 'Existing title', catalog_type: 'product', base_uom_code: 'piece', product_type: 'component' });
  const input = request();
  const preview = importer.preview(input);
  assert.equal(preview.summary.existingSkuCount, 1);
  assert.equal(preview.products[0].action, 'KEEP');
  assert.equal(preview.blockingErrors.length, 0);
  execute('existing', input);
  assert.equal(catalog.getProduct(existing.id)!.title, 'Existing title');
  assert.equal(catalog.getProduct(existing.id)!.catalog_version, existing.catalog_version);
  const changedSupplier = importer.preview({ ...input, csv: input.csv.replace('"Fixture"', '"Different supplier"') });
  assert.ok(changedSupplier.blockingErrors.some(message => message.includes('tedarikçi')));
  catalog.updateProduct(existing.id, existing.catalog_version, { sku: 'A', title: 'Existing title', catalog_type: 'product', base_uom_code: 'piece', product_type: 'simple' });
  const typeMismatch = importer.preview(input);
  assert.ok(typeMismatch.blockingErrors.some(message => message.includes('türüyle çelişiyor')));
  db.close();
});


test('CSV expenses remain source evidence only, manual supplier and third-party costs affect payable and LC once', () => {
  const { db, request, importer, execute, procurement } = setup();
  const data: any[] = rows();
  data[0].meta_json = JSON.stringify({ goods_amount_usd: 200, invoice_expenses_usd: 19.51, invoice_total_usd: 219.51 });
  data.push({ schema_version: 'dsdst.procurement.import.v1', record_type: 'EXPENSE', record_id: 'fee', parent_ref: 'p', name_en: 'Source surcharge', amount: '19.51', currency: 'USD', review_codes: 'EXPENSE_POLICY_CONFIRM' });
  const input = request(data);
  assert.equal(importer.preview(input).blockingErrors.length, 0);
  const purchase: any = execute('source-only', input).result.body;
  assert.equal(purchase.totalGrossMinor, 20000);
  assert.equal(purchase.acquisitionCosts.length, 0);
  const source: any = db.prepare("SELECT source_json,canonical_id FROM procurement_import_records WHERE record_id='fee'").get();
  assert.equal(source.canonical_id, null);
  assert.equal(JSON.parse(source.source_json).amount, '19.51');
  const cost = { category: 'FREIGHT' as const, amountMinor: 1951, currency: 'USD', vatMode: 'EXCLUDED' as const, vatRateBps: 0 };
  assert.throws(() => procurement.addAcquisitionCost(purchase.id, cost), /counterparty|muhatap/i);
  const supplier = procurement.addAcquisitionCost(purchase.id, { ...cost, counterparty: 'SUPPLIER' } as any)!;
  assert.equal(supplier.totalGrossMinor, 21951);
  assert.equal(supplier.paidMinor, 0);
  const thirdParty = procurement.addAcquisitionCost(purchase.id, { ...cost, amountMinor: 100, currency: 'TRY', counterparty: 'THIRD_PARTY' } as any)!;
  assert.equal(thirdParty.totalGrossMinor, 21951);
  assert.equal(thirdParty.outstandingMinor, 21951);
  assert.equal(thirdParty.paymentStatus, 'UNPAID');
  assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(), 0);
  assert.throws(() => procurement.addAcquisitionCost(purchase.id, { ...cost, currency: 'TRY', counterparty: 'SUPPLIER' }), /para biriminde/);
  assert.equal(procurement.getPurchase(purchase.id).acquisitionCosts.length, 2);
  db.prepare("INSERT INTO cash_accounts(id,name,currency,opening_balance) VALUES ('source-usd','Fixture','USD',300)").run();
  const payment = { cashAccountId: 'source-usd', currency: 'USD', paidAt: '2026-01-02T00:00:00Z' };
  assert.throws(() => procurement.recordPayment(purchase.id, { ...payment, amountMinor: 22051 }), /outstanding/);
  const paid = procurement.recordPayment(purchase.id, { ...payment, amountMinor: 21951 });
  assert.equal(paid.paymentStatus, 'PAID'); assert.equal(paid.outstandingMinor, 0);
  assert.equal(db.prepare('SELECT total_gross_minor FROM purchase_orders WHERE id=?').pluck().get(purchase.id), 20000);
  const final = procurement.finalizeAcquisitionCosts(purchase.id, { allocations: thirdParty.acquisitionCosts.map((c: any) => ({ componentId: c.id, mode: 'ACCEPT_SUGGESTION' as const })) });
  assert.equal(final.lots[0].landedCostTryMinor, 800000 + 78040 + 100);
  assert.equal(JSON.parse((db.prepare("SELECT source_json FROM procurement_import_records WHERE record_id='p'").get() as any).source_json).meta.invoice_total_usd, 219.51);
  db.close();
});

test('approved plan prints before receipt, corrected label version keeps identity and creates no stock', () => {
  const { db, request, execute, procurement } = setup();
  const data: any[] = rows(); data[1].supplier_code = 'SUP-FIXTURE';
  const purchase: any = execute('plan-label', request(data)).result.body;
  const printing = new PrintingService(db);
  const plan = procurement.getPackagePlan(purchase.lines[0].id)!;
  const p = plan.packages[0];
  const options = { planVersion: plan.version, supplierLotCode: 'LOT-PRE', quantityBaseInt: p.quantityBaseInt };
  assert.throws(() => printing.packageSnapshot(p.id, options), /approved|onay/i);
  procurement.finalizeAcquisitionCosts(purchase.id, { allocations: [] }); procurement.approveForReceipt(purchase.id, 'tester');
  const snapshot = printing.packageSnapshot(p.id, options);
  assert.equal(snapshot.payload.Parti_Lot, 'LOT-PRE');
  assert.equal(snapshot.payload.Supplier_no, 'SUP-FIXTURE');
  assert.equal(snapshot.payload.Package_code, p.code);
  const corrected = printing.packageSnapshot(p.id, { ...options, quantityBaseInt: 29 });
  assert.equal(corrected.subjectId, snapshot.subjectId);
  assert.notEqual(corrected.payload.Label_version, snapshot.payload.Label_version);
  assert.equal(corrected.payload.Paket_ici_adet, '29');
  db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES ('printer','printer','synthetic','admin',1)").run();
  const template = { id: 'package-100x150', name: 'Package', purpose: 'goods_receipt' as const, width: 100, height: 150, version: 1, contentHash: 'a'.repeat(64), elements: [{ type: 'barcode', value: '{Package_code}' }] };
  const first = printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template, operationId: 'planned-print', actorId: 'printer' });
  const next = printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...corrected, template, operationId: 'corrected-print', actorId: 'printer' });
  assert.notEqual(next.id, first.id);
  printing.reprint({ originalJobId: next.id, reason: 'LOST', operationId: 'reprint', actorId: 'printer' });
  for (const table of ['warehouse_execution_packages','inventory_ledger_events','inventory_lots']) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_package_plan').pluck().get(), 4);
  db.close();
});


test('published synthetic CSV keeps merchandise, source invoice total and ignored expense distinct', () => {
  const parsed = parseProcurementImport(readFileSync(new URL('../../../public/examples/procurement-import-v1.csv', import.meta.url), 'utf8'));
  assert.equal(parsed.summary.goodsAmountMinor, 20000);
  assert.equal(parsed.summary.sourceInvoiceTotalMinor, 21951);
  assert.equal(parsed.summary.expenseAmountMinor, 1951);
  assert.deepEqual(expandSourcePackages(parsed).map(p => p.quantity), ['30','30','30','10']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProcurementImport, expandSourcePackages } from './procurementImport.js';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/initialize.js';
import { CatalogService } from '../catalog/catalogService.js';
import { ProcurementImportService, type ImportRequest } from './procurementImportService.js';
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
    const input: ImportRequest = { csv: fixtureCsv(data), supplierId: 'supplier', choices: {}, confirmations: [], policy: { vatMode: 'EXCLUDED', vatRateBps: 0, acquisitionCostVatPolicy: 'VAT_EXCLUDED_FROM_INVENTORY_COST', includedCost: 'NO_SEPARATE_CHARGE', stockCheck: 'NO_PRIOR_RECEIPT', stockEvidence: 'Synthetic empty database', expenseTypes: {} } };
    for (const p of importer.preview(input).products) input.choices![p.ref] = { action: 'CREATE', fields: p.proposed };
    const preview = importer.preview(input); input.confirmations = preview.requirements.map(r => r.key); input.expectedPreviewHash = preview.previewHash;
    return input;
  };
  const execute = (key: string, input: ImportRequest) => new CommandExecutor(db).execute<any>({ operationId: key, commandType: 'procurement.import.apply.v1', payload: input, actor: { human: { id: 'tester' } }, authorization: { decision: 'ALLOW', capability: 'procurement:write+catalog:write' } }, () => ({ statusCode: 201, body: importer.apply(input, 'tester') as any }));
  return { db, procurement, importer, catalog, request, execute };
};

test('preview is read-only; import is atomic, invoice/source/operation replay-safe and preserves four packages', () => {
  const { db, importer, request, execute } = setup();
  const input = request();
  assert.equal(db.prepare('SELECT COUNT(*) FROM products').pluck().get(), 0);
  const incomplete = { ...input, confirmations: [] };
  assert.throws(() => execute('incomplete', incomplete), /onay/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get(), 0);
  const first = execute('import-1', input);
  assert.equal(execute('import-1', input).replayed, true);
  assert.equal(execute('import-2', input).result.body.id, first.result.body.id);
  assert.throws(() => execute('import-1', { ...input, supplierId: 'other' }), /different canonical payload/);
  assert.throws(() => importer.apply({ ...input, csv: input.csv.replace('SYNTHETIC', 'SYNTHETIC') + '\r\n' }, 'tester'), /zaten kayıtlı/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM purchase_orders').pluck().get(), 1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_package_plan').pluck().get(), 4);
  assert.equal(db.prepare('SELECT COUNT(*) FROM inventory_ledger_events').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM procurement_import_records').pluck().get(), rows().length);
  db.close();
});

test('failure after catalog creation rolls back catalog, aliases, purchases, plans and command records', () => {
  const { db, request, importer, execute } = setup();
  const input = request(); input.policy!.expenseTypes = {};
  // Currency has no approved FX source. The failure occurs inside purchase normalization after catalog materialization.
  input.csv = input.csv.replaceAll('USD', 'EUR');
  const preview = importer.preview(input); input.confirmations = preview.requirements.map(r => r.key); input.expectedPreviewHash = preview.previewHash;
  assert.throws(() => execute('fail', input));
  for (const table of ['products','purchase_orders','procurement_imports','procurement_package_plan','catalog_supplier_aliases']) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
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
  catalog.replaceBom(assembly.id, catalog.readBom(assembly.id).version, [{ componentId: part.id, quantity: 3 }]);
  assert.notEqual(finalLandedCostSource(db, assembly.id)!.reference, bomCost.reference);
  assert.throws(() => new ProductPricingService(db).applyMany({ approvals: [{ productId: assembly.id, approvedSalePrice: 120, expectedLandedCostSnapshotId: bomCost.reference, expectedLandedCostNumerator: bomCost.numerator, expectedLandedCostDenominator: bomCost.denominator, expectedPriceLocked: false, expectedSalePrice: 0 }], settings: { bufferPercentage: 0, profitPercentage: 0 }, reason: 'fixture', operationId: 'stale' }), /changed after preview/);
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
  const template = { id: 'template-v2', name: 'Package', purpose: 'goods_receipt' as const, width: 100, height: 100, version: 2, contentHash: 'a'.repeat(64), elements: [{ type: 'barcode', value: '{Package_code}' }] };
  const first = printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template, operationId: 'print-one', actorId: 'printer' });
  assert.equal(printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template, operationId: 'print-two', actorId: 'printer' }).id, first.id);
  assert.throws(() => printing.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', ...snapshot, template: { ...template, elements: [{ type: 'barcode', value: '{SKU}' }] }, operationId: 'wrong-barcode', actorId: 'printer' }), /Package_code/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT'").pluck().get(), 1);
  db.close();
});

test('clearing review codes does not remove derived-quantity review; new suggested SKU collisions are rejected', () => {
  const { db, request, importer, catalog } = setup();
  const data: any[] = rows();
  data[2].meta_json = '{"quantity_derived_from":"E7","original_total_qty":" "}';
  data[2].review_codes = '';
  const input = request(data);
  assert.ok(importer.preview(input).requirements.some(r => r.key === 'l:DERIVED_QUANTITY_CONFIRM'));
  assert.ok(importer.preview({ ...input, csv: input.csv.replace('"Fixture"', '"Different supplier"') }).requirements.some(r => r.key === 'p:SUPPLIER_CONFIRM'));
  catalog.createProduct({ sku: 'a', title: 'Already registered', catalog_type: 'product', base_uom_code: 'piece' });
  assert.throws(() => importer.preview(input), /zaten kullanılıyor|çelişiyor|çakışıyor/);
  db.close();
});

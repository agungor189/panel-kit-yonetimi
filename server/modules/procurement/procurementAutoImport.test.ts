import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/initialize.js';
import { ProcurementService } from './procurementService.js';
import { ProcurementImportService, type ImportRequest } from './procurementImportService.js';
import { ExchangeRateService } from '../finance/exchangeRates.js';
import { CommandExecutor } from '../commands/commandFoundation.js';
import { CatalogService } from '../catalog/catalogService.js';

const approved = ['PCI-R200-4W','PCI-R200-5W','PCI-R150-SVF','FAST-M8X10','FAST-M8X16'];
const csv = (rows: Array<Record<string, unknown>>) => {
  const fields = [...new Set(rows.flatMap(Object.keys))];
  const quote = (value: unknown) => `"${String(value ?? '').replaceAll('"','""')}"`;
  return fields.map(quote).join(',') + '\r\n' + rows.map(row => fields.map(field => quote(row[field])).join(',')).join('\r\n');
};
const record = (record_type: string, record_id: string, fields: Record<string, unknown> = {}) => ({ schema_version: 'dsdst.procurement.import.v1', record_type, record_id, ...fields });
const productRef = (index: number) => index < 5 ? `PRODUCT-X00${index + 1}` : `product-${index}`;
const productSku = (index: number) => index < 5 ? approved[index] : index < 167 ? `COMP-${index}` : `ASSY-${index}`;
function largeFixture() {
  const rows: Array<Record<string, unknown>> = [record('PURCHASE','purchase',{ invoice_number:'SYNTHETIC-185',invoice_date:'2026-01-01',supplier_name:'Fixture',currency:'USD',
    meta_json:JSON.stringify({ expected_cartons:488,goods_amount_usd:'19062.14',invoice_expenses_usd:'1951.00',invoice_total_usd:'21013.14' }) })];
  for (let i = 0; i < 185; i++) rows.push(record('PRODUCT',productRef(i),{ parent_ref:'purchase',sku:i < 5 ? '' : productSku(i),suggested_sku:i < 5 ? approved[i] : '',
    supplier_code:i < 3 ? `SUP-${i}` : '',source_supplier_code:i === 3 || i === 4 ? 'Screw' : `SUP-${i}`,
    product_type:i >= 167 ? 'assembly' : 'component',uom:'piece',name_en:`Synthetic ${i}`,unit_weight_g:i === 3 ? '2.3' : '1' }));
  for (let i = 0; i < 199; i++) {
    const index = i % 167, quantity = i === 8 ? 294 : 1;
    const unit = i >= 194 ? 0 : i === 0 ? 19057.27 : i === 1 ? 0.02 : 0.01;
    rows.push(record('LINE',`line-${i}`,{ parent_ref:'purchase',product_ref:productRef(index),sku:index < 5 ? '' : productSku(index),
      quantity:String(quantity),unit_price:unit.toFixed(2),amount:(unit * quantity).toFixed(2),currency:'USD',uom:'piece',pricing_basis:i >= 194 ? 'INCLUDED_IN_PRICE' : 'BILLED' }));
  }
  for (let i = 0; i < 195; i++) {
    const mixed = i < 4, packageCount = i === 4 ? 294 : 1;
    rows.push(record('PACKAGE_GROUP',`group-${i}`,{ parent_ref:'purchase',package_count:String(packageCount),meta_json:JSON.stringify({mixed}),gross_weight_kg:String(packageCount),net_weight_kg:String(packageCount) }));
    const lineNumbers = mixed ? [2*i,2*i+1] : [i+4];
    for (const lineIndex of lineNumbers) {
      const index = lineIndex % 167;
      rows.push(record('PACKAGE_ITEM',`item-${lineIndex}`,{ parent_ref:`group-${i}`,product_ref:productRef(index),sku:index < 5 ? '' : productSku(index),
        purchase_line_ref:`line-${lineIndex}`,quantity:String(packageCount),units_per_package:'1',uom:'piece' }));
    }
  }
  for (let i = 0; i < 18; i++) for (let j = 0; j < (i < 8 ? 3 : 2); j++) {
    rows.push(record('BOM',`bom-${i}-${j}`,{ parent_ref:productRef(167+i),product_ref:productRef(167+i),component_ref:productRef(i*3+j),quantity_per_unit:String(j+1) }));
  }
  for (const [index,amount] of ['1000.00','900.00','51.00'].entries()) rows.push(record('EXPENSE',`expense-${index}`,{parent_ref:'purchase',amount,currency:'USD'}));
  return rows;
}
function setup() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initializeDatabase(db);
  new ProcurementService(db).registerSupplier({id:'supplier',name:'Fixture',defaultCurrency:'USD'});
  new ExchangeRateService(db).recordCurrentUsdTry({rate:'40',source:'MANUAL',changedAt:'2026-01-01T00:00:00.000Z',actorId:'fixture'});
  const importer = new ProcurementImportService(db);
  const request = (rows: Array<Record<string, unknown>>): ImportRequest => {
    const input: ImportRequest = {csv:csv(rows),supplierId:'supplier',policy:{vatMode:'EXCLUDED',vatRateBps:0,acquisitionCostVatPolicy:'VAT_EXCLUDED_FROM_INVENTORY_COST',includedCost:'NO_SEPARATE_CHARGE',stockCheck:'NO_PRIOR_RECEIPT',stockEvidence:'Synthetic empty DB'}};
    input.expectedPreviewHash = importer.preview(input).previewHash;
    return input;
  };
  const execute = (key: string, input: ImportRequest) => new CommandExecutor(db).execute<any>({operationId:key,commandType:'procurement.import.apply.v1',payload:input,
    actor:{human:{id:'fixture'}},authorization:{decision:'ALLOW',capability:'procurement:write+catalog:write'}}, () => ({statusCode:201,body:importer.apply(input,'fixture') as any}));
  return {db,importer,request,execute};
}

test('185 products auto-match without per-row choices; 199 prices, 18 BOMs and 492 packages commit once', () => {
  const {db,importer,request,execute} = setup();
  const input = request(largeFixture());
  const preview = importer.preview(input);
  assert.deepEqual(preview.blockingErrors,[]);
  assert.equal(preview.summary.newSkuCount,185);
  assert.equal(preview.summary.billedLineCount,194);
  assert.equal(preview.summary.includedLineCount,5);
  assert.equal(preview.summary.bomCount,18);
  assert.equal(preview.summary.bomRelationCount,44);
  assert.equal(preview.parsed.summary.sourceCartons,488);
  assert.equal(preview.parsed.summary.warehousePackages,492);
  assert.equal(preview.parsed.summary.goodsAmountMinor,1906214);
  assert.equal(preview.parsed.summary.sourceInvoiceTotalMinor,2101314);
  assert.deepEqual(preview.products.slice(0,5).map(product => product.sku),approved);
  assert.deepEqual(preview.skippedAliases,['Screw']);
  assert.equal(db.prepare('SELECT count(*) FROM products').pluck().get(),0);
  const purchase: any = execute('import-185',input).result.body;
  assert.equal(execute('import-185',input).replayed,true);
  assert.equal(execute('import-185-retry',input).result.body.id,purchase.id);
  for (const [table,count] of [['products',185],['purchase_order_lines',199],['product_bom',44],['procurement_package_plan',492],['purchase_cost_components',0],['inventory_ledger_events',0]] as const)
    assert.equal(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),count,table);
  assert.notEqual(purchase.lines[0].quote.supplierUnitPriceMinor,purchase.lines[167].quote.supplierUnitPriceMinor);
  assert.equal(purchase.lines[0].productId,purchase.lines[167].productId);
  assert.equal(purchase.lines[0].product.sku,approved[0]);
  assert.equal(purchase.lines[0].product.supplierCode,'SUP-0');
  assert.equal(purchase.lines[0].product.nameEn,'Synthetic 0');
  assert.equal(purchase.lines[0].sourceLineAmountMinor,1905727);
  assert.deepEqual(purchase.lines[8].plannedPackages,{count:294,mixedCount:0,distribution:[{quantity:1,count:294}]});
  const mixed = db.prepare('SELECT source_carton_id,gross_weight_kg_estimate FROM procurement_package_plan WHERE mixed=1 ORDER BY source_carton_id').all() as any[];
  assert.equal(mixed.length,8);
  assert.equal(new Set(mixed.map(item => item.source_carton_id)).size,4);
  assert.ok(mixed.every(item => item.gross_weight_kg_estimate === null));
  const next = [record('PURCHASE','next',{invoice_number:'NEXT',invoice_date:'2026-01-02',supplier_name:'Fixture',currency:'USD'}),
    record('LINE','next-line',{parent_ref:'next',sku:productSku(0),quantity:'2',unit_price:'0.02',amount:'0.04',currency:'USD',uom:'piece',pricing_basis:'BILLED'}),
    record('PACKAGE_GROUP','next-group',{parent_ref:'next',package_count:'1',meta_json:'{"mixed":false}'}),
    record('PACKAGE_ITEM','next-item',{parent_ref:'next-group',sku:productSku(0),purchase_line_ref:'next-line',quantity:'2',units_per_package:'2'})];
  const nextInput = request(next);
  assert.equal(importer.preview(nextInput).summary.existingSkuCount,1);
  const nextPurchase: any = execute('next-import',nextInput).result.body;
  assert.equal(nextPurchase.lines[0].product.supplierCode,'SUP-0');
  assert.equal(nextPurchase.lines[0].product.productType,'component');
  assert.equal(db.prepare('SELECT count(*) FROM products').pluck().get(),185);
  assert.equal(db.prepare('SELECT count(*) FROM product_bom').pluck().get(),44);
  assert.equal(db.prepare('SELECT count(*) FROM inventory_ledger_events').pluck().get(),0);
  db.close();
});

test('alias and SKU conflicts are gathered and block the entire import', () => {
  const {db,importer,request,execute} = setup();
  const catalog = new CatalogService(db);
  catalog.createProduct({sku:'OTHER',title:'Other',catalog_type:'product',base_uom_code:'piece',product_type:'component',supplier_code:'SUP-0'});
  catalog.createProduct({sku:'OTHER-2',title:'Other 2',catalog_type:'product',base_uom_code:'piece',product_type:'component',supplier_code:'SUP-1'});
  const input = request(largeFixture());
  const preview = importer.preview(input);
  assert.ok(preview.blockingErrors.length >= 2);
  assert.ok(preview.blockingErrors.some(error => error.includes('SUP-0')));
  assert.ok(preview.blockingErrors.some(error => error.includes('SUP-1')));
  assert.throws(() => execute('conflict',input), /Tedarik no/);
  assert.equal(db.prepare('SELECT count(*) FROM purchase_orders').pluck().get(),0);
  assert.equal(db.prepare('SELECT count(*) FROM products').pluck().get(),2);
  db.close();
});

test('identical BOM remains unchanged and a real concurrent BOM edit invalidates preview', () => {
  const {db,importer,request,execute} = setup();
  const catalog = new CatalogService(db);
  const part = catalog.createProduct({sku:'PART',title:'Part',catalog_type:'product',base_uom_code:'piece',product_type:'component'});
  const assembly = catalog.createProduct({sku:'ASSEMBLY',title:'Assembly',catalog_type:'product',base_uom_code:'piece',product_type:'assembly'});
  catalog.replaceBom(assembly.id,catalog.readBom(assembly.id).version,[{componentId:part.id,quantity:1}]);
  const source = (invoice: string, quantity: string) => [
    record('PURCHASE','purchase',{invoice_number:invoice,invoice_date:'2026-01-01',supplier_name:'Fixture',currency:'USD'}),
    record('PRODUCT','part',{parent_ref:'purchase',sku:'PART',product_type:'component',uom:'piece',name_en:'Part'}),
    record('PRODUCT','assembly',{parent_ref:'purchase',sku:'ASSEMBLY',product_type:'assembly',uom:'piece',name_en:'Assembly'}),
    record('LINE','line',{parent_ref:'purchase',product_ref:'part',sku:'PART',quantity:'1',unit_price:'1.00',amount:'1.00',currency:'USD',uom:'piece',pricing_basis:'BILLED'}),
    record('PACKAGE_GROUP','group',{parent_ref:'purchase',package_count:'1',meta_json:'{"mixed":false}'}),
    record('PACKAGE_ITEM','item',{parent_ref:'group',product_ref:'part',sku:'PART',purchase_line_ref:'line',quantity:'1',units_per_package:'1'}),
    record('BOM','bom',{parent_ref:'assembly',product_ref:'assembly',component_ref:'part',quantity_per_unit:quantity}),
  ];
  const unchanged = request(source('SAME-BOM','1'));
  assert.equal(importer.preview(unchanged).bom[0].action,'KEEP');
  const version = catalog.readBom(assembly.id).version;
  execute('keep-bom',unchanged);
  assert.equal(catalog.readBom(assembly.id).version,version);
  const changed = request(source('CHANGED-BOM','2'));
  assert.equal(importer.preview(changed).bom[0].action,'REPLACE');
  catalog.replaceBom(assembly.id,version,[{componentId:part.id,quantity:3}]);
  assert.throws(() => execute('stale-bom',changed),/Önizlemeyi yenileyin/);
  assert.equal(db.prepare('SELECT count(*) FROM purchase_orders').pluck().get(),1);
  assert.equal(catalog.readBom(assembly.id).lines[0].quantity,3);
  db.close();
});

test('missing catalog UOM and case-insensitive SKU collisions are explicit blockers', () => {
  const {db,importer,request} = setup();
  const catalog = new CatalogService(db);
  catalog.createProduct({sku:'fast-m8x10',title:'First',catalog_type:'product',base_uom_code:'piece',product_type:'component'});
  catalog.createProduct({sku:'FAST-M8X10',title:'Second',catalog_type:'product',base_uom_code:'piece',product_type:'component'});
  const rows = largeFixture();
  const product = rows.find(row => row.record_id === 'product-5')!;
  product.uom = '';
  const preview = importer.preview(request(rows));
  assert.ok(preview.blockingErrors.some(error => error.includes('tek ve sürümlü ürün olarak çözülemedi')));
  assert.ok(preview.blockingErrors.some(error => error.includes('birim ve ürün adı zorunlu')));
  db.close();
});

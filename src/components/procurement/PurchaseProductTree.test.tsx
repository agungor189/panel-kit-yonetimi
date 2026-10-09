import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPurchaseLines, type PurchaseTreeLine } from './PurchaseProductTree.js';

const line = (id: string, sku: string, material: string, profileType: string, size: string, amount: number): PurchaseTreeLine => ({
  id, productId: sku, product: { sku, title: sku, material, profileType, size },
  quote: { originalQuantity: '1', supplierUnitPriceMinor: amount, currency: 'USD' },
  normalizedQuantity: { baseUomCode: 'piece' }, sourceLineAmountMinor: amount,
});

test('material/profile/size groups count repeated-SKU source lines once each and keep distinct materials', () => {
  const tree = groupPurchaseLines([
    line('a1','CI-S25-TEE','Cast Iron','Kare','25x25 mm',100),
    line('a2','CI-S25-TEE','Cast Iron','Kare','25x25 mm',200),
    line('b','CI-R075','Cast Iron','Yuvarlak','¾ inç',300),
    line('c','PCI-S25','Premium Cast Iron','Kare','25x25 mm',400),
    line('d','AL-S20','Aluminum','Kare','20x20 mm',500),
    line('e','CS-S20','Carbon Steel','Kare','20x20 mm',600),
    line('f','PPR-R20','PPR','Yuvarlak','20 mm',700),
  ]);
  assert.deepEqual(tree.materials.map(item => item.name), ['Aluminum','Cast Iron','Premium Cast Iron','Carbon Steel','PPR']);
  assert.equal(tree.totalUsdMinor,2800);
  assert.equal(tree.productCount,6);
  assert.equal(tree.lineCount,7);
  const cast = tree.materials.find(item => item.name === 'Cast Iron')!;
  assert.equal(cast.totalUsdMinor,600);
  assert.equal(cast.productCount,2);
  assert.equal(cast.lineCount,3);
  const square = cast.children.find(item => item.name === 'Kare')!;
  assert.equal(square.children[0].totalUsdMinor,300);
  assert.deepEqual(square.children[0].lines.map(item => item.id),['a1','a2']);
});

test('unknown currency never becomes a fictitious USD category total', () => {
  const other = line('x','X','Cast Iron','Kare','25x25 mm',100);
  other.quote.currency = 'TRY';
  assert.equal(groupPurchaseLines([other]).materials[0].totalUsdMinor,null);
});

test('purchase and estimated LC share one source row; summaries show three distinct amounts',async()=>{
  const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {PurchaseProductRow,PurchaseProductTree}=await import('./PurchaseProductTree.js');
  const source=line('one','A','Cast Iron','Kare','25x25 mm',20000);
  source.quote={originalQuantity:'100',supplierUnitPriceMinor:200,currency:'USD'};
  source.plannedPackages={count:4,mixedCount:0,distribution:[{count:3,quantity:30},{count:1,quantity:10}]};
  const estimate={lineId:'one',merchandiseMinor:800000,allocatedExpenseMinor:120000,totalMinor:920000,unitCost:{numerator:9200,denominator:1}};
  const pricing={readOnly:true as const,currency:'TRY',fxPending:false,projectionHash:'read-only',landedUsdMinor:23000,
    totals:{merchandiseMinor:800000,additionalMinor:120000,landedMinor:920000},fx:{numerator:40,denominator:1,observedAt:'fixture'},lines:[estimate]};
  const html=renderToStaticMarkup(createElement('table',null,createElement('tbody',null,createElement(PurchaseProductRow,{line:source,pricing,estimate}))));
  assert.equal((html.match(/<tr/g)||[]).length,1);assert.equal((html.match(/<td/g)||[]).length,5);
  assert.match(html,/200,00/);assert.match(html,/9.200,00/);assert.match(html,/Dağıtılan ek gider/);
  assert.match(html,/4 paket/);assert.match(html,/3×30 \+ 1×10/);
  const summary=renderToStaticMarkup(createElement(PurchaseProductTree,{lines:[source],lots:[],pricing}));
  for(const label of ['Toplam Alış Bedeli','Toplam Ek Gider','Tahmini Toplam Landed Cost']) assert.ok(summary.includes(label));
  assert.doesNotMatch(summary,/FINAL LC Önizlemesi|Kesinleştirme/);
});

test('a missing FX snapshot preserves purchase USD and displays pending LC instead of a fabricated zero',async()=>{
  const {createElement}=await import('react');const {renderToStaticMarkup}=await import('react-dom/server');
  const {PurchaseProductRow}=await import('./PurchaseProductTree.js');
  const source=line('one','A','Cast Iron','Kare','25x25 mm',200);
  const estimate={lineId:'one',merchandiseMinor:null,allocatedExpenseMinor:null,totalMinor:null,unitCost:null};
  const pricing={readOnly:true as const,currency:null,fxPending:true,projectionHash:'read-only',landedUsdMinor:null,
    totals:{merchandiseMinor:null,additionalMinor:null,landedMinor:null},fx:null,lines:[estimate]};
  const html=renderToStaticMarkup(createElement('table',null,createElement('tbody',null,createElement(PurchaseProductRow,{line:source,pricing,estimate}))));
  assert.match(html,/2,00/);assert.match(html,/Kur bekleniyor/);assert.doesNotMatch(html,/0,00/);
});

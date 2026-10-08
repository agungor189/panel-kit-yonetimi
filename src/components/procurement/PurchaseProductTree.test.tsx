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

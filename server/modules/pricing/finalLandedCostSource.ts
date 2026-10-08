import type Database from 'better-sqlite3';
import { canonicalPayloadHash } from '../commands/commandFoundation.js';
import { reduceRational } from '../finance/money.js';

export type FinalCostSource = { reference: string; numerator: number; denominator: number; sources: unknown[] };
// Pricing-only read model. Receipt and historical valuation retain their original lot snapshots.
export function finalLandedCostSource(db: Database.Database, productId: string, visited = new Set<string>()): FinalCostSource | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_product_landed_costs'").get()) return null;
  if (visited.has(productId)) return null;
  const next = new Set(visited).add(productId);
  const product = db.prepare('SELECT product_type FROM products WHERE id=?').get(productId) as any;
  if (!product) return null;
  if (product.product_type === 'assembly') {
    const bom = db.prepare('SELECT component_product_id,quantity_per_unit FROM product_bom WHERE parent_product_id=? ORDER BY component_product_id').all(productId) as any[];
    if (!bom.length) return null;
    let numerator = 0n, denominator = 1n;
    const sources: any[] = [];
    for (const component of bom) {
      if (!Number.isSafeInteger(component.quantity_per_unit) || component.quantity_per_unit <= 0) return null;
      const cost = finalLandedCostSource(db, component.component_product_id, next);
      if (!cost) return null;
      numerator = numerator * BigInt(cost.denominator) + BigInt(cost.numerator) * BigInt(component.quantity_per_unit) * denominator;
      denominator *= BigInt(cost.denominator);
      const reduced = reduceRational(numerator, denominator, 'assembly FINAL cost');
      numerator = BigInt(reduced.numerator); denominator = BigInt(reduced.denominator);
      sources.push({ ...component, reference: cost.reference, sources: cost.sources });
    }
    return { reference: `bom-final:${canonicalPayloadHash({ productId, formulaVersion: 'assembly-final-v1', sources })}`, numerator: Number(numerator), denominator: Number(denominator), sources };
  }
  const current = db.prepare('SELECT * FROM current_product_landed_costs WHERE product_id=?').get(productId) as any;
  if (!current) return null;
  const rows = db.prepare(`SELECT s.id,s.quantity_base_int,s.landed_cost_try_minor,l.base_uom_scale_snapshot
    FROM acquisition_lot_cost_snapshots s JOIN purchase_order_lines l ON l.id=s.purchase_line_id
    WHERE s.purchase_order_id=? AND s.product_id=? ORDER BY s.id`).all(current.purchase_order_id, productId) as any[];
  if (!rows.length) return null;
  if (rows.some(r => r.base_uom_scale_snapshot !== rows[0].base_uom_scale_snapshot)) return null;
  const quantity = rows.reduce((s, r) => s + BigInt(r.quantity_base_int), 0n);
  const total = rows.reduce((s, r) => s + BigInt(r.landed_cost_try_minor), 0n);
  const cost = reduceRational(total * BigInt(rows[0].base_uom_scale_snapshot), quantity, 'purchase weighted FINAL cost');
  return { reference: rows.length === 1 ? rows[0].id : `purchase-final:${canonicalPayloadHash({ productId, purchaseId: current.purchase_order_id, sources: rows })}`, ...cost, sources: rows };
}

export function withFinalLandedCost(db: Database.Database, product: any) {
  const cost = finalLandedCostSource(db, product.id);
  return { ...product, landed_cost_snapshot_id: cost?.reference ?? null, landed_cost_numerator: cost?.numerator ?? null,
    landed_cost_denominator: cost?.denominator ?? null, landed_cost_sources: cost?.sources ?? [],
    landed_cost_try: cost ? cost.numerator / cost.denominator / 100 : null };
}

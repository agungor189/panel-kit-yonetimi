import type Database from 'better-sqlite3';
import { InventoryValidationError } from '../inventory/inventoryService.js';

export function productPackages(db: Database.Database, productId: string) {
  const product = db.prepare('SELECT p.product_type,p.base_uom_code,u.quantity_scale FROM products p JOIN uom_definitions u ON u.code=p.base_uom_code WHERE p.id=?').get(productId) as any;
  if (!product) throw new InventoryValidationError('PRODUCT_NOT_FOUND', 'Ürün bulunamadı.', 404);
  const physical = (db.prepare(`SELECT p.id,p.package_code AS code,p.initial_quantity_base_int AS initial,p.remaining_quantity_base_int AS remaining,
    NULLIF(p.weight_grams,0)/1000.0 AS weightKg,p.supplier_lot_code AS lot,w.purchase_number AS purchaseNumber,
    l.code AS location,p.status,pp.source_carton_id AS sourceCartonId,pp.source_group_ref AS sourceGroupRef
    FROM warehouse_execution_packages p LEFT JOIN procurement_workflows w ON w.purchase_order_id=p.purchase_order_id
    LEFT JOIN warehouse_location_slots l ON l.id=p.current_slot_id LEFT JOIN procurement_package_plan pp ON pp.id=p.id
    WHERE p.product_id=? ORDER BY p.created_at,p.id`).all(productId) as any[]).map(r => ({ ...r, initial: r.initial / product.quantity_scale, remaining: r.remaining / product.quantity_scale, weightEstimated: false }));
  const legacy = db.prepare(`SELECT p.id,p.package_code AS code,p.planned_quantity AS initial,p.remaining_quantity AS remaining,
    bl.package_weight_kg_snapshot AS weightKg,bl.lot_number AS lot,NULL AS purchaseNumber,l.code AS location,p.status,
    NULL AS sourceCartonId,NULL AS sourceGroupRef
    FROM warehouse_packages p JOIN inbound_batch_lines bl ON bl.id=p.batch_line_id
    LEFT JOIN warehouse_locations l ON l.id=p.current_location_id
    WHERE p.product_id=? AND p.placed_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM warehouse_execution_packages ep WHERE ep.id=p.id OR ep.package_code=p.package_code)
    ORDER BY p.created_at,p.id`).all(productId) as any[];
  const history = [...physical, ...legacy.map(r => ({ ...r, weightKg: r.weightKg > 0 ? r.weightKg : null, weightEstimated: true }))];
  const active = history.filter(p => p.remaining > 0 && !['EMPTY','CANCELLED','MISSING'].includes(p.status));
  const planned = (db.prepare(`SELECT pp.id,pp.package_code AS code,pp.quantity_base_int AS initial,pp.quantity_base_int AS remaining,
    pp.gross_weight_kg_estimate AS weightKg,NULL AS lot,w.purchase_number AS purchaseNumber,NULL AS location,
    'PLANNED' AS status,pp.plan_version AS planVersion,pp.source_carton_id AS sourceCartonId,pp.source_group_ref AS sourceGroupRef
    FROM procurement_package_plan pp JOIN procurement_workflows w ON w.purchase_order_id=pp.purchase_order_id
    WHERE pp.product_id=? AND NOT EXISTS(SELECT 1 FROM warehouse_execution_packages ep WHERE ep.id=pp.id)
      AND NOT EXISTS(SELECT 1 FROM warehouse_goods_receipts r WHERE r.purchase_line_id=pp.purchase_line_id)
      AND NOT EXISTS(SELECT 1 FROM inventory_lots il WHERE il.purchase_line_id=pp.purchase_line_id)
    ORDER BY pp.source_group_ref,pp.carton_index,pp.id`).all(productId) as any[]).map(r => ({ ...r, initial: r.initial / product.quantity_scale, remaining: r.remaining / product.quantity_scale, weightEstimated: true }));
  const distribution = new Map<number, number>();
  for (const p of active) distribution.set(p.remaining, (distribution.get(p.remaining) || 0) + 1);
  return { productId, baseUom: product.base_uom_code, bomTracked: product.product_type === 'assembly' && active.length === 0,
    physicalCount: active.length, remainingQuantity: active.reduce((n,p) => n+p.remaining,0),
    distribution: [...distribution].sort((a,b) => b[0]-a[0]).map(([quantity,count]) => ({ count, quantity })),
    physical: history, planned, readOnly: true, observedAt: new Date().toISOString() };
}

// Additive source/plan provenance; no import, backfill, inventory or financial posting.
export const PROCUREMENT_IMPORT_SCHEMA_V98 = `
 CREATE TABLE procurement_imports (
   id TEXT PRIMARY KEY, source_hash TEXT NOT NULL UNIQUE, schema_version TEXT NOT NULL,
   supplier_id TEXT NOT NULL REFERENCES procurement_suppliers(id), invoice_number TEXT NOT NULL COLLATE NOCASE,
   purchase_order_id TEXT NOT NULL UNIQUE REFERENCES purchase_orders(id),
   approval_hash TEXT NOT NULL, approval_json TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
   UNIQUE(supplier_id,invoice_number)
 );
 CREATE TABLE procurement_import_records (
   import_id TEXT NOT NULL REFERENCES procurement_imports(id), record_id TEXT NOT NULL,
   record_type TEXT NOT NULL, source_json TEXT NOT NULL, canonical_id TEXT,
   PRIMARY KEY(import_id,record_id)
 );
 CREATE TABLE procurement_package_plan (
   id TEXT PRIMARY KEY, package_code TEXT NOT NULL UNIQUE, import_id TEXT NOT NULL REFERENCES procurement_imports(id),
   purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id), purchase_line_id TEXT NOT NULL REFERENCES purchase_order_lines(id),
   product_id TEXT NOT NULL REFERENCES products(id), source_group_ref TEXT NOT NULL, source_item_ref TEXT NOT NULL,
   source_carton_id TEXT NOT NULL, carton_index INTEGER NOT NULL, plan_version TEXT NOT NULL,
   quantity_base_int INTEGER NOT NULL CHECK(quantity_base_int>0), mixed INTEGER NOT NULL CHECK(mixed IN (0,1)),
   gross_weight_kg_estimate REAL, product_snapshot_json TEXT NOT NULL
 );
 CREATE INDEX idx_procurement_plan_line ON procurement_package_plan(purchase_line_id);
 CREATE TABLE catalog_supplier_aliases (
   supplier_id TEXT NOT NULL REFERENCES procurement_suppliers(id), alias TEXT NOT NULL COLLATE NOCASE,
   product_id TEXT NOT NULL REFERENCES products(id), source_ref TEXT NOT NULL,
   PRIMARY KEY(supplier_id,alias)
 );
 ALTER TABLE pricing_history ADD COLUMN final_cost_source_json TEXT;
 ${['procurement_imports','procurement_import_records','procurement_package_plan','catalog_supplier_aliases'].map(table => `
 CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable import provenance'); END;
 CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable import provenance'); END;`).join('')}
 DROP TRIGGER trg_products_pending_activation_clear_guard;
 CREATE TRIGGER trg_products_pending_activation_clear_guard BEFORE UPDATE OF procurement_activation_pending ON products
 WHEN OLD.procurement_activation_pending=1 AND NEW.procurement_activation_pending=0 AND (
   COALESCE(NEW.central_stock,0)<=0 OR
   (NEW.product_type='component' AND (NEW.status<>'Passive' OR COALESCE(NEW.is_sellable,1)<>0)) OR
   (NEW.product_type<>'component' AND (NEW.status<>'Active' OR COALESCE(NEW.is_sellable,0)<>1 OR COALESCE(NEW.sale_price,0)<=0))
 ) BEGIN SELECT RAISE(ABORT,'procurement activation requires physical stock and product-type readiness'); END;
`;

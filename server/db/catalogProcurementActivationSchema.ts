// Forward-only provenance for products created by the procurement CSV flow.
// Only a successful authoritative receipt may clear the pending flag and
// activate the product for sale.
export const CATALOG_PROCUREMENT_ACTIVATION_SCHEMA_V96 = `
  ALTER TABLE products ADD COLUMN procurement_activation_pending INTEGER NOT NULL DEFAULT 0
    CHECK(procurement_activation_pending IN (0,1));

  CREATE INDEX idx_products_procurement_activation_pending
    ON products(procurement_activation_pending, id)
    WHERE procurement_activation_pending=1;

  CREATE TRIGGER trg_products_pending_activation_insert_guard
    BEFORE INSERT ON products
    WHEN NEW.procurement_activation_pending=1
      AND (NEW.status<>'Passive' OR COALESCE(NEW.is_sellable,1)<>0 OR COALESCE(NEW.central_stock,0)<>0)
    BEGIN SELECT RAISE(ABORT, 'procurement-created product must remain passive until first receipt'); END;

  CREATE TRIGGER trg_products_pending_activation_update_guard
    BEFORE UPDATE OF procurement_activation_pending,status,is_sellable ON products
    WHEN NEW.procurement_activation_pending=1
      AND (NEW.status<>'Passive' OR COALESCE(NEW.is_sellable,1)<>0)
    BEGIN SELECT RAISE(ABORT, 'procurement-created product must remain passive until first receipt'); END;

  CREATE TRIGGER trg_products_activation_provenance_set_once
    BEFORE UPDATE OF procurement_activation_pending ON products
    WHEN OLD.procurement_activation_pending=0 AND NEW.procurement_activation_pending=1
    BEGIN SELECT RAISE(ABORT, 'procurement activation provenance is insert-only'); END;

  CREATE TRIGGER trg_products_pending_activation_clear_guard
    BEFORE UPDATE OF procurement_activation_pending ON products
    WHEN OLD.procurement_activation_pending=1 AND NEW.procurement_activation_pending=0
      AND (NEW.status<>'Active' OR COALESCE(NEW.is_sellable,0)<>1 OR COALESCE(NEW.central_stock,0)<=0)
    BEGIN SELECT RAISE(ABORT, 'procurement activation requires physical stock'); END;
`;

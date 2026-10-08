// Forward-only pricing policy fields and the second activation prerequisite.
// A procurement-created SKU can clear its provenance flag only after both
// physical receipt and a positive authoritative sale price exist.
export const PRICING_ACTIVATION_SCHEMA_V97 = `
  ALTER TABLE products ADD COLUMN fixed_price_adjustment_try REAL NOT NULL DEFAULT 0
    CHECK(fixed_price_adjustment_try >= 0);
  ALTER TABLE products ADD COLUMN price_rounding_increment INTEGER NOT NULL DEFAULT 1
    CHECK(price_rounding_increment IN (1,5,10));
  ALTER TABLE pricing_history ADD COLUMN fixed_price_adjustment_try REAL NOT NULL DEFAULT 0;
  ALTER TABLE pricing_history ADD COLUMN price_rounding_increment INTEGER NOT NULL DEFAULT 1;

  DROP TRIGGER trg_products_pending_activation_clear_guard;
  CREATE TRIGGER trg_products_pending_activation_clear_guard
    BEFORE UPDATE OF procurement_activation_pending ON products
    WHEN OLD.procurement_activation_pending=1 AND NEW.procurement_activation_pending=0
      AND (NEW.status<>'Active' OR COALESCE(NEW.is_sellable,0)<>1
        OR COALESCE(NEW.central_stock,0)<=0 OR COALESCE(NEW.sale_price,0)<=0)
    BEGIN SELECT RAISE(ABORT, 'procurement activation requires physical stock and a positive sale price'); END;
`;

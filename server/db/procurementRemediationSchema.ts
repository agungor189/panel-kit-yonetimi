// Frozen forward-only remediation for V2-06 migration v68. Migration v67 is
// intentionally unchanged because its checksum may already exist in supported
// databases.
export const PROCUREMENT_REMEDIATION_SCHEMA_V68 = `
  ALTER TABLE purchase_orders ADD COLUMN acquisition_cost_vat_policy TEXT NOT NULL
    DEFAULT 'VAT_EXCLUDED_FROM_INVENTORY_COST'
    CHECK(acquisition_cost_vat_policy IN ('VAT_EXCLUDED_FROM_INVENTORY_COST','VAT_INCLUDED_IN_INVENTORY_COST'));

  ALTER TABLE acquisition_lot_cost_snapshots ADD COLUMN vat_policy_snapshot TEXT NOT NULL
    DEFAULT 'VAT_EXCLUDED_FROM_INVENTORY_COST'
    CHECK(vat_policy_snapshot IN ('VAT_EXCLUDED_FROM_INVENTORY_COST','VAT_INCLUDED_IN_INVENTORY_COST'));

  ALTER TABLE purchase_orders RENAME COLUMN direct_cost_net_minor TO direct_cost_base_try_net_minor;
  ALTER TABLE purchase_orders RENAME COLUMN direct_cost_vat_minor TO direct_cost_base_try_vat_minor;
  ALTER TABLE purchase_orders RENAME COLUMN direct_cost_gross_minor TO direct_cost_base_try_gross_minor;

  ALTER TABLE purchase_cost_components RENAME COLUMN supplier_currency TO source_currency;
  ALTER TABLE purchase_cost_components RENAME COLUMN supplier_net_minor TO source_net_minor;
  ALTER TABLE purchase_cost_components RENAME COLUMN supplier_vat_minor TO source_vat_minor;
  ALTER TABLE purchase_cost_components RENAME COLUMN supplier_gross_minor TO source_gross_minor;

  CREATE UNIQUE INDEX idx_cash_transactions_procurement_payment
    ON cash_transactions(source_type, source_id)
    WHERE source_type = 'procurement_purchase_payment';

  CREATE TRIGGER trg_purchase_order_vat_policy_immutable
    BEFORE UPDATE OF acquisition_cost_vat_policy ON purchase_orders
    BEGIN SELECT RAISE(ABORT, 'purchase_order VAT policy is immutable'); END;

  CREATE TRIGGER trg_procurement_cash_projection_immutable_update
    BEFORE UPDATE ON cash_transactions
    WHEN OLD.source_type = 'procurement_purchase_payment' OR NEW.source_type = 'procurement_purchase_payment'
    BEGIN SELECT RAISE(ABORT, 'procurement cash ledger projections are immutable'); END;

  CREATE TRIGGER trg_procurement_cash_projection_immutable_delete
    BEFORE DELETE ON cash_transactions
    WHEN OLD.source_type = 'procurement_purchase_payment'
    BEGIN SELECT RAISE(ABORT, 'procurement cash ledger projections are immutable'); END;
`;

// Frozen schema body for migration v67 and fresh database bootstrap. Changes to
// this string change the migration checksum; evolve it only through a new migration.
export const PROCUREMENT_SCHEMA_V67 = `
  CREATE TABLE IF NOT EXISTS fx_rate_observations (
    id               TEXT PRIMARY KEY,
    base_currency    TEXT NOT NULL,
    quote_currency   TEXT NOT NULL,
    rate_numerator   INTEGER NOT NULL CHECK(rate_numerator > 0),
    rate_denominator INTEGER NOT NULL CHECK(rate_denominator > 0),
    source           TEXT NOT NULL,
    observed_at      DATETIME NOT NULL,
    actor_id         TEXT NOT NULL,
    actor_type       TEXT NOT NULL CHECK(actor_type IN ('HUMAN','SYSTEM')),
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(base_currency, quote_currency, observed_at, source, actor_id)
  );

  CREATE TABLE IF NOT EXISTS fx_current_rates (
    pair_key       TEXT PRIMARY KEY,
    observation_id TEXT NOT NULL,
    changed_at     DATETIME NOT NULL,
    changed_by     TEXT NOT NULL,
    FOREIGN KEY(observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS procurement_suppliers (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    default_currency TEXT NOT NULL,
    tax_identifier   TEXT,
    contact_json     TEXT,
    notes            TEXT,
    active           INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id                       TEXT PRIMARY KEY,
    supplier_id              TEXT NOT NULL,
    supplier_name_snapshot   TEXT NOT NULL,
    supplier_currency        TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED')),
    payment_status           TEXT NOT NULL DEFAULT 'UNPAID' CHECK(payment_status IN ('UNPAID','PARTIAL','PAID')),
    invoice_number           TEXT,
    invoice_date             TEXT,
    notes                    TEXT,
    merchandise_net_minor   INTEGER NOT NULL CHECK(merchandise_net_minor >= 0),
    merchandise_vat_minor   INTEGER NOT NULL CHECK(merchandise_vat_minor >= 0),
    merchandise_gross_minor INTEGER NOT NULL CHECK(merchandise_gross_minor >= 0),
    direct_cost_net_minor    INTEGER NOT NULL CHECK(direct_cost_net_minor >= 0),
    direct_cost_vat_minor    INTEGER NOT NULL CHECK(direct_cost_vat_minor >= 0),
    direct_cost_gross_minor  INTEGER NOT NULL CHECK(direct_cost_gross_minor >= 0),
    total_net_minor          INTEGER NOT NULL CHECK(total_net_minor >= 0),
    total_vat_minor          INTEGER NOT NULL CHECK(total_vat_minor >= 0),
    total_gross_minor        INTEGER NOT NULL CHECK(total_gross_minor >= 0),
    total_base_try_net_minor   INTEGER NOT NULL CHECK(total_base_try_net_minor >= 0),
    total_base_try_vat_minor   INTEGER NOT NULL CHECK(total_base_try_vat_minor >= 0),
    total_base_try_gross_minor INTEGER NOT NULL CHECK(total_base_try_gross_minor >= 0),
    paid_minor               INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor >= 0),
    created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finalized_at             DATETIME,
    FOREIGN KEY(supplier_id) REFERENCES procurement_suppliers(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id                              TEXT PRIMARY KEY,
    purchase_order_id               TEXT NOT NULL,
    line_index                      INTEGER NOT NULL CHECK(line_index >= 0),
    product_id                      TEXT NOT NULL,
    product_sku_snapshot            TEXT NOT NULL,
    product_title_snapshot          TEXT NOT NULL,
    catalog_version_ref_snapshot    TEXT NOT NULL,
    base_uom_code_snapshot          TEXT NOT NULL,
    base_uom_scale_snapshot         INTEGER NOT NULL CHECK(base_uom_scale_snapshot > 0),
    original_quantity               TEXT NOT NULL,
    quote_basis                     TEXT NOT NULL CHECK(quote_basis IN ('piece','meter','square_meter','kg','roll','package','box','profile_bar')),
    profile_length_mm               INTEGER CHECK(profile_length_mm IS NULL OR profile_length_mm > 0),
    profile_length_kind             TEXT CHECK(profile_length_kind IS NULL OR profile_length_kind IN ('standard','custom')),
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    supplier_unit_price_minor       INTEGER NOT NULL CHECK(supplier_unit_price_minor >= 0),
    supplier_currency               TEXT NOT NULL,
    vat_mode                        TEXT NOT NULL CHECK(vat_mode IN ('EXCLUDED','INCLUDED')),
    vat_rate_bps                    INTEGER NOT NULL CHECK(vat_rate_bps >= 0 AND vat_rate_bps <= 10000),
    supplier_net_minor              INTEGER NOT NULL CHECK(supplier_net_minor >= 0),
    supplier_vat_minor              INTEGER NOT NULL CHECK(supplier_vat_minor >= 0),
    supplier_gross_minor            INTEGER NOT NULL CHECK(supplier_gross_minor >= 0),
    base_try_net_minor              INTEGER NOT NULL CHECK(base_try_net_minor >= 0),
    base_try_vat_minor              INTEGER NOT NULL CHECK(base_try_vat_minor >= 0),
    base_try_gross_minor            INTEGER NOT NULL CHECK(base_try_gross_minor >= 0),
    fx_observation_id               TEXT,
    fx_rate_numerator               INTEGER NOT NULL CHECK(fx_rate_numerator > 0),
    fx_rate_denominator             INTEGER NOT NULL CHECK(fx_rate_denominator > 0),
    fx_source                       TEXT NOT NULL,
    fx_observed_at                  DATETIME NOT NULL,
    fx_direction                    TEXT NOT NULL,
    normalized_cost_numerator       INTEGER NOT NULL CHECK(normalized_cost_numerator >= 0),
    normalized_cost_denominator     INTEGER NOT NULL CHECK(normalized_cost_denominator > 0),
    notes                           TEXT,
    created_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(purchase_order_id, line_index),
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(fx_observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS purchase_attachments (
    id                TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK(kind IN ('INVOICE','QUOTE','DELIVERY')),
    file_name         TEXT NOT NULL,
    media_type        TEXT NOT NULL,
    size_bytes        INTEGER NOT NULL CHECK(size_bytes >= 0),
    sha256            TEXT NOT NULL CHECK(length(sha256) = 64),
    storage_reference TEXT,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS purchase_cost_components (
    id                       TEXT PRIMARY KEY,
    purchase_order_id        TEXT NOT NULL,
    category                 TEXT NOT NULL CHECK(category IN ('FREIGHT','CUSTOMS','CUTTING_LABOR','OTHER')),
    supplier_currency        TEXT NOT NULL,
    source_amount_minor      INTEGER NOT NULL CHECK(source_amount_minor >= 0),
    vat_mode                 TEXT NOT NULL CHECK(vat_mode IN ('EXCLUDED','INCLUDED')),
    vat_rate_bps             INTEGER NOT NULL CHECK(vat_rate_bps >= 0 AND vat_rate_bps <= 10000),
    supplier_net_minor       INTEGER NOT NULL CHECK(supplier_net_minor >= 0),
    supplier_vat_minor       INTEGER NOT NULL CHECK(supplier_vat_minor >= 0),
    supplier_gross_minor     INTEGER NOT NULL CHECK(supplier_gross_minor >= 0),
    base_try_net_minor       INTEGER NOT NULL CHECK(base_try_net_minor >= 0),
    base_try_vat_minor       INTEGER NOT NULL CHECK(base_try_vat_minor >= 0),
    base_try_gross_minor     INTEGER NOT NULL CHECK(base_try_gross_minor >= 0),
    fx_observation_id        TEXT,
    fx_rate_numerator        INTEGER NOT NULL CHECK(fx_rate_numerator > 0),
    fx_rate_denominator      INTEGER NOT NULL CHECK(fx_rate_denominator > 0),
    fx_source                TEXT NOT NULL,
    fx_observed_at           DATETIME NOT NULL,
    allocation_method        TEXT NOT NULL DEFAULT 'PURCHASE_VALUE_PROPORTION',
    suggestion_json          TEXT NOT NULL,
    rounding_residual_minor  INTEGER NOT NULL CHECK(rounding_residual_minor >= 0),
    notes                    TEXT,
    created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(fx_observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS purchase_cost_allocations (
    id                TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    component_id      TEXT NOT NULL,
    line_id           TEXT,
    amount_try_minor  INTEGER NOT NULL CHECK(amount_try_minor >= 0),
    provenance        TEXT NOT NULL CHECK(provenance IN ('ACCEPTED_SUGGESTION','MANUAL','UNALLOCATED')),
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_id) REFERENCES purchase_cost_components(id) ON DELETE RESTRICT,
    FOREIGN KEY(line_id) REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    CHECK((provenance = 'UNALLOCATED' AND line_id IS NULL) OR (provenance <> 'UNALLOCATED' AND line_id IS NOT NULL))
  );

  CREATE TABLE IF NOT EXISTS acquisition_lot_cost_snapshots (
    id                              TEXT PRIMARY KEY,
    purchase_order_id               TEXT NOT NULL,
    purchase_line_id                TEXT NOT NULL UNIQUE,
    product_id                      TEXT NOT NULL,
    state                           TEXT NOT NULL DEFAULT 'COSTED_PENDING_RECEIPT' CHECK(state = 'COSTED_PENDING_RECEIPT'),
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot          TEXT NOT NULL,
    merchandise_cost_try_minor      INTEGER NOT NULL CHECK(merchandise_cost_try_minor >= 0),
    freight_cost_try_minor          INTEGER NOT NULL CHECK(freight_cost_try_minor >= 0),
    customs_cost_try_minor          INTEGER NOT NULL CHECK(customs_cost_try_minor >= 0),
    cutting_labor_cost_try_minor    INTEGER NOT NULL CHECK(cutting_labor_cost_try_minor >= 0),
    other_direct_cost_try_minor     INTEGER NOT NULL CHECK(other_direct_cost_try_minor >= 0),
    vat_try_minor                   INTEGER NOT NULL CHECK(vat_try_minor >= 0),
    landed_cost_try_minor           INTEGER NOT NULL CHECK(landed_cost_try_minor >= 0),
    normalized_cost_numerator       INTEGER NOT NULL CHECK(normalized_cost_numerator >= 0),
    normalized_cost_denominator     INTEGER NOT NULL CHECK(normalized_cost_denominator > 0),
    allocation_snapshot_json        TEXT NOT NULL,
    source_snapshot_json            TEXT NOT NULL,
    formula_version                 TEXT NOT NULL,
    created_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(purchase_line_id) REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS purchase_payments (
    id                TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    cash_account_id   TEXT NOT NULL,
    amount_minor      INTEGER NOT NULL CHECK(amount_minor > 0),
    currency          TEXT NOT NULL,
    paid_at           DATETIME NOT NULL,
    reference         TEXT,
    notes             TEXT,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(cash_account_id) REFERENCES cash_accounts(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS procurement_cash_postings (
    id                  TEXT PRIMARY KEY,
    purchase_id         TEXT NOT NULL,
    payment_id          TEXT NOT NULL UNIQUE,
    cash_account_id     TEXT NOT NULL,
    direction           TEXT NOT NULL CHECK(direction = 'OUT'),
    amount_minor        INTEGER NOT NULL CHECK(amount_minor > 0),
    currency            TEXT NOT NULL,
    occurred_at         DATETIME NOT NULL,
    source_type         TEXT NOT NULL CHECK(source_type = 'PURCHASE_PAYMENT'),
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(payment_id) REFERENCES purchase_payments(id) ON DELETE RESTRICT,
    FOREIGN KEY(cash_account_id) REFERENCES cash_accounts(id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_purchase_lines_order ON purchase_order_lines(purchase_order_id, line_index);
  CREATE INDEX IF NOT EXISTS idx_purchase_lines_product ON purchase_order_lines(product_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_purchase_components_order ON purchase_cost_components(purchase_order_id);
  CREATE INDEX IF NOT EXISTS idx_purchase_allocations_order ON purchase_cost_allocations(purchase_order_id, component_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_allocations_line_unique ON purchase_cost_allocations(component_id, line_id) WHERE line_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_allocations_unallocated_unique ON purchase_cost_allocations(component_id) WHERE line_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_acquisition_lots_product ON acquisition_lot_cost_snapshots(product_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_purchase_payments_order ON purchase_payments(purchase_order_id, paid_at);
  CREATE INDEX IF NOT EXISTS idx_procurement_cash_account ON procurement_cash_postings(cash_account_id, occurred_at);

  CREATE TRIGGER IF NOT EXISTS trg_fx_observation_immutable_update BEFORE UPDATE ON fx_rate_observations BEGIN SELECT RAISE(ABORT, 'fx_rate_observations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_fx_observation_immutable_delete BEFORE DELETE ON fx_rate_observations BEGIN SELECT RAISE(ABORT, 'fx_rate_observations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_order_snapshot_immutable BEFORE UPDATE OF
    supplier_id,supplier_name_snapshot,supplier_currency,invoice_number,invoice_date,notes,
    merchandise_net_minor,merchandise_vat_minor,merchandise_gross_minor,
    direct_cost_net_minor,direct_cost_vat_minor,direct_cost_gross_minor,
    total_net_minor,total_vat_minor,total_gross_minor,
    total_base_try_net_minor,total_base_try_vat_minor,total_base_try_gross_minor,created_at
    ON purchase_orders BEGIN SELECT RAISE(ABORT, 'purchase_order source and money snapshots are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_order_no_delete BEFORE DELETE ON purchase_orders BEGIN SELECT RAISE(ABORT, 'purchase_orders cannot be deleted'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_line_immutable_update BEFORE UPDATE ON purchase_order_lines BEGIN SELECT RAISE(ABORT, 'purchase_order_lines are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_line_immutable_delete BEFORE DELETE ON purchase_order_lines BEGIN SELECT RAISE(ABORT, 'purchase_order_lines are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_attachment_immutable_update BEFORE UPDATE ON purchase_attachments BEGIN SELECT RAISE(ABORT, 'purchase_attachments are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_attachment_immutable_delete BEFORE DELETE ON purchase_attachments BEGIN SELECT RAISE(ABORT, 'purchase_attachments are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_component_immutable_update BEFORE UPDATE ON purchase_cost_components BEGIN SELECT RAISE(ABORT, 'purchase_cost_components are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_component_immutable_delete BEFORE DELETE ON purchase_cost_components BEGIN SELECT RAISE(ABORT, 'purchase_cost_components are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_allocation_immutable_update BEFORE UPDATE ON purchase_cost_allocations BEGIN SELECT RAISE(ABORT, 'purchase_cost_allocations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_allocation_immutable_delete BEFORE DELETE ON purchase_cost_allocations BEGIN SELECT RAISE(ABORT, 'purchase_cost_allocations are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_acquisition_lot_immutable_update BEFORE UPDATE ON acquisition_lot_cost_snapshots BEGIN SELECT RAISE(ABORT, 'acquisition_lot_cost_snapshots are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_acquisition_lot_immutable_delete BEFORE DELETE ON acquisition_lot_cost_snapshots BEGIN SELECT RAISE(ABORT, 'acquisition_lot_cost_snapshots are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_payment_immutable_update BEFORE UPDATE ON purchase_payments BEGIN SELECT RAISE(ABORT, 'purchase_payments are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_purchase_payment_immutable_delete BEFORE DELETE ON purchase_payments BEGIN SELECT RAISE(ABORT, 'purchase_payments are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_procurement_cash_immutable_update BEFORE UPDATE ON procurement_cash_postings BEGIN SELECT RAISE(ABORT, 'procurement_cash_postings are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS trg_procurement_cash_immutable_delete BEFORE DELETE ON procurement_cash_postings BEGIN SELECT RAISE(ABORT, 'procurement_cash_postings are immutable'); END;
`;

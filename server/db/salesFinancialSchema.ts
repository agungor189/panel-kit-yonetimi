// Frozen schema body for forward-only V2-09 migration v74.
export const SALES_FINANCIAL_SCHEMA_V74 = `
  CREATE TABLE sale_financial_snapshots (
    id                              TEXT PRIMARY KEY,
    sale_id                         TEXT NOT NULL UNIQUE,
    snapshot_version                INTEGER NOT NULL CHECK(snapshot_version > 0),
    formula_version                 TEXT NOT NULL,
    currency                        TEXT NOT NULL CHECK(length(currency) = 3),
    source_channel                  TEXT NOT NULL,
    gross_before_discount_minor     INTEGER NOT NULL CHECK(gross_before_discount_minor >= 0),
    discount_minor                  INTEGER NOT NULL CHECK(discount_minor >= 0),
    gross_amount_minor              INTEGER NOT NULL CHECK(gross_amount_minor >= 0),
    vat_amount_minor                INTEGER NOT NULL CHECK(vat_amount_minor >= 0),
    net_revenue_minor               INTEGER NOT NULL CHECK(net_revenue_minor >= 0),
    gross_amount_base_try_minor     INTEGER NOT NULL CHECK(gross_amount_base_try_minor >= 0),
    vat_amount_base_try_minor       INTEGER NOT NULL CHECK(vat_amount_base_try_minor >= 0),
    net_revenue_base_try_minor      INTEGER NOT NULL CHECK(net_revenue_base_try_minor >= 0),
    commission_rate_numerator       INTEGER NOT NULL CHECK(commission_rate_numerator >= 0),
    commission_rate_denominator     INTEGER NOT NULL CHECK(commission_rate_denominator > 0),
    commission_calculation_basis    TEXT NOT NULL CHECK(commission_calculation_basis IN ('GROSS_BEFORE_DISCOUNT','GROSS_AFTER_DISCOUNT')),
    commission_terms_json           TEXT NOT NULL,
    commission_amount_minor         INTEGER NOT NULL CHECK(commission_amount_minor >= 0),
    commission_base_try_minor       INTEGER NOT NULL CHECK(commission_base_try_minor >= 0),
    fx_observation_id               TEXT,
    fx_rate_numerator               INTEGER NOT NULL CHECK(fx_rate_numerator > 0),
    fx_rate_denominator             INTEGER NOT NULL CHECK(fx_rate_denominator > 0),
    fx_source                       TEXT NOT NULL,
    fx_observed_at                  DATETIME NOT NULL,
    fx_direction                    TEXT NOT NULL,
    created_operation_id            TEXT NOT NULL,
    created_actor_id                TEXT NOT NULL,
    created_actor_name              TEXT,
    created_at                      DATETIME NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE RESTRICT,
    FOREIGN KEY(fx_observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_financial_lines (
    id                              TEXT PRIMARY KEY,
    financial_snapshot_id           TEXT NOT NULL,
    sale_line_id                    TEXT NOT NULL UNIQUE,
    line_sequence                   INTEGER NOT NULL CHECK(line_sequence >= 0),
    product_id                      TEXT NOT NULL,
    product_sku_snapshot            TEXT NOT NULL,
    product_title_snapshot          TEXT NOT NULL,
    catalog_version_snapshot        INTEGER NOT NULL CHECK(catalog_version_snapshot > 0),
    catalog_version_ref_snapshot    TEXT NOT NULL,
    base_uom_code_snapshot          TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    unit_gross_minor                INTEGER NOT NULL CHECK(unit_gross_minor >= 0),
    gross_before_discount_minor     INTEGER NOT NULL CHECK(gross_before_discount_minor >= 0),
    discount_allocation_minor       INTEGER NOT NULL CHECK(discount_allocation_minor >= 0),
    gross_amount_minor              INTEGER NOT NULL CHECK(gross_amount_minor >= 0),
    vat_rate_bps                    INTEGER NOT NULL CHECK(vat_rate_bps >= 0 AND vat_rate_bps <= 10000),
    vat_amount_minor                INTEGER NOT NULL CHECK(vat_amount_minor >= 0),
    net_revenue_minor               INTEGER NOT NULL CHECK(net_revenue_minor >= 0),
    gross_amount_base_try_minor     INTEGER NOT NULL CHECK(gross_amount_base_try_minor >= 0),
    vat_amount_base_try_minor       INTEGER NOT NULL CHECK(vat_amount_base_try_minor >= 0),
    net_revenue_base_try_minor      INTEGER NOT NULL CHECK(net_revenue_base_try_minor >= 0),
    created_at                      DATETIME NOT NULL,
    UNIQUE(financial_snapshot_id, line_sequence),
    FOREIGN KEY(financial_snapshot_id) REFERENCES sale_financial_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(sale_line_id) REFERENCES sale_items(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_financial_line_components (
    id                              TEXT PRIMARY KEY,
    financial_line_id               TEXT NOT NULL,
    component_sequence              INTEGER NOT NULL CHECK(component_sequence >= 0),
    component_product_id            TEXT NOT NULL,
    component_sku_snapshot          TEXT NOT NULL,
    component_title_snapshot        TEXT NOT NULL,
    component_catalog_version       INTEGER NOT NULL CHECK(component_catalog_version > 0),
    component_catalog_version_ref   TEXT NOT NULL,
    component_role_snapshot         TEXT,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot          TEXT NOT NULL,
    created_at                      DATETIME NOT NULL,
    UNIQUE(financial_line_id, component_product_id),
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_financial_expense_facts (
    id                              TEXT PRIMARY KEY,
    financial_snapshot_id           TEXT NOT NULL,
    category                        TEXT NOT NULL CHECK(category IN ('SHIPPING','PACKAGING','ADVERTISING','OTHER')),
    fact_version                    INTEGER NOT NULL CHECK(fact_version > 0),
    state                           TEXT NOT NULL CHECK(state IN ('KNOWN','UNKNOWN')),
    amount_minor                    INTEGER CHECK(amount_minor IS NULL OR amount_minor >= 0),
    currency                        TEXT CHECK(currency IS NULL OR length(currency) = 3),
    amount_base_try_minor           INTEGER CHECK(amount_base_try_minor IS NULL OR amount_base_try_minor >= 0),
    fx_observation_id               TEXT,
    fx_rate_numerator               INTEGER,
    fx_rate_denominator             INTEGER,
    fx_source                       TEXT,
    fx_observed_at                  DATETIME,
    fx_direction                    TEXT,
    provenance_json                 TEXT NOT NULL,
    operation_id                    TEXT NOT NULL,
    actor_id                        TEXT NOT NULL,
    actor_name                      TEXT,
    recorded_at                     DATETIME NOT NULL,
    UNIQUE(financial_snapshot_id, category, fact_version),
    CHECK((state='UNKNOWN' AND amount_minor IS NULL AND currency IS NULL AND amount_base_try_minor IS NULL)
       OR (state='KNOWN' AND amount_minor IS NOT NULL AND currency IS NOT NULL AND amount_base_try_minor IS NOT NULL
           AND fx_rate_numerator IS NOT NULL AND fx_rate_denominator IS NOT NULL AND fx_source IS NOT NULL
           AND fx_observed_at IS NOT NULL AND fx_direction IS NOT NULL)),
    FOREIGN KEY(financial_snapshot_id) REFERENCES sale_financial_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(fx_observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_financial_cogs_finalizations (
    id                              TEXT PRIMARY KEY,
    financial_snapshot_id           TEXT NOT NULL UNIQUE,
    reservation_id                  TEXT NOT NULL UNIQUE,
    shipment_id                     TEXT NOT NULL,
    dispatch_operation_id           TEXT NOT NULL UNIQUE,
    total_cogs_base_try_minor       INTEGER NOT NULL CHECK(total_cogs_base_try_minor >= 0),
    formula_version                 TEXT NOT NULL,
    actor_id                        TEXT NOT NULL,
    actor_name                      TEXT,
    finalized_at                    DATETIME NOT NULL,
    FOREIGN KEY(financial_snapshot_id) REFERENCES sale_financial_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_financial_cogs_allocations (
    id                              TEXT PRIMARY KEY,
    financial_snapshot_id           TEXT NOT NULL,
    financial_line_id               TEXT NOT NULL,
    sale_line_id                    TEXT NOT NULL,
    component_product_id            TEXT NOT NULL,
    inventory_lot_id                TEXT NOT NULL,
    acquisition_cost_snapshot_id    TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot          TEXT NOT NULL,
    unit_cost_numerator             INTEGER NOT NULL CHECK(unit_cost_numerator >= 0),
    unit_cost_denominator           INTEGER NOT NULL CHECK(unit_cost_denominator > 0),
    cost_base_try_minor             INTEGER NOT NULL CHECK(cost_base_try_minor >= 0),
    cost_formula_version            TEXT NOT NULL,
    dispatch_operation_id           TEXT NOT NULL,
    actor_id                        TEXT NOT NULL,
    actor_name                      TEXT,
    created_at                      DATETIME NOT NULL,
    UNIQUE(financial_line_id, inventory_lot_id, component_product_id),
    FOREIGN KEY(financial_snapshot_id) REFERENCES sale_financial_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(sale_line_id) REFERENCES sale_items(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_sale_financial_lines_snapshot ON sale_financial_lines(financial_snapshot_id, line_sequence);
  CREATE INDEX idx_sale_financial_components_product ON sale_financial_line_components(component_product_id, financial_line_id);
  CREATE INDEX idx_sale_financial_expenses_current ON sale_financial_expense_facts(financial_snapshot_id, category, fact_version DESC);
  CREATE INDEX idx_sale_financial_cogs_snapshot ON sale_financial_cogs_allocations(financial_snapshot_id, financial_line_id);

  CREATE TRIGGER trg_sale_financial_snapshots_immutable_update BEFORE UPDATE ON sale_financial_snapshots
    BEGIN SELECT RAISE(ABORT, 'sale financial snapshots are immutable'); END;
  CREATE TRIGGER trg_sale_financial_snapshots_immutable_delete BEFORE DELETE ON sale_financial_snapshots
    BEGIN SELECT RAISE(ABORT, 'sale financial snapshots are immutable'); END;
  CREATE TRIGGER trg_sale_financial_lines_immutable_update BEFORE UPDATE ON sale_financial_lines
    BEGIN SELECT RAISE(ABORT, 'sale financial lines are immutable'); END;
  CREATE TRIGGER trg_sale_financial_lines_immutable_delete BEFORE DELETE ON sale_financial_lines
    BEGIN SELECT RAISE(ABORT, 'sale financial lines are immutable'); END;
  CREATE TRIGGER trg_sale_financial_components_immutable_update BEFORE UPDATE ON sale_financial_line_components
    BEGIN SELECT RAISE(ABORT, 'sale financial components are immutable'); END;
  CREATE TRIGGER trg_sale_financial_components_immutable_delete BEFORE DELETE ON sale_financial_line_components
    BEGIN SELECT RAISE(ABORT, 'sale financial components are immutable'); END;
  CREATE TRIGGER trg_sale_financial_expenses_immutable_update BEFORE UPDATE ON sale_financial_expense_facts
    BEGIN SELECT RAISE(ABORT, 'sale financial expense facts are immutable'); END;
  CREATE TRIGGER trg_sale_financial_expenses_immutable_delete BEFORE DELETE ON sale_financial_expense_facts
    BEGIN SELECT RAISE(ABORT, 'sale financial expense facts are immutable'); END;
  CREATE TRIGGER trg_sale_financial_cogs_finalization_immutable_update BEFORE UPDATE ON sale_financial_cogs_finalizations
    BEGIN SELECT RAISE(ABORT, 'sale financial COGS finalizations are immutable'); END;
  CREATE TRIGGER trg_sale_financial_cogs_finalization_immutable_delete BEFORE DELETE ON sale_financial_cogs_finalizations
    BEGIN SELECT RAISE(ABORT, 'sale financial COGS finalizations are immutable'); END;
  CREATE TRIGGER trg_sale_financial_cogs_immutable_update BEFORE UPDATE ON sale_financial_cogs_allocations
    BEGIN SELECT RAISE(ABORT, 'sale financial COGS allocations are immutable'); END;
  CREATE TRIGGER trg_sale_financial_cogs_immutable_delete BEFORE DELETE ON sale_financial_cogs_allocations
    BEGIN SELECT RAISE(ABORT, 'sale financial COGS allocations are immutable'); END;
`;

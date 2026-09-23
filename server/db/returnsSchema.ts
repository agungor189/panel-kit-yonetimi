// Forward-only V2-10 schema body for migration v75.
export const RETURNS_SCHEMA_V75 = `
  DROP TRIGGER trg_inventory_ledger_immutable_update;
  DROP TRIGGER trg_inventory_ledger_immutable_delete;
  DROP INDEX idx_inventory_ledger_product;
  DROP INDEX idx_inventory_ledger_lot;
  ALTER TABLE inventory_ledger_events RENAME TO inventory_ledger_events_v74;

  CREATE TABLE inventory_ledger_events (
    id                         TEXT PRIMARY KEY,
    operation_id               TEXT NOT NULL,
    event_type                 TEXT NOT NULL CHECK(event_type IN ('RECEIPT','DISPATCH','RETURN','CORRECTION')),
    product_id                 TEXT NOT NULL,
    lot_id                     TEXT NOT NULL,
    reservation_id             TEXT,
    order_id                   TEXT,
    shipment_id                TEXT,
    quantity_delta_base_int    INTEGER NOT NULL CHECK(quantity_delta_base_int <> 0),
    base_uom_code_snapshot     TEXT NOT NULL,
    reason_code                TEXT NOT NULL,
    reference_type             TEXT NOT NULL,
    reference_id               TEXT NOT NULL,
    occurred_at                DATETIME NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_type, reference_type, reference_id, lot_id),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );
  INSERT INTO inventory_ledger_events SELECT * FROM inventory_ledger_events_v74;
  DROP TABLE inventory_ledger_events_v74;
  CREATE INDEX idx_inventory_ledger_product ON inventory_ledger_events(product_id, occurred_at, id);
  CREATE INDEX idx_inventory_ledger_lot ON inventory_ledger_events(lot_id, occurred_at, id);
  CREATE TRIGGER trg_inventory_ledger_immutable_update BEFORE UPDATE ON inventory_ledger_events
    BEGIN SELECT RAISE(ABORT, 'inventory ledger events are immutable'); END;
  CREATE TRIGGER trg_inventory_ledger_immutable_delete BEFORE DELETE ON inventory_ledger_events
    BEGIN SELECT RAISE(ABORT, 'inventory ledger events are immutable'); END;

  CREATE TABLE return_requests (
    id                              TEXT PRIMARY KEY,
    sale_id                         TEXT NOT NULL,
    financial_snapshot_id           TEXT NOT NULL,
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    request_operation_id            TEXT NOT NULL UNIQUE,
    requested_by_actor_id           TEXT NOT NULL,
    requested_by_actor_name         TEXT,
    requested_at                    DATETIME NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE RESTRICT,
    FOREIGN KEY(financial_snapshot_id) REFERENCES sale_financial_snapshots(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_request_lines (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    financial_line_id               TEXT NOT NULL,
    sale_line_id                    TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    reason_code                     TEXT NOT NULL CHECK(reason_code IN ('CUSTOMER_CHANGED_MIND','WRONG_PRODUCT','DAMAGED','MISSING_PART','INCOMPATIBLE','OTHER')),
    reason_explanation              TEXT,
    created_at                      DATETIME NOT NULL,
    UNIQUE(return_id,financial_line_id),
    CHECK(reason_code <> 'OTHER' OR length(trim(reason_explanation)) > 0),
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(sale_line_id) REFERENCES sale_items(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_financial_reversal_allocations (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    return_line_id                  TEXT NOT NULL UNIQUE,
    financial_line_id               TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    gross_before_discount_minor     INTEGER NOT NULL CHECK(gross_before_discount_minor >= 0),
    discount_minor                  INTEGER NOT NULL CHECK(discount_minor >= 0),
    gross_minor                     INTEGER NOT NULL CHECK(gross_minor >= 0),
    vat_minor                       INTEGER NOT NULL CHECK(vat_minor >= 0),
    net_minor                       INTEGER NOT NULL CHECK(net_minor >= 0),
    gross_base_try_minor            INTEGER NOT NULL CHECK(gross_base_try_minor >= 0),
    vat_base_try_minor              INTEGER NOT NULL CHECK(vat_base_try_minor >= 0),
    net_base_try_minor              INTEGER NOT NULL CHECK(net_base_try_minor >= 0),
    fx_observation_id               TEXT,
    fx_rate_numerator               INTEGER NOT NULL CHECK(fx_rate_numerator > 0),
    fx_rate_denominator             INTEGER NOT NULL CHECK(fx_rate_denominator > 0),
    fx_source                       TEXT NOT NULL,
    fx_observed_at                  DATETIME NOT NULL,
    fx_direction                    TEXT NOT NULL,
    formula_version                 TEXT NOT NULL,
    created_at                      DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_line_id) REFERENCES return_request_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(fx_observation_id) REFERENCES fx_rate_observations(id) ON DELETE RESTRICT,
    CHECK(gross_before_discount_minor - discount_minor = gross_minor),
    CHECK(net_minor + vat_minor = gross_minor),
    CHECK(net_base_try_minor + vat_base_try_minor = gross_base_try_minor)
  );

  CREATE TABLE return_cogs_reversal_allocations (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    return_line_id                  TEXT NOT NULL,
    original_cogs_allocation_id     TEXT NOT NULL,
    financial_line_id               TEXT NOT NULL,
    component_product_id            TEXT NOT NULL,
    inventory_lot_id                TEXT NOT NULL,
    acquisition_cost_snapshot_id    TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot          TEXT NOT NULL,
    cost_base_try_minor             INTEGER NOT NULL CHECK(cost_base_try_minor >= 0),
    original_dispatch_operation_id  TEXT NOT NULL,
    formula_version                 TEXT NOT NULL,
    created_at                      DATETIME NOT NULL,
    UNIQUE(return_line_id,original_cogs_allocation_id),
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_line_id) REFERENCES return_request_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(original_cogs_allocation_id) REFERENCES sale_financial_cogs_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT
  );

  CREATE TABLE customer_shipping_refund_facts (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL UNIQUE,
    amount_minor                    INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    selected                        INTEGER NOT NULL CHECK(selected IN (0,1)),
    operation_id                    TEXT NOT NULL,
    actor_id                        TEXT NOT NULL,
    recorded_at                     DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    CHECK((selected=0 AND amount_minor=0) OR selected=1)
  );

  CREATE TABLE marketplace_commission_reversal_facts (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL UNIQUE,
    state                           TEXT NOT NULL CHECK(state='PENDING_SETTLEMENT'),
    original_commission_terms_json  TEXT NOT NULL,
    recorded_at                     DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_receipts (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    receipt_operation_id            TEXT NOT NULL UNIQUE,
    received_by_actor_id            TEXT NOT NULL,
    received_by_actor_name          TEXT,
    received_at                     DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_receipt_lines (
    id                              TEXT PRIMARY KEY,
    receipt_id                      TEXT NOT NULL,
    return_line_id                  TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    disposition                     TEXT NOT NULL CHECK(disposition IN ('SELLABLE','DAMAGED','MISSING_NOT_RECEIVED')),
    location_id                     TEXT,
    inspected_at                    DATETIME NOT NULL,
    CHECK((disposition='MISSING_NOT_RECEIVED' AND location_id IS NULL) OR (disposition<>'MISSING_NOT_RECEIVED' AND location_id IS NOT NULL)),
    FOREIGN KEY(receipt_id) REFERENCES return_receipts(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_line_id) REFERENCES return_request_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(location_id) REFERENCES warehouse_location_slots(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_receipt_inventory_allocations (
    id                                  TEXT PRIMARY KEY,
    receipt_line_id                     TEXT NOT NULL,
    return_cogs_reversal_allocation_id  TEXT NOT NULL,
    component_product_id                TEXT NOT NULL,
    original_inventory_lot_id           TEXT NOT NULL,
    original_acquisition_cost_snapshot_id TEXT NOT NULL,
    quantity_base_int                   INTEGER NOT NULL CHECK(quantity_base_int > 0),
    cost_base_try_minor                 INTEGER NOT NULL CHECK(cost_base_try_minor >= 0),
    disposition                         TEXT NOT NULL CHECK(disposition IN ('SELLABLE','DAMAGED','MISSING_NOT_RECEIVED')),
    inventory_ledger_event_id           TEXT,
    created_at                          DATETIME NOT NULL,
    UNIQUE(receipt_line_id,return_cogs_reversal_allocation_id),
    FOREIGN KEY(receipt_line_id) REFERENCES return_receipt_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_cogs_reversal_allocation_id) REFERENCES return_cogs_reversal_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(original_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(original_acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_ledger_event_id) REFERENCES inventory_ledger_events(id) ON DELETE RESTRICT,
    CHECK((disposition='SELLABLE' AND inventory_ledger_event_id IS NOT NULL) OR (disposition<>'SELLABLE' AND inventory_ledger_event_id IS NULL))
  );

  CREATE TABLE return_quarantine_facts (
    id                              TEXT PRIMARY KEY,
    receipt_inventory_allocation_id TEXT NOT NULL UNIQUE,
    location_id                     TEXT NOT NULL,
    quantity_base_int               INTEGER NOT NULL CHECK(quantity_base_int > 0),
    quarantined_at                  DATETIME NOT NULL,
    FOREIGN KEY(receipt_inventory_allocation_id) REFERENCES return_receipt_inventory_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(location_id) REFERENCES warehouse_location_slots(id) ON DELETE RESTRICT
  );

  CREATE TABLE return_loss_facts (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    receipt_inventory_allocation_id TEXT NOT NULL UNIQUE,
    amount_base_try_minor           INTEGER NOT NULL CHECK(amount_base_try_minor >= 0),
    original_acquisition_cost_snapshot_id TEXT NOT NULL,
    original_cogs_allocation_id     TEXT NOT NULL,
    operation_id                    TEXT NOT NULL,
    actor_id                        TEXT NOT NULL,
    recorded_at                     DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(receipt_inventory_allocation_id) REFERENCES return_receipt_inventory_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(original_acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(original_cogs_allocation_id) REFERENCES sale_financial_cogs_allocations(id) ON DELETE RESTRICT
  );

  CREATE TABLE refund_approvals (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    amount_minor                    INTEGER NOT NULL CHECK(amount_minor > 0),
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    approval_reference              TEXT NOT NULL,
    approval_operation_id           TEXT NOT NULL UNIQUE,
    approved_by_actor_id            TEXT NOT NULL,
    approved_by_actor_name          TEXT,
    approved_at                     DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT
  );

  CREATE TABLE refund_payments (
    id                              TEXT PRIMARY KEY,
    return_id                       TEXT NOT NULL,
    approval_id                     TEXT NOT NULL UNIQUE,
    amount_minor                    INTEGER NOT NULL CHECK(amount_minor > 0),
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    payment_mode                    TEXT NOT NULL CHECK(payment_mode IN ('DIRECT_CASH_BANK','MARKETPLACE_SETTLEMENT')),
    payment_operation_id            TEXT NOT NULL UNIQUE,
    paid_at                         DATETIME NOT NULL,
    FOREIGN KEY(return_id) REFERENCES return_requests(id) ON DELETE RESTRICT,
    FOREIGN KEY(approval_id) REFERENCES refund_approvals(id) ON DELETE RESTRICT
  );

  CREATE TABLE refund_cash_postings (
    id                              TEXT PRIMARY KEY,
    refund_payment_id               TEXT NOT NULL UNIQUE,
    cash_account_id                 TEXT NOT NULL,
    direction                       TEXT NOT NULL CHECK(direction='OUT'),
    amount_minor                    INTEGER NOT NULL CHECK(amount_minor > 0),
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    legacy_cash_transaction_id      TEXT NOT NULL UNIQUE,
    operation_id                    TEXT NOT NULL UNIQUE,
    posted_at                       DATETIME NOT NULL,
    FOREIGN KEY(refund_payment_id) REFERENCES refund_payments(id) ON DELETE RESTRICT,
    FOREIGN KEY(cash_account_id) REFERENCES cash_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(legacy_cash_transaction_id) REFERENCES cash_transactions(id) ON DELETE RESTRICT
  );

  CREATE TABLE refund_settlement_postings (
    id                              TEXT PRIMARY KEY,
    refund_payment_id               TEXT NOT NULL UNIQUE,
    state                           TEXT NOT NULL CHECK(state='PENDING_SETTLEMENT'),
    amount_minor                    INTEGER NOT NULL CHECK(amount_minor > 0),
    currency                        TEXT NOT NULL CHECK(length(currency)=3),
    operation_id                    TEXT NOT NULL UNIQUE,
    recorded_at                     DATETIME NOT NULL,
    FOREIGN KEY(refund_payment_id) REFERENCES refund_payments(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_return_requests_sale ON return_requests(sale_id,requested_at,id);
  CREATE INDEX idx_return_lines_financial ON return_request_lines(financial_line_id,return_id);
  CREATE INDEX idx_return_receipts_return ON return_receipts(return_id,received_at,id);
  CREATE INDEX idx_refund_payments_return ON refund_payments(return_id,paid_at,id);

  ${[
    'return_requests','return_request_lines','return_financial_reversal_allocations','return_cogs_reversal_allocations',
    'customer_shipping_refund_facts','marketplace_commission_reversal_facts','return_receipts','return_receipt_lines',
    'return_receipt_inventory_allocations','return_quarantine_facts','return_loss_facts','refund_approvals',
    'refund_payments','refund_cash_postings','refund_settlement_postings',
  ].map((table) => `
  CREATE TRIGGER trg_${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} facts are immutable'); END;
  CREATE TRIGGER trg_${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} facts are immutable'); END;`).join('')}
`;

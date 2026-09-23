// Forward-only V2-12 channel gateway schema. Provider data is an immutable
// inbox/projection; canonical catalog, sales, inventory and finance remain in P.
export const CHANNEL_GATEWAY_SCHEMA_V79 = `
  CREATE TABLE channel_accounts (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK(channel IN ('TRENDYOL','HEPSIBURADA','N11','SHOPIFY')),
    merchant_account_id TEXT NOT NULL,
    environment TEXT NOT NULL CHECK(environment IN ('STAGE','PRODUCTION')),
    state TEXT NOT NULL CHECK(state IN ('DISABLED','CONFIGURED','CONNECTED','ERROR')),
    secret_reference TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    last_webhook_at DATETIME,
    last_poll_at DATETIME,
    last_sync_at DATETIME,
    last_error_code TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel,merchant_account_id,environment)
  );

  CREATE TABLE channel_product_mappings (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    external_listing_id TEXT NOT NULL,
    external_sku TEXT,
    product_id TEXT NOT NULL,
    category_ref TEXT,
    listing_state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(listing_state IN ('ACTIVE','HIDDEN','DISABLED')),
    version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id,external_listing_id),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_commission_terms (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    product_id TEXT,
    category_ref TEXT,
    state TEXT NOT NULL CHECK(state IN ('KNOWN','UNKNOWN')),
    rate_numerator INTEGER,
    rate_denominator INTEGER,
    basis TEXT NOT NULL DEFAULT 'CUSTOMER_GROSS' CHECK(basis='CUSTOMER_GROSS'),
    provenance_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    effective_from DATETIME NOT NULL,
    effective_to DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK((state='UNKNOWN' AND rate_numerator IS NULL AND rate_denominator IS NULL) OR
          (state='KNOWN' AND rate_numerator >= 0 AND rate_denominator > rate_numerator)),
    UNIQUE(account_id,product_id,category_ref,version),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_stock_buffers (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    buffer_quantity_base_int INTEGER NOT NULL CHECK(buffer_quantity_base_int >= 0),
    version INTEGER NOT NULL CHECK(version > 0),
    updated_operation_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id,product_id),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_inbound_events (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    external_event_id TEXT NOT NULL,
    external_event_version TEXT NOT NULL,
    ingestion_path TEXT NOT NULL CHECK(ingestion_path IN ('WEBHOOK','POLL')),
    event_type TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL,
    raw_payload_digest TEXT NOT NULL CHECK(length(raw_payload_digest)=64),
    provider_occurred_at DATETIME,
    received_at DATETIME NOT NULL,
    processing_state TEXT NOT NULL CHECK(processing_state IN ('RECEIVED','ACCEPTED','EXCEPTION','DUPLICATE')),
    sale_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id,external_event_id,external_event_version),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    external_order_id TEXT NOT NULL,
    latest_external_version TEXT NOT NULL,
    currency TEXT NOT NULL CHECK(length(currency)=3),
    actual_discount_minor INTEGER NOT NULL CHECK(actual_discount_minor>=0),
    order_state TEXT NOT NULL CHECK(order_state IN ('RECEIVED','EXCEPTION','ACCEPTED','CANCELLED','RETURN_REQUESTED')),
    sale_id TEXT,
    reservation_id TEXT,
    first_event_id TEXT NOT NULL,
    raw_order_digest TEXT NOT NULL CHECK(length(raw_order_digest)=64),
    accepted_at DATETIME,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id,external_order_id),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(first_event_id) REFERENCES channel_inbound_events(id) ON DELETE RESTRICT,
    FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE RESTRICT,
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_order_lines (
    id TEXT PRIMARY KEY,
    channel_order_id TEXT NOT NULL,
    external_line_id TEXT NOT NULL,
    external_listing_id TEXT NOT NULL,
    external_sku TEXT,
    mapping_id TEXT,
    product_id TEXT,
    quantity_base_int INTEGER NOT NULL CHECK(quantity_base_int>0),
    actual_unit_gross_minor INTEGER NOT NULL CHECK(actual_unit_gross_minor>=0),
    vat_rate_bps INTEGER NOT NULL CHECK(vat_rate_bps BETWEEN 0 AND 10000),
    commission_term_id TEXT,
    expected_unit_gross_minor INTEGER,
    raw_line_digest TEXT NOT NULL CHECK(length(raw_line_digest)=64),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_order_id,external_line_id),
    FOREIGN KEY(channel_order_id) REFERENCES channel_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(mapping_id) REFERENCES channel_product_mappings(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(commission_term_id) REFERENCES channel_commission_terms(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_price_variances (
    id TEXT PRIMARY KEY,
    channel_order_line_id TEXT NOT NULL UNIQUE,
    target_price_minor INTEGER NOT NULL CHECK(target_price_minor>=0),
    expected_channel_price_minor INTEGER NOT NULL CHECK(expected_channel_price_minor>=0),
    actual_channel_price_minor INTEGER NOT NULL CHECK(actual_channel_price_minor>=0),
    difference_minor INTEGER NOT NULL,
    provenance_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_order_line_id) REFERENCES channel_order_lines(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_poll_cursors (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    cursor_name TEXT NOT NULL,
    checkpoint_value TEXT NOT NULL,
    checkpoint_version INTEGER NOT NULL CHECK(checkpoint_version>0),
    updated_operation_id TEXT NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE(account_id,cursor_name),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_outbound_jobs (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    mapping_id TEXT NOT NULL,
    job_kind TEXT NOT NULL CHECK(job_kind IN ('STOCK','PRICE','VISIBILITY')),
    source_version TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('PENDING','RETRY','SUCCEEDED','FAILED','BLOCKED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
    available_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error_code TEXT,
    created_operation_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    UNIQUE(account_id,product_id,job_kind,source_version),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(mapping_id) REFERENCES channel_product_mappings(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_outbound_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    provider_mutation_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
    state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED','RATE_LIMITED')),
    response_digest TEXT,
    error_code TEXT,
    retry_at DATETIME,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    UNIQUE(job_id,provider_mutation_id),
    UNIQUE(job_id,attempt_number),
    FOREIGN KEY(job_id) REFERENCES channel_outbound_jobs(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_exceptions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    inbound_event_id TEXT,
    channel_order_id TEXT,
    exception_type TEXT NOT NULL CHECK(exception_type IN ('CHANNEL_MAPPING_EXCEPTION','STOCK_EXCEPTION','PRICE_VARIANCE','COMMISSION_EXCEPTION','ORDER_VERSION_EXCEPTION','ADAPTER_CONTRACT_EXCEPTION')),
    state TEXT NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RESOLVED','IGNORED')),
    detail_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_operation_id TEXT,
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(inbound_event_id) REFERENCES channel_inbound_events(id) ON DELETE RESTRICT,
    FOREIGN KEY(channel_order_id) REFERENCES channel_orders(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_channel_events_state ON channel_inbound_events(account_id,processing_state,received_at);
  CREATE INDEX idx_channel_orders_state ON channel_orders(account_id,order_state,updated_at);
  CREATE INDEX idx_channel_exceptions_open ON channel_exceptions(account_id,state,exception_type,created_at);
  CREATE INDEX idx_channel_jobs_ready ON channel_outbound_jobs(state,available_at,account_id);
  CREATE INDEX idx_channel_terms_lookup ON channel_commission_terms(account_id,product_id,category_ref,effective_from);

  CREATE TRIGGER channel_commission_terms_immutable_update
  BEFORE UPDATE ON channel_commission_terms BEGIN SELECT RAISE(ABORT,'channel commission terms are immutable; create a new version'); END;
  CREATE TRIGGER channel_commission_terms_immutable_delete
  BEFORE DELETE ON channel_commission_terms BEGIN SELECT RAISE(ABORT,'channel commission terms are immutable'); END;
  CREATE TRIGGER channel_inbound_events_raw_immutable
  BEFORE UPDATE OF account_id,external_event_id,external_event_version,ingestion_path,event_type,raw_payload_json,raw_payload_digest,provider_occurred_at,received_at
  ON channel_inbound_events BEGIN SELECT RAISE(ABORT,'channel inbound raw event is immutable'); END;
  CREATE TRIGGER channel_inbound_events_no_delete
  BEFORE DELETE ON channel_inbound_events BEGIN SELECT RAISE(ABORT,'channel inbound event is immutable'); END;
  CREATE TRIGGER channel_order_lines_no_update
  BEFORE UPDATE ON channel_order_lines BEGIN SELECT RAISE(ABORT,'channel order line is immutable'); END;
  CREATE TRIGGER channel_order_lines_no_delete
  BEFORE DELETE ON channel_order_lines BEGIN SELECT RAISE(ABORT,'channel order line is immutable'); END;
  CREATE TRIGGER channel_price_variances_no_update
  BEFORE UPDATE ON channel_price_variances BEGIN SELECT RAISE(ABORT,'channel price variance is immutable'); END;
  CREATE TRIGGER channel_price_variances_no_delete
  BEFORE DELETE ON channel_price_variances BEGIN SELECT RAISE(ABORT,'channel price variance is immutable'); END;
  CREATE TRIGGER channel_outbound_attempts_no_update
  BEFORE UPDATE ON channel_outbound_attempts BEGIN SELECT RAISE(ABORT,'channel outbound attempt is immutable'); END;
  CREATE TRIGGER channel_outbound_attempts_no_delete
  BEFORE DELETE ON channel_outbound_attempts BEGIN SELECT RAISE(ABORT,'channel outbound attempt is immutable'); END;
`;

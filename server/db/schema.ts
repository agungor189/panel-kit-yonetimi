import Database from "better-sqlite3";

/**
 * applySchema — creates all tables that don't yet exist.
 *
 * Rules:
 * - Every column that will ever exist for a table is listed here so fresh
 *   databases get the full schema from day one.
 * - For EXISTING databases, missing columns are added by the migration runner
 *   (server/migrations/runner.ts). Do not rely on this file for that.
 * - Never DROP a table here; use a migration for destructive schema changes.
 */
export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id                      TEXT    PRIMARY KEY,
      name                    TEXT,
      title                   TEXT    NOT NULL,
      warehouse_location      TEXT,
      sku                     TEXT    UNIQUE,
      barcode                 TEXT,
      category                TEXT,
      model                   TEXT,
      description             TEXT,
      material                TEXT,
      size                    TEXT,
      pipe_size               TEXT,
      connection_type         TEXT,
      usage_area              TEXT,
      supplier                TEXT,
      min_stock_level         INTEGER DEFAULT 50,
      central_stock           INTEGER DEFAULT 0,
      product_type            TEXT    DEFAULT 'finished',
      is_sellable             INTEGER DEFAULT 1,
      visible_in_catalog      INTEGER DEFAULT 1,
      exclude_from_analysis   INTEGER DEFAULT 0,
      purchase_price_usd      REAL    DEFAULT 0,
      purchase_cost           REAL    DEFAULT 0,
      sale_price              REAL    DEFAULT 0,
      buffer_percentage       REAL    DEFAULT 0,
      profit_percentage       REAL    DEFAULT 0,
      exchange_rate_used      REAL    DEFAULT 0,
      price_locked            INTEGER DEFAULT 0,
      weight                  REAL    DEFAULT 0,
      status                  TEXT    DEFAULT 'Active',
      notes                   TEXT,
      normalized_material     TEXT,
      normalized_model        TEXT,
      normalized_size         TEXT,
      normalized_tube_type    TEXT,
      normalized_pipe_size    TEXT,
      created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at              DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_images (
      id          TEXT PRIMARY KEY,
      product_id  TEXT,
      path        TEXT,
      sort_order  INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_platforms (
      id             TEXT    PRIMARY KEY,
      product_id     TEXT,
      platform_name  TEXT,
      stock          INTEGER DEFAULT 0,
      price          REAL,
      is_listed      INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS product_bom (
      id                    TEXT PRIMARY KEY,
      parent_product_id     TEXT NOT NULL,
      component_product_id  TEXT NOT NULL,
      quantity_per_unit     REAL NOT NULL DEFAULT 1,
      component_role        TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(parent_product_id, component_product_id),
      FOREIGN KEY(parent_product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id             TEXT    PRIMARY KEY,
      product_id     TEXT,
      platform_name  TEXT,
      change_amount  INTEGER,
      reason         TEXT,
      type           TEXT    DEFAULT 'ADJUST',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id                          TEXT    PRIMARY KEY,
      date                        DATETIME DEFAULT CURRENT_TIMESTAMP,
      type                        TEXT,
      category                    TEXT,
      platform                    TEXT,
      amount                      REAL,
      product_id                  TEXT,
      note                        TEXT,
      reference_number            TEXT,
      recurring_id                TEXT,
      title                       TEXT,
      description                 TEXT,
      payment_method              TEXT,
      supplier                    TEXT,
      invoice_number              TEXT,
      expense_type                TEXT,
      payer_person_id             TEXT,
      will_be_refunded            INTEGER DEFAULT 0,
      refund_status               TEXT,
      is_invoice                  INTEGER DEFAULT 0,
      invoice_name                TEXT,
      is_stock_related            INTEGER DEFAULT 0,
      distribute_to_product_cost  INTEGER DEFAULT 0,
      document_url                TEXT,
      currency                    TEXT    DEFAULT 'TRY',
      amount_try                  REAL    DEFAULT 0,
      is_deleted                  INTEGER DEFAULT 0,
      exchange_rate_at_transaction REAL   DEFAULT 1,
      cash_account_id             TEXT,
      created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
      id           TEXT    PRIMARY KEY,
      action       TEXT,
      entity_type  TEXT,
      entity_id    TEXT,
      details      TEXT,
      user_id      TEXT,
      actor_username TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS backup_runs (
      id                 TEXT PRIMARY KEY,
      trigger_type       TEXT NOT NULL,
      backup_kind        TEXT NOT NULL,
      upload_mode        TEXT,
      status             TEXT NOT NULL DEFAULT 'running',
      file_name          TEXT,
      file_path          TEXT,
      size_bytes         INTEGER DEFAULT 0,
      db_size_bytes      INTEGER DEFAULT 0,
      upload_file_count  INTEGER DEFAULT 0,
      upload_total_bytes INTEGER DEFAULT 0,
      manifest_json      TEXT,
      error_message      TEXT,
      created_by         TEXT,
      cloud_status       TEXT DEFAULT 'not_configured',
      cloud_provider     TEXT,
      cloud_path         TEXT,
      cloud_uploaded_at  DATETIME,
      cloud_error        TEXT,
      cloud_attempts     INTEGER DEFAULT 0,
      started_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at       DATETIME
    );

    CREATE TABLE IF NOT EXISTS recurring_payment_plans (
      id                    TEXT    PRIMARY KEY,
      title                 TEXT    NOT NULL,
      description           TEXT,
      category              TEXT,
      payment_type          TEXT,
      amount                REAL,
      currency              TEXT,
      amount_try            REAL,
      exchange_rate         REAL,
      due_day               INTEGER,
      due_month             INTEGER,
      start_month           INTEGER,
      week_day              INTEGER,
      custom_interval_days  INTEGER,
      frequency             TEXT,
      start_date            TEXT,
      end_date              TEXT,
      next_due_date         TEXT,
      last_processed_date   TEXT,
      auto_process          INTEGER DEFAULT 0,
      is_active             INTEGER DEFAULT 1,
      payment_account_id    TEXT,
      expense_category_id   TEXT,
      tax_type              TEXT,
      related_party         TEXT,
      document_required     INTEGER DEFAULT 0,
      notes                 TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recurring_payment_occurrences (
      id                    TEXT PRIMARY KEY,
      recurring_payment_id  TEXT,
      due_date              TEXT,
      amount                REAL,
      currency              TEXT,
      exchange_rate         REAL,
      amount_try            REAL,
      status                TEXT,
      processed_at          DATETIME,
      expense_id            TEXT,
      transaction_id        TEXT,
      processed_by          TEXT,
      notes                 TEXT,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(recurring_payment_id, due_date)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id                    TEXT PRIMARY KEY,
      service_name          TEXT NOT NULL,
      display_name          TEXT NOT NULL,
      key_name              TEXT,
      api_key_encrypted     TEXT NOT NULL,
      api_secret_encrypted  TEXT,
      merchant_id           TEXT,
      seller_id             TEXT,
      status                TEXT    DEFAULT 'active',
      last4                 TEXT,
      notes                 TEXT,
      last_used_at          DATETIME,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at            DATETIME DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS marketplace_orders (
      id                       TEXT PRIMARY KEY,
      platform                 TEXT NOT NULL,
      environment              TEXT NOT NULL DEFAULT 'stage',
      external_order_id         TEXT NOT NULL,
      shipment_package_id       TEXT NOT NULL,
      status                   TEXT,
      panel_status             TEXT,
      customer_name            TEXT,
      customer_phone           TEXT,
      total_amount             REAL DEFAULT 0,
      currency                 TEXT DEFAULT 'TRY',
      package_created_at       DATETIME,
      package_last_modified_at DATETIME,
      raw_json                 TEXT NOT NULL,
      sale_id                  TEXT,
      imported_at              DATETIME,
      sync_status              TEXT DEFAULT 'synced',
      sync_error               TEXT,
      created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, environment, shipment_package_id),
      FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS marketplace_order_lines (
      id                       TEXT PRIMARY KEY,
      marketplace_order_id     TEXT NOT NULL,
      platform                 TEXT NOT NULL,
      environment              TEXT NOT NULL DEFAULT 'stage',
      external_line_id          TEXT NOT NULL,
      product_name             TEXT,
      barcode                  TEXT,
      stock_code               TEXT,
      merchant_sku             TEXT,
      quantity                 INTEGER DEFAULT 0,
      unit_price               REAL DEFAULT 0,
      line_total               REAL DEFAULT 0,
      status                   TEXT,
      raw_json                 TEXT NOT NULL,
      matched_product_id       TEXT,
      match_method             TEXT,
      match_confidence         REAL DEFAULT 0,
      created_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(marketplace_order_id, external_line_id),
      FOREIGN KEY(marketplace_order_id) REFERENCES marketplace_orders(id) ON DELETE CASCADE,
      FOREIGN KEY(matched_product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS panel_api_keys (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      key_hash     TEXT NOT NULL,
      last4        TEXT NOT NULL,
      status       TEXT    DEFAULT 'active',
      environment  TEXT    DEFAULT 'test',
      permissions  TEXT    NOT NULL,
      allowed_ips  TEXT,
      expires_at   DATETIME,
      last_used_at DATETIME,
      last_used_ip TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked_at   DATETIME,
      deleted_at   DATETIME
    );

    CREATE TABLE IF NOT EXISTS firms (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      sector          TEXT,
      city            TEXT,
      website         TEXT,
      phone           TEXT,
      email           TEXT,
      contact_person  TEXT,
      source_url      TEXT,
      related_product TEXT,
      status          TEXT    DEFAULT 'Yeni',
      notes           TEXT,
      is_active       INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS firm_notes (
      id         TEXT PRIMARY KEY,
      firm_id    TEXT,
      note       TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS offers (
      id           TEXT PRIMARY KEY,
      firm_id      TEXT,
      title        TEXT,
      description  TEXT,
      amount       REAL    DEFAULT 0,
      currency     TEXT    DEFAULT '₺',
      status       TEXT    DEFAULT 'Taslak',
      offer_date   DATETIME,
      valid_until  DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id                  TEXT PRIMARY KEY,
      firm_id             TEXT,
      type                TEXT,
      note                TEXT,
      next_follow_up_date DATETIME,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sales (
      id                         TEXT PRIMARY KEY,
      order_code                 TEXT,
      external_order_id          TEXT,
      customer_name              TEXT,
      customer_phone             TEXT,
      customer_address           TEXT,
      shipping_company           TEXT,
      tracking_number            TEXT,
      total_weight               REAL,
      total_quantity             INTEGER,
      total_amount               REAL,
      status                     TEXT    DEFAULT 'Hazırlanıyor',
      platform                   TEXT,
      commission_rate            REAL    DEFAULT 0,
      shipping_cost              REAL    DEFAULT 0,
      discount                   REAL    DEFAULT 0,
      packaging_cost             REAL    DEFAULT 0,
      ad_spend                   REAL    DEFAULT 0,
      other_expenses             REAL    DEFAULT 0,
      net_total                  REAL    DEFAULT 0,
      gross_profit               REAL    DEFAULT 0,
      net_profit                 REAL    DEFAULT 0,
      exchange_rate_at_transaction REAL  DEFAULT 1,
      cash_account_id            TEXT,
      income_transaction_id      TEXT,
      return_reason              TEXT,
      returned_at                DATETIME,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at                 DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_counters (
      date_key    TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id                TEXT PRIMARY KEY,
      sale_id           TEXT,
      product_id        TEXT,
      product_name      TEXT,
      quantity          INTEGER,
      weight            REAL,
      unit_price        REAL DEFAULT 0,
      purchase_cost     REAL DEFAULT 0,
      net_profit        REAL DEFAULT 0,
      commission_amount REAL DEFAULT 0,
      shipping_share    REAL DEFAULT 0,
      FOREIGN KEY(sale_id)    REFERENCES sales(id)    ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS expense_attachments (
      id          TEXT PRIMARY KEY,
      expense_id  TEXT,
      file_name   TEXT,
      file_path   TEXT,
      mime_type   TEXT,
      file_size   INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(expense_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS cash_accounts (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      currency         TEXT    DEFAULT 'TRY',
      type             TEXT,
      opening_balance  REAL    DEFAULT 0,
      is_active        INTEGER DEFAULT 1,
      is_liability     INTEGER DEFAULT 0,
      credit_limit     REAL    DEFAULT 0,
      cutoff_day       INTEGER,
      payment_due_day  INTEGER,
      statement_day    INTEGER,
      due_day          INTEGER,
      bank_name        TEXT,
      card_last_four   TEXT,
      current_debt     REAL    DEFAULT 0,
      available_limit  REAL    DEFAULT 0,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_transactions (
      id                          TEXT PRIMARY KEY,
      account_id                  TEXT,
      type                        TEXT,
      amount                      REAL,
      currency                    TEXT,
      exchange_rate_at_transaction REAL,
      source_type                 TEXT,
      source_id                   TEXT,
      description                 TEXT,
      transaction_date            DATETIME,
      is_deleted                  INTEGER DEFAULT 0,
      created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(account_id) REFERENCES cash_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS exchange_rates (
      id              TEXT PRIMARY KEY,
      base_currency   TEXT NOT NULL,
      target_currency TEXT NOT NULL,
      rate            REAL NOT NULL,
      source          TEXT,
      fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active       INTEGER  DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS dashboard_widgets (
      id           TEXT PRIMARY KEY,
      user_id      TEXT    DEFAULT 'admin',
      widget_key   TEXT    NOT NULL,
      title        TEXT,
      description  TEXT,
      widget_type  TEXT    NOT NULL,
      source_module TEXT,
      size         TEXT    DEFAULT 'small',
      position     INTEGER DEFAULT 0,
      is_visible   INTEGER DEFAULT 1,
      settings_json TEXT   DEFAULT '{}',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id                    TEXT PRIMARY KEY,
      username              TEXT UNIQUE NOT NULL,
      password_hash         TEXT NOT NULL,
      role                  TEXT    DEFAULT 'user',
      is_active             INTEGER DEFAULT 1,
      last_login_at         DATETIME,
      failed_login_attempts INTEGER DEFAULT 0,
      locked_until          DATETIME,
      permissions           TEXT    DEFAULT '{}',
      notes                 TEXT,
      must_change_password  INTEGER DEFAULT 0,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing_history (
      id                 TEXT PRIMARY KEY,
      product_id         TEXT NOT NULL,
      purchase_price_usd REAL,
      purchase_cost      REAL,
      sale_price         REAL,
      buffer_percentage  REAL,
      profit_percentage  REAL,
      exchange_rate_used REAL,
      price_locked       INTEGER,
      changed_by         TEXT,
      change_reason      TEXT,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indexes
    CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_unique_name
      ON api_keys(service_name, display_name) WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_marketplace_orders_platform_env
      ON marketplace_orders(platform, environment, package_last_modified_at);
    CREATE INDEX IF NOT EXISTS idx_marketplace_orders_external
      ON marketplace_orders(platform, environment, external_order_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_orders_sale
      ON marketplace_orders(sale_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_order
      ON marketplace_order_lines(marketplace_order_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_match
      ON marketplace_order_lines(matched_product_id);
    CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_barcode
      ON marketplace_order_lines(platform, environment, barcode);
    CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_stock_code
      ON marketplace_order_lines(platform, environment, stock_code);

    CREATE INDEX IF NOT EXISTS idx_transactions_type_date   ON transactions(type, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_platform    ON transactions(platform);
    CREATE INDEX IF NOT EXISTS idx_products_status          ON products(status);
    CREATE INDEX IF NOT EXISTS idx_recurring_plans_status   ON recurring_payment_plans(is_active);
    CREATE INDEX IF NOT EXISTS idx_recurring_occurrences_status ON recurring_payment_occurrences(status);
    CREATE INDEX IF NOT EXISTS idx_product_platforms_product_id ON product_platforms(product_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_platforms_unique_product_platform ON product_platforms(product_id, platform_name);
    CREATE INDEX IF NOT EXISTS idx_product_bom_parent       ON product_bom(parent_product_id);
    CREATE INDEX IF NOT EXISTS idx_product_bom_component    ON product_bom(component_product_id);
    CREATE INDEX IF NOT EXISTS idx_product_images_product_id    ON product_images(product_id);
    CREATE INDEX IF NOT EXISTS idx_sales_status             ON sales(status);
    CREATE INDEX IF NOT EXISTS idx_sales_created_at         ON sales(created_at);
    CREATE INDEX IF NOT EXISTS idx_stock_movements_product  ON stock_movements(product_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user       ON activity_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_entity     ON activity_logs(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_created    ON activity_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_cash_transactions_account ON cash_transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_pricing_history_product  ON pricing_history(product_id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_user   ON dashboard_widgets(user_id, position);
  `);
}

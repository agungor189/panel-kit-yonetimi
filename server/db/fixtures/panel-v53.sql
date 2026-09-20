-- source-commit: 5f35879a03a2a9fae96bcb75827d0f40a0305694
-- schema-version: 53
-- generated from the historical commit schema.ts and migration runner; do not hand-edit
PRAGMA foreign_keys = OFF;
CREATE TABLE activity_logs (
      id           TEXT    PRIMARY KEY,
      action       TEXT,
      entity_type  TEXT,
      entity_id    TEXT,
      details      TEXT,
      user_id      TEXT,
      actor_username TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE api_keys (
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
CREATE TABLE backup_runs (
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
CREATE TABLE cash_accounts (
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
CREATE TABLE cash_transactions (
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
CREATE TABLE complementary_product_images (
      id TEXT PRIMARY KEY, complementary_product_id TEXT NOT NULL, path TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(complementary_product_id) REFERENCES complementary_products(id) ON DELETE CASCADE
    );
CREATE TABLE complementary_products (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, description TEXT,
      supplier TEXT, supplier_reference TEXT, brand TEXT, size TEXT, notes TEXT, cover_image TEXT,
      unit TEXT NOT NULL DEFAULT 'adet', purchase_price REAL NOT NULL DEFAULT 0,
      unit_weight_kg REAL NOT NULL DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE dashboard_widgets (
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
CREATE TABLE exchange_rates (
      id              TEXT PRIMARY KEY,
      base_currency   TEXT NOT NULL,
      target_currency TEXT NOT NULL,
      rate            REAL NOT NULL,
      source          TEXT,
      fetched_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_active       INTEGER  DEFAULT 1
    );
CREATE TABLE expense_attachments (
      id          TEXT PRIMARY KEY,
      expense_id  TEXT,
      file_name   TEXT,
      file_path   TEXT,
      mime_type   TEXT,
      file_size   INTEGER,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(expense_id) REFERENCES transactions(id) ON DELETE CASCADE
    );
CREATE TABLE firm_notes (
      id         TEXT PRIMARY KEY,
      firm_id    TEXT,
      note       TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE CASCADE
    );
CREATE TABLE firms (
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
CREATE TABLE follow_ups (
      id                  TEXT PRIMARY KEY,
      firm_id             TEXT,
      type                TEXT,
      note                TEXT,
      next_follow_up_date DATETIME,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(firm_id) REFERENCES firms(id) ON DELETE CASCADE
    );
CREATE TABLE inbound_batch_lines (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          line_number INTEGER NOT NULL,
          supplier_code TEXT NOT NULL COLLATE NOCASE,
          product_id TEXT NOT NULL,
          sku_snapshot TEXT NOT NULL,
          product_name_snapshot TEXT NOT NULL,
          lot_number TEXT,
          expected_package_count INTEGER NOT NULL CHECK(expected_package_count > 0),
          units_per_package REAL NOT NULL CHECK(units_per_package > 0),
          last_package_units REAL NOT NULL CHECK(last_package_units > 0),
          total_units REAL NOT NULL CHECK(total_units > 0),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, supplier_no_snapshot TEXT, name_tr_snapshot TEXT, name_en_snapshot TEXT, material_snapshot TEXT, series_snapshot TEXT, model_snapshot TEXT, form_snapshot TEXT, size_snapshot TEXT, unit_weight_g_snapshot REAL NOT NULL DEFAULT 0, package_weight_kg_snapshot REAL NOT NULL DEFAULT 0, total_weight_kg_snapshot REAL NOT NULL DEFAULT 0, image_path_snapshot TEXT,
          UNIQUE(batch_id, line_number),
          FOREIGN KEY(batch_id) REFERENCES inbound_batches(id) ON DELETE RESTRICT,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
        );
CREATE TABLE inbound_batches (
          id TEXT PRIMARY KEY,
          batch_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
          supplier_code TEXT NOT NULL COLLATE NOCASE,
          supplier_name TEXT,
          status TEXT NOT NULL DEFAULT 'DRAFT'
            CHECK(status IN ('DRAFT','READY','RECEIVING','PLACING','COMPLETED','CANCELLED')),
          source_filename TEXT,
          expected_package_count INTEGER NOT NULL DEFAULT 0,
          expected_unit_count REAL NOT NULL DEFAULT 0,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME, lot_number TEXT COLLATE NOCASE, receiving_state TEXT NOT NULL DEFAULT 'active', started_by TEXT, started_at DATETIME, paused_at DATETIME, cancelled_at DATETIME, force_completed_by TEXT, force_complete_reason TEXT,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
        );
CREATE TABLE inbound_lot_lines (
          id TEXT PRIMARY KEY,
          lot_number TEXT NOT NULL COLLATE NOCASE,
          product_id TEXT NOT NULL,
          supplier_code TEXT NOT NULL COLLATE NOCASE,
          package_count INTEGER NOT NULL CHECK(package_count > 0),
          units_per_package REAL NOT NULL CHECK(units_per_package > 0),
          total_units REAL NOT NULL CHECK(total_units > 0),
          package_weight_kg REAL NOT NULL DEFAULT 0,
          total_weight_kg REAL NOT NULL DEFAULT 0,
          source_name TEXT,
          source_hash TEXT,
          created_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(lot_number, product_id),
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
        );
CREATE TABLE inbound_session_events (
          id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL,
          package_id TEXT,
          event_type TEXT NOT NULL,
          actor_id TEXT,
          actor_username TEXT,
          device_id TEXT,
          details TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(batch_id) REFERENCES inbound_batches(id) ON DELETE RESTRICT,
          FOREIGN KEY(package_id) REFERENCES warehouse_packages(id) ON DELETE SET NULL,
          FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE TABLE kit_complementary_items (
      id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, complementary_product_id TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1, product_name_snapshot TEXT NOT NULL,
      unit_snapshot TEXT NOT NULL, purchase_price_snapshot REAL NOT NULL DEFAULT 0,
      unit_weight_kg_snapshot REAL NOT NULL DEFAULT 0, supplier_snapshot TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE,
      FOREIGN KEY(complementary_product_id) REFERENCES complementary_products(id) ON DELETE RESTRICT
    );
CREATE TABLE kit_cuts (
      id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1,
      length_mm REAL NOT NULL, label TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE
    );
CREATE TABLE kit_items (
      id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, product_id TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1, unit_cost REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kit_id, product_id), FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
    );
CREATE TABLE kit_profile_offers (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, supplier TEXT NOT NULL,
      price_per_meter REAL NOT NULL DEFAULT 0, currency TEXT DEFAULT 'TRY', lead_time_days INTEGER,
      supplier_sku TEXT, notes TEXT, is_preferred INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(profile_id) REFERENCES kit_profiles(id) ON DELETE CASCADE
    );
CREATE TABLE kit_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, shape TEXT, dimension TEXT,
      material TEXT, thickness TEXT, supplier TEXT, price_per_meter REAL DEFAULT 0,
      color TEXT, finish TEXT, grade TEXT, weight_per_meter REAL DEFAULT 0,
      stock_length_mm REAL DEFAULT 6000, is_active INTEGER DEFAULT 1, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE kits (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE, description TEXT,
      profile_id TEXT NOT NULL, profile_offer_id TEXT, status TEXT DEFAULT 'active', cover_image TEXT,
      notes TEXT, target_margin REAL DEFAULT 30, sale_price REAL DEFAULT 0, manual_profile_price_per_meter REAL DEFAULT 0,
      cutting_cost REAL DEFAULT 0, labour_cost REAL DEFAULT 0, packaging_cost REAL DEFAULT 0, other_cost REAL DEFAULT 0,
      commission_rate REAL DEFAULT 0, payment_cost REAL DEFAULT 0, shipping_cost REAL DEFAULT 0, vat_rate REAL DEFAULT 20,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(profile_id) REFERENCES kit_profiles(id) ON DELETE RESTRICT,
      FOREIGN KEY(profile_offer_id) REFERENCES kit_profile_offers(id) ON DELETE SET NULL
    );
CREATE TABLE label_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          template_type TEXT NOT NULL DEFAULT 'PACKAGE' CHECK(template_type IN ('PACKAGE','LOCATION')),
          version INTEGER NOT NULL DEFAULT 1,
          template_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0, 1)),
          created_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE TABLE marketplace_order_lines (
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
CREATE TABLE marketplace_orders (
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
CREATE TABLE offers (
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
CREATE TABLE order_counters (
      date_key    TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL DEFAULT 0,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE package_placements (
          id TEXT PRIMARY KEY,
          package_id TEXT NOT NULL,
          from_location_id TEXT,
          to_location_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('PLACE','MOVE')),
          idempotency_key TEXT NOT NULL UNIQUE,
          override_reason TEXT,
          actor_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(package_id) REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
          FOREIGN KEY(from_location_id) REFERENCES warehouse_locations(id) ON DELETE SET NULL,
          FOREIGN KEY(to_location_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT,
          FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
        );
CREATE TABLE packaging_types (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      type              TEXT NOT NULL,
      inner_length_mm   REAL,
      inner_width_mm    REAL,
      inner_height_mm   REAL,
      outer_length_mm   REAL,
      outer_width_mm    REAL,
      outer_height_mm   REAL,
      empty_weight_g    REAL DEFAULT 0,
      max_weight_g      REAL,
      cost              REAL DEFAULT 0,
      active            INTEGER DEFAULT 1,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE panel_api_keys (
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
CREATE TABLE pick_session_components (
      id                          TEXT PRIMARY KEY,
      pick_session_item_id        TEXT NOT NULL,
      component_product_id        TEXT,
      component_sku_snapshot      TEXT NOT NULL,
      component_name_snapshot     TEXT NOT NULL,
      quantity_per_product        REAL NOT NULL,
      picked_product_quantity     REAL NOT NULL,
      total_component_quantity    REAL NOT NULL,
      unit_weight_g_snapshot      REAL NOT NULL DEFAULT 0,
      total_weight_g              REAL NOT NULL DEFAULT 0,
      created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(pick_session_item_id) REFERENCES pick_session_items(id) ON DELETE RESTRICT,
      FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE SET NULL
    );
CREATE TABLE pick_session_items (
      id                            TEXT PRIMARY KEY,
      pick_session_id               TEXT NOT NULL,
      sale_item_id                  TEXT,
      product_id                    TEXT,
      sku_snapshot                  TEXT NOT NULL,
      product_name_snapshot         TEXT NOT NULL,
      product_type_snapshot         TEXT NOT NULL,
      ordered_quantity              REAL NOT NULL,
      picked_quantity               REAL NOT NULL,
      unit_weight_g_snapshot        REAL NOT NULL DEFAULT 0,
      total_weight_g                REAL NOT NULL DEFAULT 0,
      total_component_quantity      REAL NOT NULL DEFAULT 0,
      created_at                    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(pick_session_id) REFERENCES pick_sessions(id) ON DELETE RESTRICT,
      FOREIGN KEY(sale_item_id) REFERENCES sale_items(id) ON DELETE SET NULL,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
    );
CREATE TABLE pick_sessions (
      id                           TEXT PRIMARY KEY,
      pick_number                  TEXT NOT NULL UNIQUE,
      order_id                     TEXT NOT NULL UNIQUE,
      order_code_snapshot          TEXT,
      external_order_id_snapshot   TEXT,
      status                       TEXT NOT NULL DEFAULT 'PICKED'
                                   CHECK(status IN ('WAITING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'SHIPPED', 'CANCELLED')),
      started_by_user_id           TEXT NOT NULL,
      started_by_name_snapshot     TEXT NOT NULL,
      completed_by_user_id         TEXT NOT NULL,
      completed_by_name_snapshot   TEXT NOT NULL,
      started_at                   DATETIME NOT NULL,
      completed_at                 DATETIME NOT NULL,
      total_product_types          INTEGER NOT NULL DEFAULT 0,
      total_sale_product_quantity  REAL NOT NULL DEFAULT 0,
      total_physical_item_quantity REAL NOT NULL DEFAULT 0,
      total_net_weight_g           REAL NOT NULL DEFAULT 0,
      note                         TEXT,
      created_at                   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at                   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(order_id) REFERENCES sales(id) ON DELETE RESTRICT,
      FOREIGN KEY(started_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
      FOREIGN KEY(completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
    );
CREATE TABLE pricing_history (
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
CREATE TABLE print_jobs (
          id TEXT PRIMARY KEY,
          package_id TEXT NOT NULL,
          template_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'QUEUED'
            CHECK(status IN ('QUEUED','PROCESSING','PRINTED','FAILED','CANCELLED')),
          printer_name TEXT,
          package_status_before TEXT NOT NULL DEFAULT 'CLAIMED',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          error_message TEXT,
          claimed_at DATETIME,
          printed_at DATETIME,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(package_id) REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
          FOREIGN KEY(template_id) REFERENCES label_templates(id) ON DELETE RESTRICT,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
        );
CREATE TABLE product_bom (
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
CREATE TABLE product_images (
      id          TEXT PRIMARY KEY,
      product_id  TEXT,
      path        TEXT,
      sort_order  INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
CREATE TABLE product_logistics (
      product_id       TEXT PRIMARY KEY,
      box_count        INTEGER,
      units_per_box    INTEGER,
      box_weight_kg    REAL,
      total_weight_kg  REAL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
CREATE TABLE product_platforms (
      id             TEXT    PRIMARY KEY,
      product_id     TEXT,
      platform_name  TEXT,
      stock          INTEGER DEFAULT 0,
      price          REAL,
      is_listed      INTEGER DEFAULT 0,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
CREATE TABLE product_reserve_locations (
      id          TEXT PRIMARY KEY,
      product_id  TEXT NOT NULL,
      location    TEXT NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(product_id, location),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
CREATE TABLE products (
      id                      TEXT    PRIMARY KEY,
      name                    TEXT,
      name_tr                 TEXT,
      name_en                 TEXT,
      title                   TEXT    NOT NULL,
      warehouse_location      TEXT,
      sku                     TEXT    UNIQUE,
      supplier_code           TEXT,
      barcode                 TEXT,
      category                TEXT,
      model                   TEXT,
      description             TEXT,
      material                TEXT,
      product_series          TEXT,
      tube_type_code          TEXT,
      size                    TEXT,
      size_code               TEXT,
      form_code               TEXT,
      pipe_size               TEXT,
      connection_type         TEXT,
      usage_area              TEXT,
      supplier                TEXT,
      min_stock_level         INTEGER DEFAULT 50,
      central_stock           INTEGER DEFAULT 0,
      product_type            TEXT    DEFAULT 'simple',
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
      weight_grams            REAL    DEFAULT 0,
      length_mm               REAL,
      width_mm                REAL,
      height_mm               REAL,
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
CREATE TABLE recurring_payment_occurrences (
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
CREATE TABLE recurring_payment_plans (
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
CREATE TABLE sale_items (
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
CREATE TABLE sales (
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
      warehouse_picker_user_id   TEXT,
      warehouse_picker_name      TEXT,
      warehouse_picking_started_at DATETIME,
      warehouse_picking_completed_at DATETIME,
      created_at                 DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at                 DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
CREATE TABLE shipping_volume_rules (
      id              TEXT PRIMARY KEY,
      carrier_code    TEXT NOT NULL,
      service_code    TEXT,
      divisor_cm3     REAL NOT NULL CHECK(divisor_cm3 > 0),
      active          INTEGER DEFAULT 1,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(carrier_code, service_code)
    );
CREATE TABLE stock_movements (
      id             TEXT    PRIMARY KEY,
      product_id     TEXT,
      platform_name  TEXT,
      change_amount  INTEGER,
      reason         TEXT,
      type           TEXT    DEFAULT 'ADJUST',
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
CREATE TABLE transactions (
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
CREATE TABLE users (
      id                    TEXT PRIMARY KEY,
      username              TEXT UNIQUE NOT NULL,
      email                 TEXT,
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
CREATE TABLE warehouse_locations (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE COLLATE NOCASE,
          zone TEXT,
          aisle TEXT,
          rack TEXT,
          shelf TEXT,
          bin TEXT,
          package_capacity INTEGER NOT NULL DEFAULT 1 CHECK(package_capacity > 0),
          active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
          notes TEXT,
          created_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE TABLE warehouse_package_movements (
          id TEXT PRIMARY KEY,
          package_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          movement_type TEXT NOT NULL CHECK(movement_type IN ('INBOUND','PICK','COUNT_ADJUST','DAMAGE','CANCEL')),
          quantity_delta REAL NOT NULL,
          reference_type TEXT NOT NULL,
          reference_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          actor_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(package_id) REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
          FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL
        );
CREATE TABLE warehouse_packages (
          id TEXT PRIMARY KEY,
          package_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
          batch_id TEXT NOT NULL,
          batch_line_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          supplier_code TEXT NOT NULL COLLATE NOCASE,
          package_number INTEGER NOT NULL CHECK(package_number > 0),
          total_packages INTEGER NOT NULL CHECK(total_packages > 0),
          planned_quantity REAL NOT NULL CHECK(planned_quantity > 0),
          remaining_quantity REAL NOT NULL CHECK(remaining_quantity >= 0),
          status TEXT NOT NULL DEFAULT 'EXPECTED'
            CHECK(status IN ('EXPECTED','CLAIMED','LABEL_QUEUED','LABELED','PLACED','OPEN','EMPTY','PRINT_FAILED','MISSING','DAMAGED','QUARANTINED','CANCELLED')),
          claim_token TEXT,
          claimed_by TEXT,
          claim_expires_at DATETIME,
          label_template_id TEXT,
          current_location_id TEXT,
          print_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          labeled_at DATETIME,
          placed_at DATETIME, recommended_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL, recommended_at DATETIME,
          UNIQUE(batch_line_id, package_number),
          FOREIGN KEY(batch_id) REFERENCES inbound_batches(id) ON DELETE RESTRICT,
          FOREIGN KEY(batch_line_id) REFERENCES inbound_batch_lines(id) ON DELETE RESTRICT,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
          FOREIGN KEY(claimed_by) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(label_template_id) REFERENCES label_templates(id) ON DELETE SET NULL,
          FOREIGN KEY(current_location_id) REFERENCES warehouse_locations(id) ON DELETE SET NULL
        );
CREATE TABLE warehouse_pick_progress (
      order_id          TEXT NOT NULL,
      product_id        TEXT NOT NULL,
      sku               TEXT,
      required_quantity REAL NOT NULL,
      picked_quantity   REAL NOT NULL DEFAULT 0,
      picker_user_id    TEXT NOT NULL,
      picker_name       TEXT NOT NULL,
      verified_by       TEXT,
      verified_code_type TEXT CHECK(verified_code_type IN ('sku', 'barcode', 'location')),
      completed_at      DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(order_id, product_id),
      FOREIGN KEY(order_id) REFERENCES sales(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
    );
CREATE TABLE warehouse_sequences (
          sequence_key TEXT PRIMARY KEY,
          next_value INTEGER NOT NULL DEFAULT 1 CHECK(next_value > 0),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
CREATE TABLE warehouse_stock_counts (
          id TEXT PRIMARY KEY,
          package_id TEXT NOT NULL,
          location_id TEXT,
          previous_quantity REAL NOT NULL,
          counted_quantity REAL NOT NULL CHECK(counted_quantity >= 0),
          idempotency_key TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(package_id) REFERENCES warehouse_packages(id) ON DELETE RESTRICT,
          FOREIGN KEY(location_id) REFERENCES warehouse_locations(id) ON DELETE SET NULL,
          FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
        );
CREATE INDEX idx_activity_logs_actor_username ON activity_logs(actor_username);
CREATE INDEX idx_activity_logs_created    ON activity_logs(created_at);
CREATE INDEX idx_activity_logs_entity     ON activity_logs(entity_type, entity_id);
CREATE INDEX idx_activity_logs_user       ON activity_logs(user_id);
CREATE UNIQUE INDEX idx_api_keys_unique_name
      ON api_keys(service_name, display_name) WHERE deleted_at IS NULL;
CREATE INDEX idx_backup_runs_cloud_status
        ON backup_runs(cloud_status, cloud_uploaded_at);
CREATE INDEX idx_backup_runs_kind_status
        ON backup_runs(backup_kind, status, completed_at);
CREATE INDEX idx_backup_runs_started_at
        ON backup_runs(started_at);
CREATE INDEX idx_cash_transactions_account ON cash_transactions(account_id);
CREATE INDEX idx_cash_transactions_deleted ON cash_transactions(is_deleted);
CREATE INDEX idx_cash_transactions_source ON cash_transactions(source_type, source_id);
CREATE INDEX idx_complementary_product_images_product ON complementary_product_images(complementary_product_id);
CREATE INDEX idx_dashboard_widgets_user   ON dashboard_widgets(user_id, position);
CREATE UNIQUE INDEX idx_inbound_batches_lot
          ON inbound_batches(lot_number) WHERE lot_number IS NOT NULL AND TRIM(lot_number) <> '';
CREATE INDEX idx_inbound_batches_supplier_status
          ON inbound_batches(supplier_code, status, created_at);
CREATE INDEX idx_inbound_lines_batch
          ON inbound_batch_lines(batch_id, line_number);
CREATE INDEX idx_inbound_lot_lines_lot
          ON inbound_lot_lines(lot_number, supplier_code);
CREATE INDEX idx_inbound_session_events_batch
          ON inbound_session_events(batch_id, created_at);
CREATE INDEX idx_kit_complementary_items_kit ON kit_complementary_items(kit_id);
CREATE INDEX idx_kit_items_product ON kit_items(product_id);
CREATE INDEX idx_kit_profile_offers_profile ON kit_profile_offers(profile_id);
CREATE INDEX idx_kits_profile ON kits(profile_id);
CREATE UNIQUE INDEX idx_label_templates_one_default
          ON label_templates(template_type) WHERE is_default = 1 AND active = 1;
CREATE INDEX idx_marketplace_order_lines_barcode
      ON marketplace_order_lines(platform, environment, barcode);
CREATE INDEX idx_marketplace_order_lines_match
      ON marketplace_order_lines(matched_product_id);
CREATE INDEX idx_marketplace_order_lines_order
      ON marketplace_order_lines(marketplace_order_id);
CREATE INDEX idx_marketplace_order_lines_stock_code
      ON marketplace_order_lines(platform, environment, stock_code);
CREATE INDEX idx_marketplace_orders_external
      ON marketplace_orders(platform, environment, external_order_id);
CREATE INDEX idx_marketplace_orders_platform_env
      ON marketplace_orders(platform, environment, package_last_modified_at);
CREATE INDEX idx_marketplace_orders_sale
      ON marketplace_orders(sale_id);
CREATE INDEX idx_package_movements_product
          ON warehouse_package_movements(product_id, created_at);
CREATE INDEX idx_pick_session_components_item
      ON pick_session_components(pick_session_item_id);
CREATE INDEX idx_pick_session_items_search
      ON pick_session_items(sku_snapshot, product_name_snapshot);
CREATE INDEX idx_pick_session_items_session
      ON pick_session_items(pick_session_id);
CREATE INDEX idx_pick_sessions_completed
      ON pick_sessions(completed_at DESC);
CREATE INDEX idx_pick_sessions_picker
      ON pick_sessions(completed_by_user_id, completed_at DESC);
CREATE INDEX idx_pricing_history_product  ON pricing_history(product_id);
CREATE INDEX idx_print_jobs_worker
          ON print_jobs(status, attempts, created_at);
CREATE INDEX idx_product_bom_component    ON product_bom(component_product_id);
CREATE INDEX idx_product_bom_parent       ON product_bom(parent_product_id);
CREATE INDEX idx_product_images_product_id    ON product_images(product_id);
CREATE INDEX idx_product_platforms_product_id ON product_platforms(product_id);
CREATE UNIQUE INDEX idx_product_platforms_unique_product_platform ON product_platforms(product_id, platform_name);
CREATE INDEX idx_product_reserve_locations_product
      ON product_reserve_locations(product_id, sort_order);
CREATE INDEX idx_products_form_code    ON products(form_code);
CREATE INDEX idx_products_name_en ON products(name_en);
CREATE INDEX idx_products_name_tr ON products(name_tr);
CREATE INDEX idx_products_series       ON products(product_series);
CREATE INDEX idx_products_size_code    ON products(size_code);
CREATE INDEX idx_products_status          ON products(status);
CREATE INDEX idx_products_supplier_code ON products(supplier_code);
CREATE INDEX idx_products_tube_type    ON products(tube_type_code);
CREATE INDEX idx_products_visibility
          ON products(is_sellable, visible_in_catalog, exclude_from_analysis);
CREATE INDEX idx_recurring_occurrences_status ON recurring_payment_occurrences(status);
CREATE INDEX idx_recurring_plans_status   ON recurring_payment_plans(is_active);
CREATE INDEX idx_sales_created_at         ON sales(created_at);
CREATE UNIQUE INDEX idx_sales_order_code_unique
        ON sales(order_code) WHERE order_code IS NOT NULL AND order_code <> ''
      ;
CREATE UNIQUE INDEX idx_sales_platform_external_order
        ON sales(platform, external_order_id)
        WHERE external_order_id IS NOT NULL AND TRIM(external_order_id) <> ''
      ;
CREATE INDEX idx_sales_status             ON sales(status);
CREATE INDEX idx_stock_movements_product  ON stock_movements(product_id);
CREATE INDEX idx_transactions_platform    ON transactions(platform);
CREATE INDEX idx_transactions_type_date   ON transactions(type, date);
CREATE UNIQUE INDEX idx_users_email_unique
          ON users(email) WHERE email IS NOT NULL AND email != '';
CREATE INDEX idx_warehouse_packages_claim
          ON warehouse_packages(supplier_code, status, claim_expires_at, batch_id, batch_line_id, package_number);
CREATE INDEX idx_warehouse_packages_location
          ON warehouse_packages(current_location_id, status);
CREATE INDEX idx_warehouse_packages_pick
          ON warehouse_packages(product_id, status, batch_id, batch_line_id, package_number);
CREATE INDEX idx_warehouse_packages_recommended_location
          ON warehouse_packages(recommended_location_id, status);
CREATE INDEX idx_warehouse_pick_progress_picker
      ON warehouse_pick_progress(picker_user_id, updated_at);
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('ba6fab62a14fd2a65dae489abab9bab6', 'admin', 'dashboard_month_revenue', 'Bu Ay Toplam Ciro', 'Aktif satışlardan bu ay oluşan net ciro.', 'kpi', 'overview', 'small', 0, 1, '{"grid":{"x":0,"y":0,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('7231b1a29e39f603f0e1d1877786fa70', 'admin', 'dashboard_total_expenses', 'Toplam Giderler', 'Bu ay gerçekleşen giderler ve bekleyen periyodik ödemeler.', 'kpi', 'overview', 'small', 1, 1, '{"grid":{"x":4,"y":0,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('74ef7f1158913f89e058ae7b33d86e7c', 'admin', 'dashboard_est_net_profit', 'Tahmini Net Kar', 'Bu ay toplam ciro eksi toplam gider tahmini.', 'kpi', 'overview', 'small', 2, 1, '{"grid":{"x":8,"y":0,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('dabcf91ccb2c745f5fc2b97bbb6c9e3c', 'admin', 'dashboard_low_stock', 'Kritik Stok', 'Merkez depo stoğu kritik seviyede olan ürün sayısı.', 'kpi', 'overview', 'small', 3, 1, '{"grid":{"x":0,"y":3,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('3a807ab882d5bd33fd5daeb3dedebd52', 'admin', 'dashboard_stock_sales_value', 'Toplam Stok Satış Değeri', 'Merkez depo stoklarının satış fiyatı üzerinden potansiyel değeri.', 'kpi', 'overview', 'small', 4, 1, '{"grid":{"x":4,"y":3,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('f974e4160793a83cd34666d77bc46e81', 'admin', 'dashboard_stock_cost_value', 'Toplam Stok Maliyeti', 'Merkez depo stoklarının alış maliyeti toplamı.', 'kpi', 'overview', 'small', 5, 1, '{"grid":{"x":8,"y":3,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('65f4849122ea36cced0a60ba2931f8bf', 'admin', 'dashboard_stock_est_gross_profit', 'Tahmini Brüt Kâr', 'Mevcut stoktan beklenen potansiyel brüt kâr.', 'kpi', 'overview', 'small', 6, 1, '{"grid":{"x":0,"y":6,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "dashboard_widgets" ("id", "user_id", "widget_key", "title", "description", "widget_type", "source_module", "size", "position", "is_visible", "settings_json", "created_at", "updated_at") VALUES ('2da8c7c6e5781c32d8bf15627cd06504', 'admin', 'dashboard_avg_profit_margin', 'Ortalama Kâr Marjı', 'Mevcut stokların satış değerine göre ortalama kâr marjı.', 'kpi', 'overview', 'small', 7, 1, '{"grid":{"x":4,"y":6,"w":4,"h":3}}', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profile_offers" ("id", "profile_id", "supplier", "price_per_meter", "currency", "lead_time_days", "supplier_sku", "notes", "is_preferred", "created_at", "updated_at") VALUES ('fixed-offer-aluminyum-kare-20x20-1-5-sandemir', 'fixed-profile-aluminyum-kare-20x20-mm-1-5-mm', 'sandemir', 24.6, 'TRY', 0, '', '', 0, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-25-mm', 'Yuvarlak 25 mm', 'Yuvarlak', '25 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-60-mm', 'Yuvarlak 60 mm', 'Yuvarlak', '60 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-3-4-in-', 'Yuvarlak 3/4 inç', 'Yuvarlak', '3/4 inç', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-1-in-', 'Yuvarlak 1 inç', 'Yuvarlak', '1 inç', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-1-1-2-in-', 'Yuvarlak 1 1/2 inç', 'Yuvarlak', '1 1/2 inç', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-2-in-', 'Yuvarlak 2 inç', 'Yuvarlak', '2 inç', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-20-20-mm', 'Kare 20×20 mm', 'Kare', '20×20 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-25-25-mm', 'Kare 25×25 mm', 'Kare', '25×25 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-30-30-mm', 'Kare 30×30 mm', 'Kare', '30×30 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('default-profile-40-40-mm', 'Kare 40×40 mm', 'Kare', '40×40 mm', 'Karbon Çelik', NULL, NULL, 0, NULL, NULL, NULL, 0, 6000, 0, NULL, '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-25x25-mm-1-0-mm', 'Demir Döküm Kare 25x25 mm / 1.0 mm', 'Kare', '25x25 mm', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-25x25-mm-1-5-mm', 'Demir Döküm Kare 25x25 mm / 1.5 mm', 'Kare', '25x25 mm', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-25x25-mm-2-0-mm', 'Demir Döküm Kare 25x25 mm / 2.0 mm', 'Kare', '25x25 mm', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-25x25-mm-2-5-mm', 'Demir Döküm Kare 25x25 mm / 2.5 mm', 'Kare', '25x25 mm', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-40x40-mm-1-0-mm', 'Demir Döküm Kare 40x40 mm / 1.0 mm', 'Kare', '40x40 mm', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-40x40-mm-1-5-mm', 'Demir Döküm Kare 40x40 mm / 1.5 mm', 'Kare', '40x40 mm', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-40x40-mm-2-0-mm', 'Demir Döküm Kare 40x40 mm / 2.0 mm', 'Kare', '40x40 mm', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-kare-40x40-mm-2-5-mm', 'Demir Döküm Kare 40x40 mm / 2.5 mm', 'Kare', '40x40 mm', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-3-4-inc-26-9-mm-1-0-mm', 'Demir Döküm Yuvarlak 3/4 inç (26.9 mm) / 1.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-3-4-inc-26-9-mm-1-5-mm', 'Demir Döküm Yuvarlak 3/4 inç (26.9 mm) / 1.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-3-4-inc-26-9-mm-2-0-mm', 'Demir Döküm Yuvarlak 3/4 inç (26.9 mm) / 2.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-3-4-inc-26-9-mm-2-5-mm', 'Demir Döküm Yuvarlak 3/4 inç (26.9 mm) / 2.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-inc-33-7-mm-1-0-mm', 'Demir Döküm Yuvarlak 1 inç (33.7 mm) / 1.0 mm', 'Yuvarlak', '1 inç (33.7 mm)', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-inc-33-7-mm-1-5-mm', 'Demir Döküm Yuvarlak 1 inç (33.7 mm) / 1.5 mm', 'Yuvarlak', '1 inç (33.7 mm)', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-inc-33-7-mm-2-0-mm', 'Demir Döküm Yuvarlak 1 inç (33.7 mm) / 2.0 mm', 'Yuvarlak', '1 inç (33.7 mm)', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-inc-33-7-mm-2-5-mm', 'Demir Döküm Yuvarlak 1 inç (33.7 mm) / 2.5 mm', 'Yuvarlak', '1 inç (33.7 mm)', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-5-inc-48-3-mm-1-0-mm', 'Demir Döküm Yuvarlak 1.5 inç (48.3 mm) / 1.0 mm', 'Yuvarlak', '1.5 inç (48.3 mm)', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-5-inc-48-3-mm-1-5-mm', 'Demir Döküm Yuvarlak 1.5 inç (48.3 mm) / 1.5 mm', 'Yuvarlak', '1.5 inç (48.3 mm)', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-5-inc-48-3-mm-2-0-mm', 'Demir Döküm Yuvarlak 1.5 inç (48.3 mm) / 2.0 mm', 'Yuvarlak', '1.5 inç (48.3 mm)', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-1-5-inc-48-3-mm-2-5-mm', 'Demir Döküm Yuvarlak 1.5 inç (48.3 mm) / 2.5 mm', 'Yuvarlak', '1.5 inç (48.3 mm)', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-2-inc-60-3-mm-1-0-mm', 'Demir Döküm Yuvarlak 2 inç (60.3 mm) / 1.0 mm', 'Yuvarlak', '2 inç (60.3 mm)', 'Demir Döküm', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-2-inc-60-3-mm-1-5-mm', 'Demir Döküm Yuvarlak 2 inç (60.3 mm) / 1.5 mm', 'Yuvarlak', '2 inç (60.3 mm)', 'Demir Döküm', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-2-inc-60-3-mm-2-0-mm', 'Demir Döküm Yuvarlak 2 inç (60.3 mm) / 2.0 mm', 'Yuvarlak', '2 inç (60.3 mm)', 'Demir Döküm', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-demir-dokum-yuvarlak-2-inc-60-3-mm-2-5-mm', 'Demir Döküm Yuvarlak 2 inç (60.3 mm) / 2.5 mm', 'Yuvarlak', '2 inç (60.3 mm)', 'Demir Döküm', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-yuvarlak-1-inc-1-0-mm', 'Alüminyum Yuvarlak 1 inç / 1.0 mm', 'Yuvarlak', '1 inç', 'Alüminyum', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-yuvarlak-1-inc-1-5-mm', 'Alüminyum Yuvarlak 1 inç / 1.5 mm', 'Yuvarlak', '1 inç', 'Alüminyum', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-yuvarlak-1-inc-2-0-mm', 'Alüminyum Yuvarlak 1 inç / 2.0 mm', 'Yuvarlak', '1 inç', 'Alüminyum', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-yuvarlak-1-inc-2-5-mm', 'Alüminyum Yuvarlak 1 inç / 2.5 mm', 'Yuvarlak', '1 inç', 'Alüminyum', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-20x20-mm-1-0-mm', 'Alüminyum Kare 20x20 mm / 1.0 mm', 'Kare', '20x20 mm', 'Alüminyum', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-20x20-mm-1-5-mm', 'Alüminyum Kare 20x20 mm / 1.5 mm', 'Kare', '20x20 mm', 'Alüminyum', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-20x20-mm-2-0-mm', 'Alüminyum Kare 20x20 mm / 2.0 mm', 'Kare', '20x20 mm', 'Alüminyum', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-20x20-mm-2-5-mm', 'Alüminyum Kare 20x20 mm / 2.5 mm', 'Kare', '20x20 mm', 'Alüminyum', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-30x30-mm-1-0-mm', 'Alüminyum Kare 30x30 mm / 1.0 mm', 'Kare', '30x30 mm', 'Alüminyum', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-30x30-mm-1-5-mm', 'Alüminyum Kare 30x30 mm / 1.5 mm', 'Kare', '30x30 mm', 'Alüminyum', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-30x30-mm-2-0-mm', 'Alüminyum Kare 30x30 mm / 2.0 mm', 'Kare', '30x30 mm', 'Alüminyum', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-aluminyum-kare-30x30-mm-2-5-mm', 'Alüminyum Kare 30x30 mm / 2.5 mm', 'Kare', '30x30 mm', 'Alüminyum', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-ppr-yuvarlak-3-4-inc-26-9-mm-1-0-mm', 'PPR Yuvarlak 3/4 inç (26.9 mm) / 1.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'PPR', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-ppr-yuvarlak-3-4-inc-26-9-mm-1-5-mm', 'PPR Yuvarlak 3/4 inç (26.9 mm) / 1.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'PPR', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-ppr-yuvarlak-3-4-inc-26-9-mm-2-0-mm', 'PPR Yuvarlak 3/4 inç (26.9 mm) / 2.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'PPR', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-ppr-yuvarlak-3-4-inc-26-9-mm-2-5-mm', 'PPR Yuvarlak 3/4 inç (26.9 mm) / 2.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'PPR', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-kare-40x40-mm-1-0-mm', 'Karbon Çelik Kare 40x40 mm / 1.0 mm', 'Kare', '40x40 mm', 'Karbon Çelik', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-kare-40x40-mm-1-5-mm', 'Karbon Çelik Kare 40x40 mm / 1.5 mm', 'Kare', '40x40 mm', 'Karbon Çelik', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-kare-40x40-mm-2-0-mm', 'Karbon Çelik Kare 40x40 mm / 2.0 mm', 'Kare', '40x40 mm', 'Karbon Çelik', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-kare-40x40-mm-2-5-mm', 'Karbon Çelik Kare 40x40 mm / 2.5 mm', 'Kare', '40x40 mm', 'Karbon Çelik', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-yuvarlak-3-4-inc-26-9-mm-1-0-mm', 'Karbon Çelik Yuvarlak 3/4 inç (26.9 mm) / 1.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Karbon Çelik', '1.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-yuvarlak-3-4-inc-26-9-mm-1-5-mm', 'Karbon Çelik Yuvarlak 3/4 inç (26.9 mm) / 1.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Karbon Çelik', '1.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-yuvarlak-3-4-inc-26-9-mm-2-0-mm', 'Karbon Çelik Yuvarlak 3/4 inç (26.9 mm) / 2.0 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Karbon Çelik', '2.0 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "kit_profiles" ("id", "name", "shape", "dimension", "material", "thickness", "supplier", "price_per_meter", "color", "finish", "grade", "weight_per_meter", "stock_length_mm", "is_active", "notes", "created_at", "updated_at") VALUES ('fixed-profile-karbon-celik-yuvarlak-3-4-inc-26-9-mm-2-5-mm', 'Karbon Çelik Yuvarlak 3/4 inç (26.9 mm) / 2.5 mm', 'Yuvarlak', '3/4 inç (26.9 mm)', 'Karbon Çelik', '2.5 mm', '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '', '2026-09-20 12:18:56', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (1, 'add_type_to_stock_movements', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (2, 'add_updated_at_to_sales', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (3, 'add_user_id_to_activity_logs', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (4, 'add_income_transaction_ref_to_sales', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (5, 'add_return_support_to_sales', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (6, 'add_users_extra_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (7, 'add_permissions_to_users', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (8, 'add_pricing_history_table', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (9, 'add_indexes_for_performance', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (10, 'normalize_pipe_size_column', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (11, 'add_sale_items_line_profit', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (12, 'legacy_products_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (13, 'legacy_transactions_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (14, 'legacy_sales_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (15, 'legacy_sale_items_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (16, 'legacy_misc_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (17, 'legacy_cash_accounts_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (18, 'add_must_change_password_to_users', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (19, 'fix_widget_key_typo', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (20, 'add_cash_transactions_soft_delete', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (21, 'dedupe_product_platforms_unique_index', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (22, 'add_products_central_stock', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (23, 'ensure_users_management_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (24, 'add_actor_username_to_activity_logs', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (25, 'add_dashboard_overview_widgets', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (26, 'index_dashboard_widgets_by_user', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (27, 'add_sales_order_codes', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (28, 'add_configurable_sales_channels', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (29, 'add_sales_external_order_id', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (30, 'add_backup_runs', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (31, 'add_cloud_backup_tracking', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (32, 'add_marketplace_orders', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (33, 'add_marketplace_order_lines', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (34, 'add_product_bom_and_carbon_steel_assemblies', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (35, 'add_sku_taxonomy_columns', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (36, 'backfill_product_series', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (37, 'normalize_product_series_codes', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (38, 'add_independent_kit_management', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (39, 'seed_standard_profile_dimensions', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (40, 'add_profile_offers_and_kit_cost_snapshots', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (42, 'add_independent_complementary_product_catalog', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (43, 'add_complementary_product_images', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (44, 'add_kit_cost_analysis_fields', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (45, 'create_complementary_product_image_gallery', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (46, 'persist_kit_cut_and_complementary_extra_fields', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (47, 'add_manual_kit_profile_meter_price', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (48, 'seed_fixed_kit_profile_variants', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (49, 'add_warehouse_picker_lock_and_progress', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (50, 'add_multilingual_product_names_and_logistics', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (51, 'add_pick_history_and_packaging_foundation', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (52, 'add_warehouse_inbound_packages_and_print_queue', '2026-09-20 12:18:56');
INSERT INTO "schema_migrations" ("version", "name", "applied_at") VALUES (53, 'add_lot_driven_receiving_sessions', '2026-09-20 12:18:56');
INSERT INTO "settings" ("key", "value") VALUES ('sales_channels', '["Satış Sistemi","Website","Trendyol","Hepsiburada","Amazon","N11"]');
INSERT INTO "settings" ("key", "value") VALUES ('commission_rates', '{"Satış Sistemi":0,"Website":0,"Trendyol":15,"Hepsiburada":15,"Amazon":10,"N11":15}');
INSERT INTO "settings" ("key", "value") VALUES ('backup_config', '{"enabled":true,"run_at":"03:00","retention_days":7,"include_uploads":true,"uploads_strategy":"smart","weekly_full_day":0}');
INSERT INTO "settings" ("key", "value") VALUES ('trendyol_config', '{"enabled":false,"environment":"stage","api_key_id":"","sync_window_days":14,"store_front_code":""}');
PRAGMA foreign_keys = ON;


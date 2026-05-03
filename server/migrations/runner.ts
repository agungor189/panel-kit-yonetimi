import Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

// Each migration runs exactly once. Never modify an existing migration — add a new one.
const migrations: Migration[] = [
  {
    version: 1,
    name: "add_type_to_stock_movements",
    up(db) {
      try { db.exec("ALTER TABLE stock_movements ADD COLUMN type TEXT DEFAULT 'ADJUST'"); } catch (_) {}
    },
  },
  {
    version: 2,
    name: "add_updated_at_to_sales",
    up(db) {
      try { db.exec("ALTER TABLE sales ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP"); } catch (_) {}
    },
  },
  {
    version: 3,
    name: "add_user_id_to_activity_logs",
    up(db) {
      try { db.exec("ALTER TABLE activity_logs ADD COLUMN user_id TEXT"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON activity_logs(user_id)"); } catch (_) {}
    },
  },
  {
    version: 4,
    name: "add_income_transaction_ref_to_sales",
    up(db) {
      // Link sales to their auto-created income transaction
      try { db.exec("ALTER TABLE sales ADD COLUMN income_transaction_id TEXT"); } catch (_) {}
    },
  },
  {
    version: 5,
    name: "add_return_support_to_sales",
    up(db) {
      try { db.exec("ALTER TABLE sales ADD COLUMN return_reason TEXT"); } catch (_) {}
      try { db.exec("ALTER TABLE sales ADD COLUMN returned_at DATETIME"); } catch (_) {}
    },
  },
  {
    version: 6,
    name: "add_users_extra_columns",
    up(db) {
      // is_active flag + last_login tracking
      try { db.exec("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1"); } catch (_) {}
      try { db.exec("ALTER TABLE users ADD COLUMN last_login_at DATETIME"); } catch (_) {}
      try { db.exec("ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0"); } catch (_) {}
      try { db.exec("ALTER TABLE users ADD COLUMN locked_until DATETIME"); } catch (_) {}
    },
  },
  {
    version: 7,
    name: "add_permissions_to_users",
    up(db) {
      // JSON column for fine-grained per-user module permissions (overrides role defaults)
      try { db.exec("ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'"); } catch (_) {}
      try { db.exec("ALTER TABLE users ADD COLUMN notes TEXT"); } catch (_) {}
    },
  },
  {
    version: 8,
    name: "add_pricing_history_table",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pricing_history (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          purchase_price_usd REAL,
          purchase_cost REAL,
          sale_price REAL,
          buffer_percentage REAL,
          profit_percentage REAL,
          exchange_rate_used REAL,
          price_locked INTEGER,
          changed_by TEXT,
          change_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pricing_history_product ON pricing_history(product_id);
      `);
    },
  },
  {
    version: 9,
    name: "add_indexes_for_performance",
    up(db) {
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_activity_logs_entity ON activity_logs(entity_type, entity_id)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_cash_transactions_account ON cash_transactions(account_id)"); } catch (_) {}
    },
  },
  {
    version: 10,
    name: "normalize_pipe_size_column",
    up(db) {
      // Ensure normalized_pipe_size is always filled from normalized_size as fallback
      try {
        db.exec(`
          UPDATE products
          SET normalized_pipe_size = normalized_size
          WHERE normalized_pipe_size IS NULL AND normalized_size IS NOT NULL
        `);
      } catch (_) {}
    },
  },
  {
    version: 11,
    name: "add_sale_items_line_profit",
    up(db) {
      // shipping/commission apportioned per line for accurate per-item reporting
      try { db.exec("ALTER TABLE sale_items ADD COLUMN commission_amount REAL DEFAULT 0"); } catch (_) {}
      try { db.exec("ALTER TABLE sale_items ADD COLUMN shipping_share REAL DEFAULT 0"); } catch (_) {}
    },
  },
  {
    version: 12,
    name: "legacy_products_columns",
    up(db) {
      // Columns that were previously added via unversioned try/catch blocks in server.ts.
      // Safe to re-run: each statement is wrapped in try/catch.
      const cols = [
        "ALTER TABLE products ADD COLUMN purchase_price_usd REAL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN buffer_percentage REAL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN exchange_rate_used REAL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN profit_percentage REAL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN price_locked INTEGER DEFAULT 0",
        "ALTER TABLE products ADD COLUMN weight REAL DEFAULT 0",
        "ALTER TABLE products ADD COLUMN normalized_material TEXT",
        "ALTER TABLE products ADD COLUMN normalized_model TEXT",
        "ALTER TABLE products ADD COLUMN normalized_size TEXT",
        "ALTER TABLE products ADD COLUMN normalized_tube_type TEXT",
        "ALTER TABLE products ADD COLUMN pipe_size TEXT",
        "ALTER TABLE products ADD COLUMN normalized_pipe_size TEXT",
        "ALTER TABLE products ADD COLUMN material TEXT",
        "ALTER TABLE products ADD COLUMN size TEXT",
        "ALTER TABLE products ADD COLUMN connection_type TEXT",
        "ALTER TABLE products ADD COLUMN usage_area TEXT",
        "ALTER TABLE products ADD COLUMN supplier TEXT",
        "ALTER TABLE products ADD COLUMN min_stock_level INTEGER DEFAULT 50",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
      // Backfill min_stock_level
      try { db.exec("UPDATE products SET min_stock_level = 50 WHERE min_stock_level IS NULL OR min_stock_level < 1"); } catch (_) {}
      // Backfill pipe_size from size
      try { db.exec("UPDATE products SET pipe_size = size WHERE pipe_size IS NULL AND size IS NOT NULL"); } catch (_) {}
    },
  },
  {
    version: 13,
    name: "legacy_transactions_columns",
    up(db) {
      const cols = [
        "ALTER TABLE transactions ADD COLUMN recurring_id TEXT",
        "ALTER TABLE transactions ADD COLUMN title TEXT",
        "ALTER TABLE transactions ADD COLUMN description TEXT",
        "ALTER TABLE transactions ADD COLUMN payment_method TEXT",
        "ALTER TABLE transactions ADD COLUMN supplier TEXT",
        "ALTER TABLE transactions ADD COLUMN invoice_number TEXT",
        "ALTER TABLE transactions ADD COLUMN expense_type TEXT",
        "ALTER TABLE transactions ADD COLUMN payer_person_id TEXT",
        "ALTER TABLE transactions ADD COLUMN will_be_refunded INTEGER DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN refund_status TEXT",
        "ALTER TABLE transactions ADD COLUMN is_invoice INTEGER DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN invoice_name TEXT",
        "ALTER TABLE transactions ADD COLUMN is_stock_related INTEGER DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN distribute_to_product_cost INTEGER DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN document_url TEXT",
        "ALTER TABLE transactions ADD COLUMN currency TEXT DEFAULT 'TRY'",
        "ALTER TABLE transactions ADD COLUMN amount_try REAL DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE transactions ADD COLUMN exchange_rate_at_transaction REAL DEFAULT 1",
        "ALTER TABLE transactions ADD COLUMN cash_account_id TEXT",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
    },
  },
  {
    version: 14,
    name: "legacy_sales_columns",
    up(db) {
      const cols = [
        "ALTER TABLE sales ADD COLUMN platform TEXT",
        "ALTER TABLE sales ADD COLUMN commission_rate REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN shipping_cost REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN discount REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN net_profit REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN packaging_cost REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN ad_spend REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN other_expenses REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN net_total REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN gross_profit REAL DEFAULT 0",
        "ALTER TABLE sales ADD COLUMN exchange_rate_at_transaction REAL DEFAULT 1",
        "ALTER TABLE sales ADD COLUMN cash_account_id TEXT",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
    },
  },
  {
    version: 15,
    name: "legacy_sale_items_columns",
    up(db) {
      const cols = [
        "ALTER TABLE sale_items ADD COLUMN unit_price REAL DEFAULT 0",
        "ALTER TABLE sale_items ADD COLUMN purchase_cost REAL DEFAULT 0",
        "ALTER TABLE sale_items ADD COLUMN net_profit REAL DEFAULT 0",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
    },
  },
  {
    version: 16,
    name: "legacy_misc_columns",
    up(db) {
      const cols = [
        "ALTER TABLE api_keys ADD COLUMN deleted_at DATETIME DEFAULT NULL",
        "ALTER TABLE recurring_payment_plans ADD COLUMN start_month INTEGER",
        "ALTER TABLE recurring_payment_plans ADD COLUMN week_day INTEGER",
        "ALTER TABLE recurring_payment_plans ADD COLUMN custom_interval_days INTEGER",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
    },
  },
  {
    version: 17,
    name: "legacy_cash_accounts_columns",
    up(db) {
      const cols = [
        "ALTER TABLE cash_accounts ADD COLUMN credit_limit REAL DEFAULT 0",
        "ALTER TABLE cash_accounts ADD COLUMN cutoff_day INTEGER",
        "ALTER TABLE cash_accounts ADD COLUMN payment_due_day INTEGER",
        "ALTER TABLE cash_accounts ADD COLUMN is_liability INTEGER DEFAULT 0",
        "ALTER TABLE cash_accounts ADD COLUMN statement_day INTEGER",
        "ALTER TABLE cash_accounts ADD COLUMN due_day INTEGER",
        "ALTER TABLE cash_accounts ADD COLUMN bank_name TEXT",
        "ALTER TABLE cash_accounts ADD COLUMN card_last_four TEXT",
        "ALTER TABLE cash_accounts ADD COLUMN current_debt REAL DEFAULT 0",
        "ALTER TABLE cash_accounts ADD COLUMN available_limit REAL DEFAULT 0",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
    },
  },
  {
    version: 18,
    name: "add_must_change_password_to_users",
    up(db) {
      try { db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0"); } catch (_) {}
    },
  },
  {
    version: 19,
    name: "fix_widget_key_typo",
    up(db) {
      // Frontend looks for "product_reorder_summary" but seed had "product_reorder_summar"
      // — widget never rendered. Fix existing rows.
      try {
        db.prepare(
          "UPDATE dashboard_widgets SET widget_key = 'product_reorder_summary' WHERE widget_key = 'product_reorder_summar'"
        ).run();
      } catch (_) {}
    },
  },
  {
    version: 20,
    name: "add_cash_transactions_soft_delete",
    up(db) {
      try { db.exec("ALTER TABLE cash_transactions ADD COLUMN transaction_date DATETIME"); } catch (_) {}
      try { db.exec("ALTER TABLE cash_transactions ADD COLUMN is_deleted INTEGER DEFAULT 0"); } catch (_) {}
      try { db.exec("UPDATE cash_transactions SET is_deleted = 0 WHERE is_deleted IS NULL"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_cash_transactions_source ON cash_transactions(source_type, source_id)"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_cash_transactions_deleted ON cash_transactions(is_deleted)"); } catch (_) {}
    },
  },
  {
    version: 21,
    name: "dedupe_product_platforms_unique_index",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(product_platforms)").all() as { name: string }[]).map((col) => col.name),
      );
      if (!columns.has("product_id") || !columns.has("platform_name")) return;

      try {
        db.exec("UPDATE product_platforms SET platform_name = TRIM(platform_name) WHERE platform_name IS NOT NULL");
      } catch (_) {}

      const orderParts = [];
      if (columns.has("updated_at")) orderParts.push("datetime(COALESCE(updated_at, '1970-01-01')) DESC");
      if (columns.has("created_at")) orderParts.push("datetime(COALESCE(created_at, '1970-01-01')) DESC");
      orderParts.push("rowid DESC");
      const orderClause = `ORDER BY ${orderParts.join(", ")}`;

      const duplicateGroups = db.prepare(`
        SELECT product_id, platform_name
        FROM product_platforms
        WHERE product_id IS NOT NULL
          AND platform_name IS NOT NULL
        GROUP BY product_id, platform_name
        HAVING COUNT(*) > 1
      `).all() as { product_id: string; platform_name: string }[];

      for (const group of duplicateGroups) {
        const rows = db.prepare(`
          SELECT rowid as _rowid, *
          FROM product_platforms
          WHERE product_id = ? AND platform_name = ?
          ${orderClause}
        `).all(group.product_id, group.platform_name) as any[];

        if (rows.length <= 1) continue;

        const keeper = rows[0];
        const stockTotal = columns.has("stock")
          ? rows.reduce((total, row) => total + (Number(row.stock) || 0), 0)
          : null;
        const priceRow = columns.has("price")
          ? rows.find((row) => row.price !== null && row.price !== undefined && row.price !== "")
          : null;
        const isListed = columns.has("is_listed")
          ? (rows.some((row) => Number(row.is_listed) === 1) ? 1 : 0)
          : null;

        const assignments: string[] = [];
        const values: unknown[] = [];
        if (columns.has("stock")) {
          assignments.push("stock = ?");
          values.push(stockTotal);
        }
        if (columns.has("price")) {
          assignments.push("price = ?");
          values.push(priceRow ? Number(priceRow.price) : null);
        }
        if (columns.has("is_listed")) {
          assignments.push("is_listed = ?");
          values.push(isListed);
        }
        for (const optionalColumn of ["sku", "barcode"]) {
          if (!columns.has(optionalColumn)) continue;
          const source = rows.find((row) => String(row[optionalColumn] || "").trim() !== "");
          if (source) {
            assignments.push(`${optionalColumn} = ?`);
            values.push(source[optionalColumn]);
          }
        }
        if (columns.has("updated_at")) assignments.push("updated_at = CURRENT_TIMESTAMP");

        if (assignments.length > 0) {
          db.prepare(`UPDATE product_platforms SET ${assignments.join(", ")} WHERE rowid = ?`).run(
            ...values,
            keeper._rowid,
          );
        }

        const duplicateRowIds = rows.slice(1).map((row) => row._rowid);
        const placeholders = duplicateRowIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM product_platforms WHERE rowid IN (${placeholders})`).run(...duplicateRowIds);
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_platforms_unique_product_platform
        ON product_platforms(product_id, platform_name)
      `);
    },
  },
  {
    version: 22,
    name: "add_products_central_stock",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((col) => col.name),
      );
      const hadCentralStock = columns.has("central_stock");

      if (!hadCentralStock) {
        db.exec("ALTER TABLE products ADD COLUMN central_stock INTEGER DEFAULT 0");
      }

      const platformColumns = new Set(
        (db.prepare("PRAGMA table_info(product_platforms)").all() as { name: string }[]).map((col) => col.name),
      );
      if (!platformColumns.has("product_id") || !platformColumns.has("stock")) {
        db.exec("UPDATE products SET central_stock = COALESCE(central_stock, 0)");
        return;
      }

      if (hadCentralStock) {
        db.exec("UPDATE products SET central_stock = 0 WHERE central_stock IS NULL");
        return;
      }

      db.exec(`
        UPDATE products
        SET central_stock = COALESCE((
          SELECT SUM(COALESCE(pp.stock, 0))
          FROM product_platforms pp
          WHERE pp.product_id = products.id
        ), 0)
        WHERE central_stock IS NULL OR central_stock = 0
      `);
      db.exec("UPDATE products SET central_stock = 0 WHERE central_stock IS NULL");
    },
  },
  {
    version: 23,
    name: "ensure_users_management_columns",
    up(db) {
      const cols = [
        "ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1",
        "ALTER TABLE users ADD COLUMN last_login_at DATETIME",
        "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN locked_until DATETIME",
        "ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '{}'",
        "ALTER TABLE users ADD COLUMN notes TEXT",
        "ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0",
        "ALTER TABLE users ADD COLUMN created_at DATETIME",
        "ALTER TABLE users ADD COLUMN updated_at DATETIME",
      ];
      for (const sql of cols) { try { db.exec(sql); } catch (_) {} }
      try { db.exec("UPDATE users SET is_active = 1 WHERE is_active IS NULL"); } catch (_) {}
      try { db.exec("UPDATE users SET must_change_password = 0 WHERE must_change_password IS NULL"); } catch (_) {}
      try { db.exec("UPDATE users SET permissions = '{}' WHERE permissions IS NULL OR permissions = ''"); } catch (_) {}
      try { db.exec("UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL"); } catch (_) {}
      try { db.exec("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL"); } catch (_) {}
    },
  },
  {
    version: 24,
    name: "add_actor_username_to_activity_logs",
    up(db) {
      try { db.exec("ALTER TABLE activity_logs ADD COLUMN actor_username TEXT"); } catch (_) {}
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_activity_logs_actor_username ON activity_logs(actor_username)"); } catch (_) {}
      try {
        db.exec(`
          UPDATE activity_logs
          SET actor_username = (
            SELECT username
            FROM users
            WHERE users.id = activity_logs.user_id
          )
          WHERE actor_username IS NULL
            AND user_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM users
              WHERE users.id = activity_logs.user_id
            )
        `);
      } catch (_) {}
      try {
        db.exec("UPDATE activity_logs SET actor_username = 'legacy-api-key' WHERE actor_username IS NULL AND user_id = 'legacy-api-key'");
      } catch (_) {}
    },
  },
  {
    version: 25,
    name: "add_dashboard_overview_widgets",
    up(db) {
      const insertWidget = db.prepare(`
        INSERT INTO dashboard_widgets
          (id, user_id, widget_key, title, description, widget_type, source_module, size, position, is_visible, settings_json)
        SELECT lower(hex(randomblob(16))), 'admin', ?, ?, ?, ?, ?, ?, ?, 1, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM dashboard_widgets WHERE user_id = 'admin' AND widget_key = ?
        )
      `);
      const widgets = [
        ['dashboard_month_revenue', 'Bu Ay Toplam Ciro', 'Aktif satışlardan bu ay oluşan net ciro.', 'kpi', 'overview', 'small', 0, { x: 0, y: 0, w: 4, h: 3 }],
        ['dashboard_total_expenses', 'Toplam Giderler', 'Bu ay gerçekleşen giderler ve bekleyen periyodik ödemeler.', 'kpi', 'overview', 'small', 1, { x: 4, y: 0, w: 4, h: 3 }],
        ['dashboard_est_net_profit', 'Tahmini Net Kar', 'Bu ay toplam ciro eksi toplam gider tahmini.', 'kpi', 'overview', 'small', 2, { x: 8, y: 0, w: 4, h: 3 }],
        ['dashboard_low_stock', 'Kritik Stok', 'Merkez depo stoğu kritik seviyede olan ürün sayısı.', 'kpi', 'overview', 'small', 3, { x: 0, y: 3, w: 4, h: 3 }],
        ['dashboard_stock_sales_value', 'Toplam Stok Satış Değeri', 'Merkez depo stoklarının satış fiyatı üzerinden potansiyel değeri.', 'kpi', 'overview', 'small', 4, { x: 4, y: 3, w: 4, h: 3 }],
        ['dashboard_stock_cost_value', 'Toplam Stok Maliyeti', 'Merkez depo stoklarının alış maliyeti toplamı.', 'kpi', 'overview', 'small', 5, { x: 8, y: 3, w: 4, h: 3 }],
        ['dashboard_stock_est_gross_profit', 'Tahmini Brüt Kâr', 'Mevcut stoktan beklenen potansiyel brüt kâr.', 'kpi', 'overview', 'small', 6, { x: 0, y: 6, w: 4, h: 3 }],
        ['dashboard_avg_profit_margin', 'Ortalama Kâr Marjı', 'Mevcut stokların satış değerine göre ortalama kâr marjı.', 'kpi', 'overview', 'small', 7, { x: 4, y: 6, w: 4, h: 3 }],
      ];

      for (const [key, title, description, type, module, size, position, grid] of widgets as any[]) {
        try {
          insertWidget.run(
            key,
            title,
            description,
            type,
            module,
            size,
            position,
            JSON.stringify({ grid }),
            key,
          );
        } catch (_) {}
      }
    },
  },
  {
    version: 26,
    name: "index_dashboard_widgets_by_user",
    up(db) {
      try {
        db.exec("CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_user ON dashboard_widgets(user_id, position)");
      } catch (_) {}
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      name      TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  let applied_count = 0;

  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      migration.up(db);
      insertMigration.run(migration.version, migration.name);
    })();

    console.log(`[Migration] Applied v${migration.version}: ${migration.name}`);
    applied_count++;
  }

  if (applied_count > 0) {
    console.log(`[Migration] ${applied_count} migration(s) applied.`);
  }
}

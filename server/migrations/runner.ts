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
  {
    version: 27,
    name: "add_sales_order_codes",
    up(db) {
      const saleColumns = new Set(
        (db.prepare("PRAGMA table_info(sales)").all() as { name: string }[]).map((col) => col.name),
      );

      if (!saleColumns.has("order_code")) {
        db.exec("ALTER TABLE sales ADD COLUMN order_code TEXT");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS order_counters (
          date_key    TEXT PRIMARY KEY,
          last_number INTEGER NOT NULL DEFAULT 0,
          updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      const toDateKey = (value: unknown): string => {
        const text = String(value || "").trim();
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) return `${match[1].slice(2)}${match[2]}${match[3]}`;

        const fallback = new Date(text);
        if (!Number.isNaN(fallback.getTime())) {
          const year = String(fallback.getFullYear()).slice(2);
          const month = String(fallback.getMonth() + 1).padStart(2, "0");
          const day = String(fallback.getDate()).padStart(2, "0");
          return `${year}${month}${day}`;
        }

        const now = new Date();
        return `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
      };

      const counters = new Map<string, number>();
      const usedCodes = new Set<string>();

      const existingCodes = db.prepare(`
        SELECT order_code
        FROM sales
        WHERE order_code IS NOT NULL AND TRIM(order_code) <> ''
      `).all() as { order_code: string }[];

      for (const row of existingCodes) {
        const code = String(row.order_code || "").trim();
        if (!code) continue;
        usedCodes.add(code);
        const match = code.match(/^DS-(\d{6})-(\d{4})$/);
        if (!match) continue;
        counters.set(match[1], Math.max(counters.get(match[1]) || 0, Number(match[2]) || 0));
      }

      const existingCounters = db.prepare("SELECT date_key, last_number FROM order_counters").all() as { date_key: string; last_number: number }[];
      for (const row of existingCounters) {
        counters.set(row.date_key, Math.max(counters.get(row.date_key) || 0, Number(row.last_number) || 0));
      }

      const sales = db.prepare(`
        SELECT id, created_at
        FROM sales
        WHERE order_code IS NULL OR TRIM(order_code) = ''
        ORDER BY datetime(COALESCE(created_at, CURRENT_TIMESTAMP)) ASC, rowid ASC
      `).all() as { id: string; created_at: string }[];

      const updateSale = db.prepare("UPDATE sales SET order_code = ? WHERE id = ?");
      for (const sale of sales) {
        const dateKey = toDateKey(sale.created_at);
        let nextNumber = (counters.get(dateKey) || 0) + 1;
        let orderCode = `DS-${dateKey}-${String(nextNumber).padStart(4, "0")}`;

        while (usedCodes.has(orderCode)) {
          nextNumber++;
          orderCode = `DS-${dateKey}-${String(nextNumber).padStart(4, "0")}`;
        }

        updateSale.run(orderCode, sale.id);
        usedCodes.add(orderCode);
        counters.set(dateKey, nextNumber);
      }

      const upsertCounter = db.prepare(`
        INSERT INTO order_counters (date_key, last_number, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(date_key) DO UPDATE SET
          last_number = MAX(order_counters.last_number, excluded.last_number),
          updated_at = CURRENT_TIMESTAMP
      `);
      for (const [dateKey, lastNumber] of counters) {
        upsertCounter.run(dateKey, lastNumber);
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_order_code_unique
        ON sales(order_code) WHERE order_code IS NOT NULL AND order_code <> ''
      `);
    },
  },
  {
    version: 28,
    name: "add_configurable_sales_channels",
    up(db) {
      const defaultChannels = ["Satış Sistemi", "Website", "Trendyol", "Hepsiburada", "Amazon", "N11"];
      const defaultRates: Record<string, number> = {
        "Satış Sistemi": 0,
        Website: 0,
        Trendyol: 15,
        Hepsiburada: 15,
        Amazon: 10,
        N11: 15,
      };

      const readJsonSetting = (key: string, fallback: any) => {
        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
        if (!row?.value) return fallback;
        try {
          return JSON.parse(row.value);
        } catch (_) {
          return fallback;
        }
      };

      const uniqueChannels = (values: unknown[]) => {
        const result: string[] = [];
        for (const value of values) {
          const channel = String(value || "").trim();
          if (!channel || result.includes(channel)) continue;
          result.push(channel);
        }
        return result;
      };

      const existingChannels = readJsonSetting("sales_channels", []);
      const currentChannels = Array.isArray(existingChannels) ? existingChannels : [];
      const salesChannels = uniqueChannels([...currentChannels, ...defaultChannels]);
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run("sales_channels", JSON.stringify(salesChannels));

      const existingRates = readJsonSetting("commission_rates", {});
      const rates = typeof existingRates === "object" && existingRates !== null && !Array.isArray(existingRates)
        ? { ...existingRates }
        : {};
      for (const [channel, rate] of Object.entries(defaultRates)) {
        if (rates[channel] === undefined || rates[channel] === null || rates[channel] === "") {
          rates[channel] = rate;
        }
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
        .run("commission_rates", JSON.stringify(rates));
    },
  },
  {
    version: 29,
    name: "add_sales_external_order_id",
    up(db) {
      const saleColumns = new Set(
        (db.prepare("PRAGMA table_info(sales)").all() as { name: string }[]).map((col) => col.name),
      );

      if (!saleColumns.has("external_order_id")) {
        db.exec("ALTER TABLE sales ADD COLUMN external_order_id TEXT");
      }

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_platform_external_order
        ON sales(platform, external_order_id)
        WHERE external_order_id IS NOT NULL AND TRIM(external_order_id) <> ''
      `);
    },
  },
  {
    version: 30,
    name: "add_backup_runs",
    up(db) {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at
        ON backup_runs(started_at);

        CREATE INDEX IF NOT EXISTS idx_backup_runs_kind_status
        ON backup_runs(backup_kind, status, completed_at);
      `);

      const defaultConfig = {
        enabled: true,
        run_at: "03:00",
        retention_days: 7,
        include_uploads: true,
        uploads_strategy: "smart",
        weekly_full_day: 0,
      };

      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
        .run("backup_config", JSON.stringify(defaultConfig));
    },
  },
  {
    version: 31,
    name: "add_cloud_backup_tracking",
    up(db) {
      const existingColumns = new Set(
        (db.prepare("PRAGMA table_info(backup_runs)").all() as { name: string }[]).map((column) => column.name),
      );
      const addColumn = (name: string, definition: string) => {
        if (!existingColumns.has(name)) db.exec(`ALTER TABLE backup_runs ADD COLUMN ${definition}`);
      };

      addColumn("cloud_status", "cloud_status TEXT DEFAULT 'not_configured'");
      addColumn("cloud_provider", "cloud_provider TEXT");
      addColumn("cloud_path", "cloud_path TEXT");
      addColumn("cloud_uploaded_at", "cloud_uploaded_at DATETIME");
      addColumn("cloud_error", "cloud_error TEXT");
      addColumn("cloud_attempts", "cloud_attempts INTEGER DEFAULT 0");

      db.exec(`
        UPDATE backup_runs
        SET cloud_status = COALESCE(cloud_status, 'not_configured'),
            cloud_attempts = COALESCE(cloud_attempts, 0);

        CREATE INDEX IF NOT EXISTS idx_backup_runs_cloud_status
        ON backup_runs(cloud_status, cloud_uploaded_at);
      `);
    },
  },
  {
    version: 32,
    name: "add_marketplace_orders",
    up(db) {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_marketplace_orders_platform_env
          ON marketplace_orders(platform, environment, package_last_modified_at);
        CREATE INDEX IF NOT EXISTS idx_marketplace_orders_external
          ON marketplace_orders(platform, environment, external_order_id);
        CREATE INDEX IF NOT EXISTS idx_marketplace_orders_sale
          ON marketplace_orders(sale_id);
      `);

      const defaultConfig = {
        enabled: false,
        environment: "stage",
        api_key_id: "",
        sync_window_days: 14,
        store_front_code: "",
      };

      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
        .run("trendyol_config", JSON.stringify(defaultConfig));
    },
  },
  {
    version: 33,
    name: "add_marketplace_order_lines",
    up(db) {
      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_order
          ON marketplace_order_lines(marketplace_order_id);
        CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_match
          ON marketplace_order_lines(matched_product_id);
        CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_barcode
          ON marketplace_order_lines(platform, environment, barcode);
        CREATE INDEX IF NOT EXISTS idx_marketplace_order_lines_stock_code
          ON marketplace_order_lines(platform, environment, stock_code);
      `);
    },
  },
  {
    version: 34,
    name: "add_product_bom_and_carbon_steel_assemblies",
    up(db) {
      const productColumns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((column) => column.name),
      );
      const addProductColumn = (name: string, definition: string) => {
        if (!productColumns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${definition}`);
      };

      addProductColumn("product_type", "product_type TEXT DEFAULT 'finished'");
      addProductColumn("is_sellable", "is_sellable INTEGER DEFAULT 1");
      addProductColumn("visible_in_catalog", "visible_in_catalog INTEGER DEFAULT 1");
      addProductColumn("exclude_from_analysis", "exclude_from_analysis INTEGER DEFAULT 0");

      db.exec(`
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

        CREATE INDEX IF NOT EXISTS idx_products_visibility
          ON products(is_sellable, visible_in_catalog, exclude_from_analysis);
        CREATE INDEX IF NOT EXISTS idx_product_bom_parent
          ON product_bom(parent_product_id);
        CREATE INDEX IF NOT EXISTS idx_product_bom_component
          ON product_bom(component_product_id);
      `);

      db.exec(`
        UPDATE products
        SET product_type = CASE
              WHEN sku LIKE 'CS-%-SCR%' THEN 'accessory'
              ELSE 'component'
            END,
            is_sellable = 0,
            visible_in_catalog = 0,
            exclude_from_analysis = 1,
            status = COALESCE(NULLIF(status, ''), 'Active')
        WHERE sku LIKE 'CS-%-H%'
           OR sku LIKE 'CS-%-SWA'
           OR sku LIKE 'CS-%-SWB'
           OR sku LIKE 'CS-%-SCR%';
      `);

      type ComponentSpec = { sku: string; qty: number; role: string };
      type AssemblySpec = {
        sku: string;
        title: string;
        model: string;
        size: string;
        tubeType: string;
        series: string;
        components: ComponentSpec[];
      };

      const assemblies: AssemblySpec[] = [
        {
          sku: "CS-STD-RD-25-TEE",
          title: "Carbon Steel Round Tube Clamp Tee 25 mm",
          model: "Tee",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [{ sku: "CS-STD-RD-25-H01", qty: 2, role: "H1" }],
        },
        {
          sku: "CS-STD-RD-25-W4",
          title: "Carbon Steel Round Tube Clamp 4 Way 25 mm",
          model: "4 Way",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [
            { sku: "CS-STD-RD-25-H03", qty: 1, role: "H3" },
            { sku: "CS-STD-RD-25-H02", qty: 1, role: "H2" },
          ],
        },
        {
          sku: "CS-STD-RD-25-CRS",
          title: "Carbon Steel Round Tube Clamp Cross 25 mm",
          model: "Cross",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [{ sku: "CS-STD-RD-25-H04", qty: 2, role: "H4" }],
        },
        {
          sku: "CS-STD-RD-25-W5",
          title: "Carbon Steel Round Tube Clamp 5 Way 25 mm",
          model: "5 Way",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [
            { sku: "CS-STD-RD-25-H04", qty: 1, role: "H4" },
            { sku: "CS-STD-RD-25-H02", qty: 2, role: "H2" },
          ],
        },
        {
          sku: "CS-STD-RD-25-W6",
          title: "Carbon Steel Round Tube Clamp 6 Way 25 mm",
          model: "6 Way",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [{ sku: "CS-STD-RD-25-H02", qty: 4, role: "H2" }],
        },
        {
          sku: "CS-STD-RD-25-ELB",
          title: "Carbon Steel Round Tube Clamp Elbow 25 mm",
          model: "Elbow",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [{ sku: "CS-STD-RD-25-H16", qty: 2, role: "H16" }],
        },
        {
          sku: "CS-STD-RD-25-SWJ",
          title: "Carbon Steel Round Tube Clamp Swivel Joint 25 mm",
          model: "Swivel Joint",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [
            { sku: "CS-STD-RD-25-H05", qty: 2, role: "H5" },
            { sku: "CS-STD-RD-25-H06", qty: 2, role: "H6" },
          ],
        },
        {
          sku: "CS-STD-RD-25-SWT",
          title: "Carbon Steel Round Tube Clamp Swivel Tee 25 mm",
          model: "Swivel Tee",
          size: "25 mm",
          tubeType: "Yuvarlak",
          series: "Standart",
          components: [
            { sku: "CS-STD-RD-25-SWA", qty: 1, role: "Swivel A" },
            { sku: "CS-STD-RD-25-SWB", qty: 1, role: "Swivel B" },
          ],
        },
        {
          sku: "CS-STD-SQ-25-TEE",
          title: "Carbon Steel Square Tube Clamp Tee 25x25 mm",
          model: "Tee",
          size: "25x25 mm",
          tubeType: "Kare",
          series: "Standart",
          components: [{ sku: "CS-STD-SQ-25-H01", qty: 2, role: "H1" }],
        },
        {
          sku: "CS-STD-SQ-25-W4",
          title: "Carbon Steel Square Tube Clamp 4 Way 25x25 mm",
          model: "4 Way",
          size: "25x25 mm",
          tubeType: "Kare",
          series: "Standart",
          components: [
            { sku: "CS-STD-SQ-25-H03", qty: 1, role: "H3" },
            { sku: "CS-STD-SQ-25-H02", qty: 1, role: "H2" },
          ],
        },
        {
          sku: "CS-STD-SQ-25-CRS",
          title: "Carbon Steel Square Tube Clamp Cross 25x25 mm",
          model: "Cross",
          size: "25x25 mm",
          tubeType: "Kare",
          series: "Standart",
          components: [{ sku: "CS-STD-SQ-25-H04", qty: 2, role: "H4" }],
        },
        {
          sku: "CS-STD-SQ-25-W5",
          title: "Carbon Steel Square Tube Clamp 5 Way 25x25 mm",
          model: "5 Way",
          size: "25x25 mm",
          tubeType: "Kare",
          series: "Standart",
          components: [
            { sku: "CS-STD-SQ-25-H04", qty: 1, role: "H4" },
            { sku: "CS-STD-SQ-25-H02", qty: 2, role: "H2" },
          ],
        },
        {
          sku: "CS-STD-SQ-25-W6",
          title: "Carbon Steel Square Tube Clamp 6 Way 25x25 mm",
          model: "6 Way",
          size: "25x25 mm",
          tubeType: "Kare",
          series: "Standart",
          components: [{ sku: "CS-STD-SQ-25-H02", qty: 4, role: "H2" }],
        },
        {
          sku: "CS-DRL-SQ-40-TEE",
          title: "Carbon Steel Square Tube Drilling Clamp Tee 40x40 mm",
          model: "Tee",
          size: "40x40 mm",
          tubeType: "Kare",
          series: "DRL",
          components: [{ sku: "CS-DRL-SQ-40-H01", qty: 2, role: "H1" }],
        },
        {
          sku: "CS-DRL-SQ-40-W4",
          title: "Carbon Steel Square Tube Drilling Clamp 4 Way 40x40 mm",
          model: "4 Way",
          size: "40x40 mm",
          tubeType: "Kare",
          series: "DRL",
          components: [
            { sku: "CS-DRL-SQ-40-H03", qty: 1, role: "H3" },
            { sku: "CS-DRL-SQ-40-H02", qty: 1, role: "H2" },
          ],
        },
        {
          sku: "CS-DRL-SQ-40-CRS",
          title: "Carbon Steel Square Tube Drilling Clamp Cross 40x40 mm",
          model: "Cross",
          size: "40x40 mm",
          tubeType: "Kare",
          series: "DRL",
          components: [{ sku: "CS-DRL-SQ-40-H04", qty: 2, role: "H4" }],
        },
        {
          sku: "CS-DRL-SQ-40-W5",
          title: "Carbon Steel Square Tube Drilling Clamp 5 Way 40x40 mm",
          model: "5 Way",
          size: "40x40 mm",
          tubeType: "Kare",
          series: "DRL",
          components: [
            { sku: "CS-DRL-SQ-40-H04", qty: 1, role: "H4" },
            { sku: "CS-DRL-SQ-40-H02", qty: 2, role: "H2" },
          ],
        },
        {
          sku: "CS-DRL-SQ-40-BAS",
          title: "Carbon Steel Square Tube Drilling Clamp Base 40x40 mm",
          model: "Base",
          size: "40x40 mm",
          tubeType: "Kare",
          series: "DRL",
          components: [{ sku: "CS-DRL-SQ-40-H02", qty: 2, role: "H2" }],
        },
      ];

      const getProductBySku = db.prepare("SELECT * FROM products WHERE sku = ?");
      const insertAssembly = db.prepare(`
        INSERT INTO products (
          id, name, title, sku, category, model, description, material, size, pipe_size,
          connection_type, min_stock_level, central_stock, product_type, is_sellable,
          visible_in_catalog, exclude_from_analysis, purchase_price_usd, purchase_cost,
          sale_price, weight, status, normalized_material, normalized_model,
          normalized_size, normalized_tube_type, normalized_pipe_size
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 50, 0, 'assembly', 1, 1, 0, ?, ?, 0, ?, 'Active', ?, ?, ?, ?, ?)
      `);
      const updateAssembly = db.prepare(`
        UPDATE products
        SET product_type = 'assembly',
            is_sellable = 1,
            visible_in_catalog = 1,
            exclude_from_analysis = 0,
            material = COALESCE(NULLIF(material, ''), 'Karbon Çelik'),
            category = COALESCE(NULLIF(category, ''), 'Karbon Çelik'),
            model = COALESCE(NULLIF(model, ''), ?),
            pipe_size = COALESCE(NULLIF(pipe_size, ''), ?),
            normalized_material = COALESCE(NULLIF(normalized_material, ''), 'Karbon Çelik'),
            normalized_model = COALESCE(NULLIF(normalized_model, ''), ?),
            normalized_tube_type = COALESCE(NULLIF(normalized_tube_type, ''), ?),
            normalized_pipe_size = COALESCE(NULLIF(normalized_pipe_size, ''), ?),
            purchase_price_usd = CASE WHEN COALESCE(purchase_price_usd, 0) = 0 THEN ? ELSE purchase_price_usd END,
            purchase_cost = CASE WHEN COALESCE(purchase_cost, 0) = 0 THEN ? ELSE purchase_cost END,
            weight = CASE WHEN COALESCE(weight, 0) = 0 THEN ? ELSE weight END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const upsertBom = db.prepare(`
        INSERT INTO product_bom (id, parent_product_id, component_product_id, quantity_per_unit, component_role)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(parent_product_id, component_product_id)
        DO UPDATE SET quantity_per_unit = excluded.quantity_per_unit,
                      component_role = excluded.component_role,
                      updated_at = CURRENT_TIMESTAMP
      `);

      for (const assembly of assemblies) {
        const components = assembly.components
          .map((component) => ({ ...component, product: getProductBySku.get(component.sku) as any }))
          .filter((component) => component.product);

        if (components.length !== assembly.components.length) continue;

        const purchasePriceUsd = components.reduce((sum, component) => sum + ((Number(component.product.purchase_price_usd) || 0) * component.qty), 0);
        const purchaseCost = components.reduce((sum, component) => sum + ((Number(component.product.purchase_cost) || 0) * component.qty), 0);
        const weight = components.reduce((sum, component) => sum + ((Number(component.product.weight) || 0) * component.qty), 0);
        const assemblyId = `assembly-${assembly.sku.toLowerCase()}`;
        const existingAssembly = getProductBySku.get(assembly.sku) as any;
        const productId = existingAssembly?.id || assemblyId;
        const description = `${assembly.title} — depoda H parçaları olarak tutulur, satışta final ürün olarak görünür.`;

        if (!existingAssembly) {
          insertAssembly.run(
            productId,
            assembly.title,
            assembly.title,
            assembly.sku,
            "Karbon Çelik",
            assembly.model,
            description,
            "Karbon Çelik",
            assembly.size,
            assembly.size,
            assembly.tubeType,
            purchasePriceUsd,
            purchaseCost,
            weight,
            "Karbon Çelik",
            assembly.model,
            assembly.size,
            assembly.tubeType,
            assembly.size,
          );
        } else {
          updateAssembly.run(
            assembly.model,
            assembly.size,
            assembly.model,
            assembly.tubeType,
            assembly.size,
            purchasePriceUsd,
            purchaseCost,
            weight,
            productId,
          );
        }

        for (const component of components) {
          upsertBom.run(
            `bom-${assembly.sku.toLowerCase()}-${component.sku.toLowerCase()}`,
            productId,
            component.product.id,
            component.qty,
            component.role,
          );
        }
      }
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

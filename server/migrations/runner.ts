import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROCUREMENT_SCHEMA_V67 } from "../db/procurementSchema.js";
import { PROCUREMENT_REMEDIATION_SCHEMA_V68 } from "../db/procurementRemediationSchema.js";
import { INVENTORY_SCHEMA_V69 } from "../db/inventorySchema.js";
import { SALES_FINANCIAL_SCHEMA_V74 } from "../db/salesFinancialSchema.js";
import { RETURNS_SCHEMA_V75 } from "../db/returnsSchema.js";
import { WAREHOUSE_PACKAGE_ORIGIN_SCHEMA_V76 } from "../db/warehousePackageOriginSchema.js";
import { PUBLISHED_KIT_SCHEMA_V77 } from "../db/publishedKitSchema.js";
import { PROFILE_CUT_REMEDIATION_SCHEMA_V78 } from "../db/profileCutRemediationSchema.js";
import { CHANNEL_GATEWAY_SCHEMA_V79 } from "../db/channelGatewaySchema.js";
import { CHANNEL_GATEWAY_REMEDIATION_SCHEMA_V80 } from "../db/channelGatewayRemediationSchema.js";
import { CHANNEL_GATEWAY_CORRECTNESS_SCHEMA_V81 } from "../db/channelGatewayCorrectnessSchema.js";
import { SHIPMENT_CARRIER_SCHEMA_V82 } from "../db/shipmentCarrierSchema.js";
import { GELIVER_REMEDIATION_SCHEMA_V83 } from "../db/geliverRemediationSchema.js";
import { CHANNEL_SHIPMENT_OUTBOUND_SCHEMA_V84 } from "../db/channelShipmentOutboundSchema.js";
import { PRINT_STATE_SCHEMA_V85 } from "../db/printStateSchema.js";
import { PRINT_DEDUP_COLUMNS_SCHEMA_V86, PRINT_DEDUP_GUARDS_SCHEMA_V86 } from "../db/printDedupSchema.js";
import { RECONCILIATION_SCHEMA_V87 } from "../db/reconciliationSchema.js";
import { WAREHOUSE_EXECUTION_SCHEMA_V71, WAREHOUSE_REPLENISHMENT_RUNTIME_SCHEMA_V73 } from "../db/warehouseExecutionSchema.js";
import { canonicalPayloadHash } from "../modules/commands/commandFoundation.js";

interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
  requiresForeignKeysOff?: boolean;
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
  {
    version: 35,
    name: "add_sku_taxonomy_columns",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((c) => c.name),
      );
      const add = (name: string, def: string) => {
        if (!columns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${def}`);
      };

      add("supplier_code", "supplier_code TEXT");
      add("product_series", "product_series TEXT");
      add("tube_type_code", "tube_type_code TEXT");
      add("size_code", "size_code TEXT");
      add("form_code", "form_code TEXT");
      add("weight_grams", "weight_grams REAL DEFAULT 0");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_products_series       ON products(product_series);
        CREATE INDEX IF NOT EXISTS idx_products_form_code    ON products(form_code);
        CREATE INDEX IF NOT EXISTS idx_products_tube_type    ON products(tube_type_code);
        CREATE INDEX IF NOT EXISTS idx_products_size_code    ON products(size_code);
        CREATE INDEX IF NOT EXISTS idx_products_supplier_code ON products(supplier_code);
      `);
    },
  },
  {
    version: 36,
    name: "backfill_product_series",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("product_series")) {
        db.exec("ALTER TABLE products ADD COLUMN product_series TEXT");
      }

      db.exec(`
        UPDATE products
        SET product_series = CASE
          WHEN UPPER(COALESCE(sku, '')) LIKE '%-PRM-%'
            OR LOWER(COALESCE(title, '')) LIKE '%premium%'
            OR LOWER(COALESCE(name, '')) LIKE '%premium%'
            THEN 'PRM'
          WHEN UPPER(COALESCE(sku, '')) LIKE '%-OYA-%'
            THEN 'OYA'
          WHEN UPPER(COALESCE(sku, '')) LIKE '%-ALY-%'
            THEN 'ALY'
          WHEN UPPER(COALESCE(sku, '')) LIKE '%-DRL-%'
            THEN 'DRL'
          WHEN UPPER(COALESCE(sku, '')) LIKE '%-STD-%'
            THEN 'STD'
          ELSE product_series
        END
        WHERE COALESCE(product_series, '') = '';

        UPDATE products
        SET product_series = CASE
          WHEN LOWER(COALESCE(title, '')) LIKE '%premium%'
            OR LOWER(COALESCE(name, '')) LIKE '%premium%'
            OR UPPER(COALESCE(sku, '')) LIKE '%PRM%'
            THEN 'PRM'
          ELSE 'OYA'
        END
        WHERE COALESCE(product_series, '') = ''
          AND (
            LOWER(COALESCE(material, '')) LIKE '%demir%'
            OR LOWER(COALESCE(material, '')) LIKE '%cast iron%'
            OR LOWER(COALESCE(category, '')) LIKE '%demir%'
            OR LOWER(COALESCE(title, '')) LIKE '%cast iron%'
            OR LOWER(COALESCE(name, '')) LIKE '%cast iron%'
            OR UPPER(COALESCE(sku, '')) GLOB 'H-[0-9]*'
            OR UPPER(COALESCE(sku, '')) GLOB 'F-[0-9]*'
          );

        CREATE INDEX IF NOT EXISTS idx_products_series ON products(product_series);
      `);
    },
  },
  {
    version: 37,
    name: "normalize_product_series_codes",
    up(db) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((c) => c.name),
      );
      if (!columns.has("product_series")) {
        db.exec("ALTER TABLE products ADD COLUMN product_series TEXT");
      }

      db.exec(`
        UPDATE products SET product_series = 'PRM'
        WHERE LOWER(TRIM(COALESCE(product_series, ''))) IN ('premium', 'prm');

        UPDATE products SET product_series = 'ALY'
        WHERE LOWER(TRIM(COALESCE(product_series, ''))) IN ('alloy', 'aly');

        UPDATE products SET product_series = 'STD'
        WHERE LOWER(TRIM(COALESCE(product_series, ''))) IN ('standart', 'standard', 'std');

        UPDATE products SET product_series = 'DRL'
        WHERE LOWER(TRIM(COALESCE(product_series, ''))) IN ('drilling', 'drl');
      `);
    },
  },
  {
    version: 38,
    name: "add_independent_kit_management",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kit_profiles (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, shape TEXT, dimension TEXT, material TEXT,
          thickness TEXT, supplier TEXT, price_per_meter REAL DEFAULT 0, stock_length_mm REAL DEFAULT 6000,
          is_active INTEGER DEFAULT 1, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS kits (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE, description TEXT, profile_id TEXT NOT NULL,
          status TEXT DEFAULT 'active', cover_image TEXT, notes TEXT, target_margin REAL DEFAULT 30, sale_price REAL DEFAULT 0,
          labour_cost REAL DEFAULT 0, packaging_cost REAL DEFAULT 0, other_cost REAL DEFAULT 0,
          commission_rate REAL DEFAULT 0, vat_rate REAL DEFAULT 20, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(profile_id) REFERENCES kit_profiles(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS kit_items (
          id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(kit_id, product_id),
          FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS kit_cuts (
          id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, length_mm REAL NOT NULL,
          label TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_kits_profile ON kits(profile_id);
        CREATE INDEX IF NOT EXISTS idx_kit_items_product ON kit_items(product_id);
      `);
    },
  },
  {
    version: 39,
    name: "seed_standard_profile_dimensions",
    up(db) {
      // Price, supplier and wall thickness intentionally remain editable: these are
      // the stable dimensions identified in the imported product catalogue.
      const profiles = [
        ['Yuvarlak 25 mm', 'Yuvarlak', '25 mm'], ['Yuvarlak 60 mm', 'Yuvarlak', '60 mm'],
        ['Yuvarlak 3/4 inç', 'Yuvarlak', '3/4 inç'], ['Yuvarlak 1 inç', 'Yuvarlak', '1 inç'],
        ['Yuvarlak 1 1/2 inç', 'Yuvarlak', '1 1/2 inç'], ['Yuvarlak 2 inç', 'Yuvarlak', '2 inç'],
        ['Kare 20×20 mm', 'Kare', '20×20 mm'], ['Kare 25×25 mm', 'Kare', '25×25 mm'],
        ['Kare 30×30 mm', 'Kare', '30×30 mm'], ['Kare 40×40 mm', 'Kare', '40×40 mm'],
      ];
      const insert = db.prepare(`INSERT OR IGNORE INTO kit_profiles
        (id, name, shape, dimension, material, stock_length_mm, is_active) VALUES (?, ?, ?, ?, ?, 6000, 1)`);
      for (const [name, shape, dimension] of profiles) insert.run(`default-profile-${dimension.replace(/[^a-z0-9]/gi, '-').toLowerCase()}`, name, shape, dimension, 'Karbon Çelik');
    },
  },
  {
    version: 40,
    name: "add_profile_offers_and_kit_cost_snapshots",
    up(db) {
      for (const sql of [
        "ALTER TABLE kit_profiles ADD COLUMN color TEXT",
        "ALTER TABLE kit_profiles ADD COLUMN finish TEXT",
        "ALTER TABLE kit_profiles ADD COLUMN grade TEXT",
        "ALTER TABLE kit_profiles ADD COLUMN weight_per_meter REAL DEFAULT 0",
        "ALTER TABLE kits ADD COLUMN profile_offer_id TEXT",
        "ALTER TABLE kit_items ADD COLUMN unit_cost REAL DEFAULT 0",
      ]) { try { db.exec(sql); } catch (_) {} }
      db.exec(`CREATE TABLE IF NOT EXISTS kit_profile_offers (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, supplier TEXT NOT NULL,
        price_per_meter REAL NOT NULL DEFAULT 0, currency TEXT DEFAULT 'TRY', lead_time_days INTEGER,
        supplier_sku TEXT, notes TEXT, is_preferred INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(profile_id) REFERENCES kit_profiles(id) ON DELETE CASCADE
      ); CREATE INDEX IF NOT EXISTS idx_kit_profile_offers_profile ON kit_profile_offers(profile_id);`);
      // Existing single-price profiles remain usable as their first supplier offer.
      const rows = db.prepare("SELECT id, supplier, price_per_meter FROM kit_profiles WHERE COALESCE(price_per_meter, 0) > 0").all() as any[];
      const insert = db.prepare("INSERT OR IGNORE INTO kit_profile_offers (id, profile_id, supplier, price_per_meter, is_preferred) VALUES (?, ?, ?, ?, 1)");
      for (const row of rows) insert.run(`legacy-offer-${row.id}`, row.id, row.supplier || 'Varsayılan tedarikçi', row.price_per_meter);
    },
  },
  {
    version: 42,
    name: "add_independent_complementary_product_catalog",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS complementary_products (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, description TEXT,
        supplier TEXT, supplier_reference TEXT, notes TEXT, unit TEXT NOT NULL DEFAULT 'adet',
        purchase_price REAL NOT NULL DEFAULT 0, unit_weight_kg REAL NOT NULL DEFAULT 0,
        is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ); CREATE TABLE IF NOT EXISTS kit_complementary_items (
        id TEXT PRIMARY KEY, kit_id TEXT NOT NULL, complementary_product_id TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1, product_name_snapshot TEXT NOT NULL, unit_snapshot TEXT NOT NULL,
        purchase_price_snapshot REAL NOT NULL DEFAULT 0, unit_weight_kg_snapshot REAL NOT NULL DEFAULT 0,
        supplier_snapshot TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(kit_id) REFERENCES kits(id) ON DELETE CASCADE,
        FOREIGN KEY(complementary_product_id) REFERENCES complementary_products(id) ON DELETE RESTRICT
      ); CREATE INDEX IF NOT EXISTS idx_kit_complementary_items_kit ON kit_complementary_items(kit_id);`);
    },
  },
  {
    version: 43,
    name: "add_complementary_product_images",
    up(db) {
      try { db.exec("ALTER TABLE complementary_products ADD COLUMN cover_image TEXT"); } catch (_) {}
    },
  },
  {
    version: 44,
    name: "add_kit_cost_analysis_fields",
    up(db) {
      for (const sql of [
        "ALTER TABLE kits ADD COLUMN cutting_cost REAL DEFAULT 0",
        "ALTER TABLE kits ADD COLUMN payment_cost REAL DEFAULT 0",
        "ALTER TABLE kits ADD COLUMN shipping_cost REAL DEFAULT 0",
      ]) try { db.exec(sql); } catch (_) {}
    },
  },
  {
    version: 45,
    name: "create_complementary_product_image_gallery",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS complementary_product_images (
          id TEXT PRIMARY KEY,
          complementary_product_id TEXT NOT NULL,
          path TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(complementary_product_id) REFERENCES complementary_products(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_complementary_product_images_product
          ON complementary_product_images(complementary_product_id);
      `);
    },
  },
  {
    version: 46,
    name: "persist_kit_cut_and_complementary_extra_fields",
    up(db) {
      for (const sql of [
        "ALTER TABLE kit_cuts ADD COLUMN notes TEXT",
        "ALTER TABLE complementary_products ADD COLUMN brand TEXT",
        "ALTER TABLE complementary_products ADD COLUMN size TEXT",
      ]) try { db.exec(sql); } catch (_) {}
    },
  },
  {
    version: 47,
    name: "add_manual_kit_profile_meter_price",
    up(db) {
      try { db.exec("ALTER TABLE kits ADD COLUMN manual_profile_price_per_meter REAL DEFAULT 0"); } catch (_) {}
    },
  },
  {
    version: 48,
    name: "seed_fixed_kit_profile_variants",
    up(db) {
      const slug = (value: string) => value
        .toLocaleLowerCase("tr-TR")
        .replace(/ğ/g, "g")
        .replace(/ü/g, "u")
        .replace(/ş/g, "s")
        .replace(/ı/g, "i")
        .replace(/ö/g, "o")
        .replace(/ç/g, "c")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const catalog = [
        { material: "Demir Döküm", shape: "Kare", dimensions: ["25x25 mm", "40x40 mm"] },
        { material: "Demir Döküm", shape: "Yuvarlak", dimensions: ["3/4 inç (26.9 mm)", "1 inç (33.7 mm)", "1.5 inç (48.3 mm)", "2 inç (60.3 mm)"] },
        { material: "Alüminyum", shape: "Yuvarlak", dimensions: ["1 inç"] },
        { material: "Alüminyum", shape: "Kare", dimensions: ["20x20 mm", "30x30 mm"] },
        { material: "PPR", shape: "Yuvarlak", dimensions: ["3/4 inç (26.9 mm)"] },
        { material: "Karbon Çelik", shape: "Kare", dimensions: ["40x40 mm"] },
        { material: "Karbon Çelik", shape: "Yuvarlak", dimensions: ["3/4 inç (26.9 mm)"] },
      ];
      const thicknesses = ["1.0 mm", "1.5 mm", "2.0 mm", "2.5 mm"];

      const fixedProfiles: Array<{
        id: string;
        name: string;
        material: string;
        shape: string;
        dimension: string;
        thickness: string;
      }> = [];
      for (const group of catalog) {
        for (const dimension of group.dimensions) {
          for (const thickness of thicknesses) {
            const name = `${group.material} ${group.shape} ${dimension} / ${thickness}`;
            fixedProfiles.push({
              id: `fixed-profile-${slug(`${group.material}-${group.shape}-${dimension}-${thickness}`)}`,
              name,
              material: group.material,
              shape: group.shape,
              dimension,
              thickness,
            });
          }
        }
      }

      const findProfile = db.prepare(`
        SELECT id FROM kit_profiles
        WHERE LOWER(TRIM(material)) = LOWER(TRIM(?))
          AND LOWER(TRIM(shape)) = LOWER(TRIM(?))
          AND LOWER(REPLACE(TRIM(dimension), '×', 'x')) = LOWER(REPLACE(TRIM(?), '×', 'x'))
          AND LOWER(TRIM(COALESCE(thickness, ''))) = LOWER(TRIM(?))
        LIMIT 1
      `);
      const insertProfile = db.prepare(`
        INSERT INTO kit_profiles (
          id, name, shape, dimension, material, thickness, supplier, price_per_meter,
          color, finish, grade, weight_per_meter, stock_length_mm, is_active, notes
        ) VALUES (?, ?, ?, ?, ?, ?, '', 0, '', 'Standart', 'Standart', 0, 6000, 1, '')
      `);
      const updateProfile = db.prepare(`
        UPDATE kit_profiles
        SET name = ?,
            shape = ?,
            dimension = ?,
            material = ?,
            thickness = ?,
            finish = COALESCE(NULLIF(finish, ''), 'Standart'),
            grade = COALESCE(NULLIF(grade, ''), 'Standart'),
            stock_length_mm = CASE WHEN COALESCE(stock_length_mm, 0) > 0 THEN stock_length_mm ELSE 6000 END,
            is_active = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);

      const fixedIds: string[] = [];
      for (const profile of fixedProfiles) {
        const existing = findProfile.get(profile.material, profile.shape, profile.dimension, profile.thickness) as { id: string } | undefined;
        const id = existing?.id || profile.id;
        if (!existing) {
          insertProfile.run(id, profile.name, profile.shape, profile.dimension, profile.material, profile.thickness);
        } else {
          updateProfile.run(profile.name, profile.shape, profile.dimension, profile.material, profile.thickness, id);
        }
        fixedIds.push(id);
      }

      if (fixedIds.length) {
        const placeholders = fixedIds.map(() => "?").join(",");
        db.prepare(`UPDATE kit_profiles SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id NOT IN (${placeholders})`).run(...fixedIds);
      }

      const alum20x20 = findProfile.get("Alüminyum", "Kare", "20x20 mm", "1.5 mm") as { id: string } | undefined;
      if (alum20x20) {
        db.prepare(`
          INSERT OR IGNORE INTO kit_profile_offers (
            id, profile_id, supplier, price_per_meter, currency, lead_time_days, supplier_sku, notes, is_preferred
          ) VALUES (?, ?, 'sandemir', 24.6, 'TRY', 0, '', '', 0)
        `).run("fixed-offer-aluminyum-kare-20x20-1-5-sandemir", alum20x20.id);
      }
    },
  },
  {
    version: 49,
    name: "add_warehouse_picker_lock_and_progress",
    up(db) {
      for (const sql of [
        "ALTER TABLE users ADD COLUMN email TEXT",
        "ALTER TABLE sales ADD COLUMN warehouse_picker_user_id TEXT",
        "ALTER TABLE sales ADD COLUMN warehouse_picker_name TEXT",
        "ALTER TABLE sales ADD COLUMN warehouse_picking_started_at DATETIME",
        "ALTER TABLE sales ADD COLUMN warehouse_picking_completed_at DATETIME",
      ]) try { db.exec(sql); } catch (_) {}

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
          ON users(email) WHERE email IS NOT NULL AND email != '';

        CREATE TABLE IF NOT EXISTS warehouse_pick_progress (
          order_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          sku TEXT,
          required_quantity REAL NOT NULL,
          picked_quantity REAL NOT NULL DEFAULT 0,
          picker_user_id TEXT NOT NULL,
          picker_name TEXT NOT NULL,
          verified_by TEXT,
          verified_code_type TEXT CHECK(verified_code_type IN ('sku', 'barcode', 'location')),
          completed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(order_id, product_id),
          FOREIGN KEY(order_id) REFERENCES sales(id) ON DELETE CASCADE,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
        );

        CREATE INDEX IF NOT EXISTS idx_warehouse_pick_progress_picker
          ON warehouse_pick_progress(picker_user_id, updated_at);
      `);
    },
  },
  {
    version: 50,
    name: "add_multilingual_product_names_and_logistics",
    up(db) {
      const productColumns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!productColumns.has("name_tr")) db.exec("ALTER TABLE products ADD COLUMN name_tr TEXT");
      if (!productColumns.has("name_en")) db.exec("ALTER TABLE products ADD COLUMN name_en TEXT");

      db.exec(`
        UPDATE products
        SET name_tr = COALESCE(NULLIF(TRIM(name_tr), ''), NULLIF(TRIM(name), ''), NULLIF(TRIM(title), ''))
        WHERE COALESCE(TRIM(name_tr), '') = '';

        UPDATE products
        SET product_type = 'simple'
        WHERE LOWER(TRIM(COALESCE(product_type, ''))) IN ('', 'finished', 'final', 'normal');

        UPDATE products
        SET product_type = 'assembly'
        WHERE id IN (SELECT DISTINCT parent_product_id FROM product_bom);

        UPDATE products
        SET weight_grams = weight
        WHERE COALESCE(weight_grams, 0) = 0 AND COALESCE(weight, 0) > 0;

        UPDATE products
        SET name = COALESCE(NULLIF(TRIM(name_tr), ''), NULLIF(TRIM(name_en), ''), NULLIF(TRIM(title), ''), name);

        CREATE TABLE IF NOT EXISTS product_logistics (
          product_id       TEXT PRIMARY KEY,
          box_count        INTEGER,
          units_per_box    INTEGER,
          box_weight_kg    REAL,
          total_weight_kg  REAL,
          created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS product_reserve_locations (
          id          TEXT PRIMARY KEY,
          product_id  TEXT NOT NULL,
          location    TEXT NOT NULL,
          sort_order  INTEGER DEFAULT 0,
          created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(product_id, location),
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_products_name_tr ON products(name_tr);
        CREATE INDEX IF NOT EXISTS idx_products_name_en ON products(name_en);
        CREATE INDEX IF NOT EXISTS idx_product_reserve_locations_product
          ON product_reserve_locations(product_id, sort_order);
      `);
    },
  },
  {
    version: 51,
    name: "add_pick_history_and_packaging_foundation",
    up(db) {
      const productColumns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!productColumns.has("length_mm")) db.exec("ALTER TABLE products ADD COLUMN length_mm REAL");
      if (!productColumns.has("width_mm")) db.exec("ALTER TABLE products ADD COLUMN width_mm REAL");
      if (!productColumns.has("height_mm")) db.exec("ALTER TABLE products ADD COLUMN height_mm REAL");

      db.exec(`
        CREATE TABLE IF NOT EXISTS pick_sessions (
          id TEXT PRIMARY KEY,
          pick_number TEXT NOT NULL UNIQUE,
          order_id TEXT NOT NULL UNIQUE,
          order_code_snapshot TEXT,
          external_order_id_snapshot TEXT,
          status TEXT NOT NULL DEFAULT 'PICKED'
            CHECK(status IN ('WAITING', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'SHIPPED', 'CANCELLED')),
          started_by_user_id TEXT NOT NULL,
          started_by_name_snapshot TEXT NOT NULL,
          completed_by_user_id TEXT NOT NULL,
          completed_by_name_snapshot TEXT NOT NULL,
          started_at DATETIME NOT NULL,
          completed_at DATETIME NOT NULL,
          total_product_types INTEGER NOT NULL DEFAULT 0,
          total_sale_product_quantity REAL NOT NULL DEFAULT 0,
          total_physical_item_quantity REAL NOT NULL DEFAULT 0,
          total_net_weight_g REAL NOT NULL DEFAULT 0,
          note TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(order_id) REFERENCES sales(id) ON DELETE RESTRICT,
          FOREIGN KEY(started_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
          FOREIGN KEY(completed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS pick_session_items (
          id TEXT PRIMARY KEY,
          pick_session_id TEXT NOT NULL,
          sale_item_id TEXT,
          product_id TEXT,
          sku_snapshot TEXT NOT NULL,
          product_name_snapshot TEXT NOT NULL,
          product_type_snapshot TEXT NOT NULL,
          ordered_quantity REAL NOT NULL,
          picked_quantity REAL NOT NULL,
          unit_weight_g_snapshot REAL NOT NULL DEFAULT 0,
          total_weight_g REAL NOT NULL DEFAULT 0,
          total_component_quantity REAL NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(pick_session_id) REFERENCES pick_sessions(id) ON DELETE RESTRICT,
          FOREIGN KEY(sale_item_id) REFERENCES sale_items(id) ON DELETE SET NULL,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS pick_session_components (
          id TEXT PRIMARY KEY,
          pick_session_item_id TEXT NOT NULL,
          component_product_id TEXT,
          component_sku_snapshot TEXT NOT NULL,
          component_name_snapshot TEXT NOT NULL,
          quantity_per_product REAL NOT NULL,
          picked_product_quantity REAL NOT NULL,
          total_component_quantity REAL NOT NULL,
          unit_weight_g_snapshot REAL NOT NULL DEFAULT 0,
          total_weight_g REAL NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(pick_session_item_id) REFERENCES pick_session_items(id) ON DELETE RESTRICT,
          FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_pick_sessions_completed ON pick_sessions(completed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pick_sessions_picker ON pick_sessions(completed_by_user_id, completed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_pick_session_items_session ON pick_session_items(pick_session_id);
        CREATE INDEX IF NOT EXISTS idx_pick_session_items_search ON pick_session_items(sku_snapshot, product_name_snapshot);
        CREATE INDEX IF NOT EXISTS idx_pick_session_components_item ON pick_session_components(pick_session_item_id);

        CREATE TABLE IF NOT EXISTS packaging_types (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          inner_length_mm REAL,
          inner_width_mm REAL,
          inner_height_mm REAL,
          outer_length_mm REAL,
          outer_width_mm REAL,
          outer_height_mm REAL,
          empty_weight_g REAL DEFAULT 0,
          max_weight_g REAL,
          cost REAL DEFAULT 0,
          active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS shipping_volume_rules (
          id TEXT PRIMARY KEY,
          carrier_code TEXT NOT NULL,
          service_code TEXT,
          divisor_cm3 REAL NOT NULL CHECK(divisor_cm3 > 0),
          active INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(carrier_code, service_code)
        );
      `);
    },
  },
  {
    version: 52,
    name: "add_warehouse_inbound_packages_and_print_queue",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS warehouse_sequences (
          sequence_key TEXT PRIMARY KEY,
          next_value INTEGER NOT NULL DEFAULT 1 CHECK(next_value > 0),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS warehouse_locations (
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

        CREATE TABLE IF NOT EXISTS inbound_batches (
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
          completed_at DATETIME,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS inbound_batch_lines (
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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(batch_id, line_number),
          FOREIGN KEY(batch_id) REFERENCES inbound_batches(id) ON DELETE RESTRICT,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS label_templates (
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_label_templates_one_default
          ON label_templates(template_type) WHERE is_default = 1 AND active = 1;

        CREATE TABLE IF NOT EXISTS warehouse_packages (
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
          placed_at DATETIME,
          UNIQUE(batch_line_id, package_number),
          FOREIGN KEY(batch_id) REFERENCES inbound_batches(id) ON DELETE RESTRICT,
          FOREIGN KEY(batch_line_id) REFERENCES inbound_batch_lines(id) ON DELETE RESTRICT,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
          FOREIGN KEY(claimed_by) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(label_template_id) REFERENCES label_templates(id) ON DELETE SET NULL,
          FOREIGN KEY(current_location_id) REFERENCES warehouse_locations(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS print_jobs (
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

        CREATE TABLE IF NOT EXISTS package_placements (
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

        CREATE TABLE IF NOT EXISTS warehouse_package_movements (
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

        CREATE TABLE IF NOT EXISTS warehouse_stock_counts (
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

        CREATE INDEX IF NOT EXISTS idx_inbound_batches_supplier_status
          ON inbound_batches(supplier_code, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_inbound_lines_batch
          ON inbound_batch_lines(batch_id, line_number);
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_claim
          ON warehouse_packages(supplier_code, status, claim_expires_at, batch_id, batch_line_id, package_number);
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_pick
          ON warehouse_packages(product_id, status, batch_id, batch_line_id, package_number);
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_location
          ON warehouse_packages(current_location_id, status);
        CREATE INDEX IF NOT EXISTS idx_print_jobs_worker
          ON print_jobs(status, attempts, created_at);
        CREATE INDEX IF NOT EXISTS idx_package_movements_product
          ON warehouse_package_movements(product_id, created_at);
      `);
    },
  },
  {
    version: 53,
    name: "add_lot_driven_receiving_sessions",
    up(db) {
      const batchColumns = new Set(
        (db.prepare("PRAGMA table_info(inbound_batches)").all() as { name: string }[]).map((column) => column.name),
      );
      const addBatchColumn = (name: string, definition: string) => {
        if (!batchColumns.has(name)) db.exec(`ALTER TABLE inbound_batches ADD COLUMN ${definition}`);
      };
      addBatchColumn("lot_number", "lot_number TEXT COLLATE NOCASE");
      addBatchColumn("receiving_state", "receiving_state TEXT NOT NULL DEFAULT 'active'");
      addBatchColumn("started_by", "started_by TEXT");
      addBatchColumn("started_at", "started_at DATETIME");
      addBatchColumn("paused_at", "paused_at DATETIME");
      addBatchColumn("cancelled_at", "cancelled_at DATETIME");
      addBatchColumn("force_completed_by", "force_completed_by TEXT");
      addBatchColumn("force_complete_reason", "force_complete_reason TEXT");

      const lineColumns = new Set(
        (db.prepare("PRAGMA table_info(inbound_batch_lines)").all() as { name: string }[]).map((column) => column.name),
      );
      const addLineColumn = (name: string, definition: string) => {
        if (!lineColumns.has(name)) db.exec(`ALTER TABLE inbound_batch_lines ADD COLUMN ${definition}`);
      };
      addLineColumn("supplier_no_snapshot", "supplier_no_snapshot TEXT");
      addLineColumn("name_tr_snapshot", "name_tr_snapshot TEXT");
      addLineColumn("name_en_snapshot", "name_en_snapshot TEXT");
      addLineColumn("material_snapshot", "material_snapshot TEXT");
      addLineColumn("series_snapshot", "series_snapshot TEXT");
      addLineColumn("model_snapshot", "model_snapshot TEXT");
      addLineColumn("form_snapshot", "form_snapshot TEXT");
      addLineColumn("size_snapshot", "size_snapshot TEXT");
      addLineColumn("unit_weight_g_snapshot", "unit_weight_g_snapshot REAL NOT NULL DEFAULT 0");
      addLineColumn("package_weight_kg_snapshot", "package_weight_kg_snapshot REAL NOT NULL DEFAULT 0");
      addLineColumn("total_weight_kg_snapshot", "total_weight_kg_snapshot REAL NOT NULL DEFAULT 0");
      addLineColumn("image_path_snapshot", "image_path_snapshot TEXT");

      const packageColumns = new Set(
        (db.prepare("PRAGMA table_info(warehouse_packages)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!packageColumns.has("recommended_location_id")) {
        db.exec("ALTER TABLE warehouse_packages ADD COLUMN recommended_location_id TEXT REFERENCES warehouse_locations(id) ON DELETE SET NULL");
      }
      if (!packageColumns.has("recommended_at")) {
        db.exec("ALTER TABLE warehouse_packages ADD COLUMN recommended_at DATETIME");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS inbound_lot_lines (
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

        CREATE TABLE IF NOT EXISTS inbound_session_events (
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

        CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_batches_lot
          ON inbound_batches(lot_number) WHERE lot_number IS NOT NULL AND TRIM(lot_number) <> '';
        CREATE INDEX IF NOT EXISTS idx_inbound_lot_lines_lot
          ON inbound_lot_lines(lot_number, supplier_code);
        CREATE INDEX IF NOT EXISTS idx_inbound_session_events_batch
          ON inbound_session_events(batch_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_recommended_location
          ON warehouse_packages(recommended_location_id, status);
      `);
    },
  },
  {
    version: 54,
    name: "snapshot_receiving_planned_locations",
    up(db) {
      const lineColumns = new Set(
        (db.prepare("PRAGMA table_info(inbound_batch_lines)").all() as { name: string }[]).map((column) => column.name),
      );
      if (!lineColumns.has("planned_location_snapshot")) {
        db.exec("ALTER TABLE inbound_batch_lines ADD COLUMN planned_location_snapshot TEXT COLLATE NOCASE");
      }
      if (!lineColumns.has("reserve_locations_snapshot")) {
        db.exec("ALTER TABLE inbound_batch_lines ADD COLUMN reserve_locations_snapshot TEXT");
      }
      const productColumns = new Set(
        (db.prepare("PRAGMA table_info(products)").all() as { name: string }[]).map((column) => column.name),
      );
      const plannedLocationColumn = productColumns.has("warehouse_location") ? "p.warehouse_location" : "NULL";
      const existingLines = db.prepare(`
        SELECT l.id, l.product_id, ${plannedLocationColumn} AS warehouse_location
        FROM inbound_batch_lines l
        LEFT JOIN products p ON p.id = l.product_id
        WHERE l.planned_location_snapshot IS NULL
          AND l.reserve_locations_snapshot IS NULL
      `).all() as Array<{ id: string; product_id: string; warehouse_location: string | null }>;
      const reserves = db.prepare(`
        SELECT location
        FROM product_reserve_locations
        WHERE product_id = ?
        ORDER BY sort_order, created_at, id
      `);
      const snapshot = db.prepare(`
        UPDATE inbound_batch_lines
        SET planned_location_snapshot = ?, reserve_locations_snapshot = ?
        WHERE id = ?
      `);
      for (const line of existingLines) {
        const reserveLocations = (reserves.all(line.product_id) as Array<{ location: string }>).map(({ location }) => location);
        snapshot.run(line.warehouse_location || null, JSON.stringify(reserveLocations), line.id);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_inbound_lines_planned_location
          ON inbound_batch_lines(planned_location_snapshot);
      `);
    },
  },
  {
    version: 55,
    name: "receiving_v2_work_state_and_location_reservations",
    up(db) {
      const usersTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
      if (!usersTableExists) return;
      const packageColumns = new Set(
        (db.prepare("PRAGMA table_info(warehouse_packages)").all() as { name: string }[]).map((column) => column.name),
      );
      const addPackageColumn = (name: string, definition: string) => {
        if (!packageColumns.has(name)) db.exec(`ALTER TABLE warehouse_packages ADD COLUMN ${definition}`);
      };
      addPackageColumn("receiving_device_id", "receiving_device_id TEXT");
      addPackageColumn("receiving_work_started_at", "receiving_work_started_at DATETIME");
      addPackageColumn("receiving_last_activity_at", "receiving_last_activity_at DATETIME");
      addPackageColumn("receiving_location_reserved_at", "receiving_location_reserved_at DATETIME");
      addPackageColumn("placed_by_user_id", "placed_by_user_id TEXT");
      addPackageColumn("placed_by_username", "placed_by_username TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_receiving_owner
          ON warehouse_packages(claimed_by, status, batch_id);
        CREATE INDEX IF NOT EXISTS idx_warehouse_packages_location_reservation
          ON warehouse_packages(recommended_location_id, receiving_location_reserved_at, status);
      `);
      if (usersTableExists) {
        db.exec(`
          UPDATE warehouse_packages
          SET receiving_work_started_at = COALESCE(receiving_work_started_at, updated_at, created_at),
              receiving_last_activity_at = COALESCE(receiving_last_activity_at, updated_at, created_at)
          WHERE claimed_by IS NOT NULL
            AND status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED');
          UPDATE warehouse_packages
          SET placed_by_user_id = COALESCE(placed_by_user_id, (
            SELECT pp.actor_id FROM package_placements pp
            WHERE pp.package_id = warehouse_packages.id AND pp.action = 'PLACE'
            ORDER BY datetime(pp.created_at) DESC, pp.id DESC LIMIT 1
          ))
          WHERE status IN ('PLACED','OPEN','EMPTY');
          UPDATE warehouse_packages
          SET placed_by_username = COALESCE(placed_by_username, (
            SELECT u.username FROM package_placements pp
            LEFT JOIN users u ON u.id = pp.actor_id
            WHERE pp.package_id = warehouse_packages.id AND pp.action = 'PLACE'
            ORDER BY datetime(pp.created_at) DESC, pp.id DESC LIMIT 1
          ))
          WHERE status IN ('PLACED','OPEN','EMPTY');
        `);
      }

      const normalize = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
      const validPhysicalCode = (value: string) => /^[A-Z]+\d+-K\d+-P\d+$/.test(value);
      const locations = db.prepare("SELECT id, code FROM warehouse_locations").all() as Array<{ id: string; code: string }>;
      const knownCodes = new Set(locations.map(({ code }) => normalize(code)));
      const lines = db.prepare("SELECT id, planned_location_snapshot, reserve_locations_snapshot FROM inbound_batch_lines").all() as Array<{
        id: string; planned_location_snapshot: string | null; reserve_locations_snapshot: string | null;
      }>;
      const insertLocation = db.prepare(`
        INSERT INTO warehouse_locations (id, code, package_capacity, notes)
        VALUES (lower(hex(randomblob(16))), ?, 1, 'Mal Kabul V2 master lokasyon senkronizasyonu')
      `);
      const updateLine = db.prepare("UPDATE inbound_batch_lines SET planned_location_snapshot = ?, reserve_locations_snapshot = ? WHERE id = ?");
      for (const line of lines) {
        const planned = normalize(line.planned_location_snapshot) || null;
        let reserves: string[] = [];
        try {
          const parsed = JSON.parse(String(line.reserve_locations_snapshot || "[]"));
          if (Array.isArray(parsed)) reserves = [...new Set(parsed.map(normalize).filter(Boolean))];
        } catch { reserves = []; }
        for (const code of [planned, ...reserves]) {
          if (!code || knownCodes.has(code) || !validPhysicalCode(code) || !usersTableExists) continue;
          insertLocation.run(code);
          knownCodes.add(code);
        }
        updateLine.run(planned, JSON.stringify(reserves), line.id);
      }
    },
  },
  {
    version: 56,
    name: "raise_auto_synced_receiving_location_capacity",
    up(db) {
      const locationsTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_locations'").get());
      if (!locationsTableExists) return;
      db.prepare(`
        UPDATE warehouse_locations
        SET package_capacity = 4, updated_at = CURRENT_TIMESTAMP
        WHERE package_capacity = 1
          AND notes = 'Mal Kabul V2 master lokasyon senkronizasyonu'
      `).run();
    },
  },
  {
    version: 57,
    name: "add_versioned_warehouse_layouts",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS warehouse_layouts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          layout_version INTEGER NOT NULL DEFAULT 1 CHECK(layout_version > 0),
          layout_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
          created_by TEXT,
          updated_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
          FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouse_layouts_one_active
          ON warehouse_layouts(active) WHERE active = 1;
        CREATE INDEX IF NOT EXISTS idx_warehouse_layouts_updated
          ON warehouse_layouts(updated_at DESC);
      `);
    },
  },
  {
    version: 58,
    name: "add_product_placement_layouts",
    up(db) {
      const layoutColumns = new Set((db.prepare("PRAGMA table_info(warehouse_layouts)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!layoutColumns.has("source_filename")) db.exec("ALTER TABLE warehouse_layouts ADD COLUMN source_filename TEXT");
      if (!layoutColumns.has("status")) db.exec("ALTER TABLE warehouse_layouts ADD COLUMN status TEXT NOT NULL DEFAULT 'ARCHIVED'");
      if (!layoutColumns.has("notes")) db.exec("ALTER TABLE warehouse_layouts ADD COLUMN notes TEXT");
      db.exec("UPDATE warehouse_layouts SET status = CASE WHEN active = 1 THEN 'ACTIVE' ELSE 'ARCHIVED' END");

      const locationColumns = new Set((db.prepare("PRAGMA table_info(warehouse_locations)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!locationColumns.has("purpose")) db.exec("ALTER TABLE warehouse_locations ADD COLUMN purpose TEXT");
      if (!locationColumns.has("reserve_weight_preference")) db.exec("ALTER TABLE warehouse_locations ADD COLUMN reserve_weight_preference TEXT");
      db.exec(`
        UPDATE warehouse_locations SET purpose = CASE
          WHEN code LIKE '%-K1-%' OR code LIKE '%-K2-%' THEN 'PICK'
          WHEN code LIKE '%-K3-%' OR code LIKE '%-K4-%' THEN 'RESERVE'
          ELSE 'RESERVE' END
        WHERE purpose IS NULL OR TRIM(purpose) = '';
        UPDATE warehouse_locations SET reserve_weight_preference = CASE
          WHEN code LIKE '%-K3-%' THEN 'HEAVY'
          WHEN code LIKE '%-K4-%' THEN 'LIGHT'
          ELSE 'ANY' END
        WHERE reserve_weight_preference IS NULL OR TRIM(reserve_weight_preference) = '';

        CREATE TABLE IF NOT EXISTS warehouse_layout_assignments (
          id TEXT PRIMARY KEY,
          layout_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          pick_face_location_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(layout_id, product_id),
          UNIQUE(layout_id, pick_face_location_id),
          FOREIGN KEY(layout_id) REFERENCES warehouse_layouts(id) ON DELETE CASCADE,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
          FOREIGN KEY(pick_face_location_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS warehouse_layout_reserve_locations (
          id TEXT PRIMARY KEY,
          assignment_id TEXT NOT NULL,
          location_id TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(assignment_id, location_id),
          UNIQUE(assignment_id, priority),
          FOREIGN KEY(assignment_id) REFERENCES warehouse_layout_assignments(id) ON DELETE CASCADE,
          FOREIGN KEY(location_id) REFERENCES warehouse_locations(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS warehouse_rack_metadata (
          rack_code TEXT PRIMARY KEY COLLATE NOCASE,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RESERVE','RESTRICTED','DISABLED')),
          placement_priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK(placement_priority IN ('NORMAL','LOW','LAST_RESORT')),
          notes TEXT,
          updated_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_warehouse_layout_assignments_layout
          ON warehouse_layout_assignments(layout_id, product_id);
        CREATE INDEX IF NOT EXISTS idx_warehouse_layout_reserves_assignment
          ON warehouse_layout_reserve_locations(assignment_id, priority);
      `);
      const usersTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
      if (usersTableExists) {
        db.prepare(`INSERT OR IGNORE INTO warehouse_rack_metadata (rack_code, status, placement_priority, notes)
          VALUES ('C2', 'RESTRICTED', 'LAST_RESORT', 'Kısıtlı erişim / Son çare')`).run();
      }
    },
  },
  {
    version: 59,
    name: "add_purpose_label_print_jobs",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS label_print_jobs (
          id TEXT PRIMARY KEY,
          purpose TEXT NOT NULL CHECK(purpose IN ('goods_receipt','location','product_package','kit','shipping','custom')),
          subject_type TEXT NOT NULL,
          subject_id TEXT,
          label_code TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'QUEUED'
            CHECK(status IN ('QUEUED','PROCESSING','PRINTED','FAILED','CANCELLED')),
          printer_name TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          error_message TEXT,
          claimed_at DATETIME,
          printed_at DATETIME,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_label_print_jobs_worker
          ON label_print_jobs(status, attempts, created_at);
      `);
    },
  },
  {
    version: 60,
    name: "repair_physical_warehouse_layout_and_locations",
    up(db) {
      const layoutTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_layouts'").get());
      const locationsTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_locations'").get());
      if (!layoutTableExists || !locationsTableExists) return;

      const activeLayout = db.prepare("SELECT id, layout_json FROM warehouse_layouts WHERE active = 1").get() as
        | { id: string; layout_json: string }
        | undefined;
      if (!activeLayout) return;

      const layout = JSON.parse(activeLayout.layout_json) as {
        objects?: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
      if (!Array.isArray(layout.objects)) return;

      const rackCodes: string[] = [];
      for (const object of layout.objects) {
        if (object?.type !== "rack") continue;
        const rackCode = String(object.rackCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
        if (!rackCode) continue;
        object.rackCode = rackCode;
        object.shelfCount = 4;
        object.positionsPerShelf = 7;
        rackCodes.push(rackCode);
      }

      db.prepare("UPDATE warehouse_layouts SET layout_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(JSON.stringify(layout), activeLayout.id);

      const insertLocation = db.prepare(`
        INSERT OR IGNORE INTO warehouse_locations
          (id, code, package_capacity, purpose, reserve_weight_preference, notes)
        VALUES (lower(hex(randomblob(16))), ?, 4, ?, ?, 'Fiziksel depo layout senkronizasyonu')
      `);
      for (const rackCode of [...new Set(rackCodes)]) {
        for (let level = 1; level <= 4; level += 1) {
          const purpose = level <= 2 ? "PICK" : "RESERVE";
          const weightPreference = level === 3 ? "HEAVY" : level === 4 ? "LIGHT" : "ANY";
          for (let position = 1; position <= 7; position += 1) {
            insertLocation.run(`${rackCode}-K${level}-P${position}`, purpose, weightPreference);
          }
        }
      }

      const rackMetadataTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_rack_metadata'").get());
      if (rackMetadataTableExists) {
        db.prepare(`INSERT OR IGNORE INTO warehouse_rack_metadata (rack_code, status, placement_priority, notes)
          VALUES ('C2', 'RESTRICTED', 'LAST_RESORT', 'Kısıtlı erişim / Son çare')`).run();
      }
    },
  },
  {
    version: 61,
    name: "normalize_products_product_type_default",
    up(db) {
      const productType = (db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string; dflt_value: string | null }>)
        .find(({ name }) => name === "product_type");
      if (!productType || productType.dflt_value === "'simple'") return;
      db.exec(`
        ALTER TABLE products RENAME COLUMN product_type TO product_type_legacy_v61;
        ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'simple';
        UPDATE products SET product_type = product_type_legacy_v61;
        ALTER TABLE products DROP COLUMN product_type_legacy_v61;
      `);
    },
  },
  {
    version: 62,
    name: "add_revocable_user_sessions",
    up(db) {
      const userColumns = new Set((db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!userColumns.has("session_epoch")) {
        db.exec("ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id                   TEXT PRIMARY KEY,
          user_id              TEXT NOT NULL,
          session_epoch        INTEGER NOT NULL,
          service_principal_id TEXT,
          expires_at           DATETIME NOT NULL,
          revoked_at           DATETIME,
          revoked_reason       TEXT,
          created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_seen_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(service_principal_id) REFERENCES panel_api_keys(id) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active
          ON user_sessions(user_id, revoked_at, expires_at);
      `);
    },
  },
  {
    version: 63,
    name: "add_command_idempotency_audit_outbox_foundation",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS command_operations (
          id                 TEXT PRIMARY KEY,
          actor_scope        TEXT NOT NULL,
          operation_id       TEXT NOT NULL,
          command_type       TEXT NOT NULL,
          payload_hash       TEXT NOT NULL CHECK(length(payload_hash) = 64),
          result_status_code INTEGER NOT NULL,
          result_json        TEXT NOT NULL,
          result_hash        TEXT NOT NULL CHECK(length(result_hash) = 64),
          committed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(actor_scope, command_type, operation_id)
        );

        CREATE TABLE IF NOT EXISTS command_audit_log (
          id                     TEXT PRIMARY KEY,
          operation_record_id    TEXT NOT NULL UNIQUE,
          operation_id           TEXT NOT NULL,
          human_actor_id         TEXT,
          human_actor_name       TEXT,
          service_actor_id       TEXT,
          service_actor_name     TEXT,
          command_type           TEXT NOT NULL,
          payload_hash           TEXT NOT NULL CHECK(length(payload_hash) = 64),
          authorization_decision TEXT NOT NULL CHECK(authorization_decision IN ('ALLOW')),
          capability             TEXT NOT NULL,
          result_status_code     INTEGER NOT NULL,
          result_hash            TEXT NOT NULL CHECK(length(result_hash) = 64),
          correlation_id         TEXT,
          request_id             TEXT,
          request_metadata_json  TEXT,
          created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK(human_actor_id IS NOT NULL OR service_actor_id IS NOT NULL),
          FOREIGN KEY(operation_record_id) REFERENCES command_operations(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS command_outbox (
          id                  TEXT PRIMARY KEY,
          operation_record_id TEXT NOT NULL,
          event_index         INTEGER NOT NULL CHECK(event_index >= 0),
          topic               TEXT NOT NULL,
          event_type          TEXT NOT NULL,
          aggregate_type      TEXT,
          aggregate_id        TEXT,
          payload_json        TEXT NOT NULL,
          payload_hash        TEXT NOT NULL CHECK(length(payload_hash) = 64),
          status              TEXT NOT NULL DEFAULT 'PENDING'
                              CHECK(status IN ('PENDING','PROCESSING','DELIVERED','FAILED','DEAD_LETTER')),
          available_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          claimed_at          DATETIME,
          claimed_by          TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
          last_error_code     TEXT,
          delivered_at        DATETIME,
          created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(operation_record_id, event_index),
          FOREIGN KEY(operation_record_id) REFERENCES command_operations(id) ON DELETE RESTRICT
        );

        CREATE TRIGGER IF NOT EXISTS trg_command_operations_immutable_update
        BEFORE UPDATE ON command_operations BEGIN
          SELECT RAISE(ABORT, 'command_operations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_command_operations_immutable_delete
        BEFORE DELETE ON command_operations BEGIN
          SELECT RAISE(ABORT, 'command_operations are immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_command_audit_immutable_update
        BEFORE UPDATE ON command_audit_log BEGIN
          SELECT RAISE(ABORT, 'command_audit_log is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_command_audit_immutable_delete
        BEFORE DELETE ON command_audit_log BEGIN
          SELECT RAISE(ABORT, 'command_audit_log is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_command_outbox_payload_immutable
        BEFORE UPDATE OF operation_record_id, event_index, topic, event_type,
          aggregate_type, aggregate_id, payload_json, payload_hash, created_at
        ON command_outbox BEGIN
          SELECT RAISE(ABORT, 'command_outbox payload is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_command_outbox_no_delete
        BEFORE DELETE ON command_outbox BEGIN
          SELECT RAISE(ABORT, 'command_outbox rows cannot be deleted');
        END;

        CREATE INDEX IF NOT EXISTS idx_command_operations_lookup
          ON command_operations(actor_scope, command_type, operation_id);
        CREATE INDEX IF NOT EXISTS idx_command_audit_operation
          ON command_audit_log(operation_id, command_type, created_at);
        CREATE INDEX IF NOT EXISTS idx_command_outbox_dispatch
          ON command_outbox(status, available_at, created_at);
      `);
    },
  },
  {
    version: 64,
    name: "add_versioned_catalog_uom_contract",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS uom_definitions (
          code TEXT PRIMARY KEY,
          dimension TEXT NOT NULL CHECK(dimension IN ('count','length','area','mass')),
          base_quantum TEXT NOT NULL,
          quantity_scale INTEGER NOT NULL CHECK(quantity_scale > 0),
          registry_version TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS uom_conversions (
          id TEXT PRIMARY KEY,
          from_uom_code TEXT NOT NULL,
          to_uom_code TEXT NOT NULL,
          numerator INTEGER NOT NULL CHECK(numerator > 0),
          denominator INTEGER NOT NULL CHECK(denominator > 0),
          version INTEGER NOT NULL CHECK(version > 0),
          version_ref TEXT NOT NULL UNIQUE,
          effective_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          retired_at DATETIME,
          UNIQUE(from_uom_code, to_uom_code, version),
          FOREIGN KEY(from_uom_code) REFERENCES uom_definitions(code) ON DELETE RESTRICT,
          FOREIGN KEY(to_uom_code) REFERENCES uom_definitions(code) ON DELETE RESTRICT
        );
      `);
      const insertUnit = db.prepare(`INSERT OR IGNORE INTO uom_definitions
        (code, dimension, base_quantum, quantity_scale, registry_version) VALUES (?, ?, ?, ?, 'uom-registry:v1')`);
      for (const row of [
        ["piece", "count", "piece", 1], ["meter", "length", "millimeter", 1000],
        ["square_meter", "area", "square_millimeter", 1_000_000], ["kg", "mass", "gram", 1000],
        ["roll", "count", "roll", 1], ["package", "count", "package", 1], ["box", "count", "box", 1],
        ["millimeter", "length", "millimeter", 1], ["centimeter", "length", "millimeter", 10],
        ["gram", "mass", "gram", 1],
      ] as const) insertUnit.run(...row);
      const insertConversion = db.prepare(`INSERT OR IGNORE INTO uom_conversions
        (id, from_uom_code, to_uom_code, numerator, denominator, version, version_ref)
        VALUES (?, ?, ?, ?, ?, 1, ?)`);
      for (const row of [
        ["mm-cm-v1", "millimeter", "centimeter", 1, 10, "uom-conversion:millimeter:centimeter:v1"],
        ["cm-mm-v1", "centimeter", "millimeter", 10, 1, "uom-conversion:centimeter:millimeter:v1"],
        ["cm-m-v1", "centimeter", "meter", 1, 100, "uom-conversion:centimeter:meter:v1"],
        ["m-cm-v1", "meter", "centimeter", 100, 1, "uom-conversion:meter:centimeter:v1"],
        ["mm-m-v1", "millimeter", "meter", 1, 1000, "uom-conversion:millimeter:meter:v1"],
        ["m-mm-v1", "meter", "millimeter", 1000, 1, "uom-conversion:meter:millimeter:v1"],
        ["g-kg-v1", "gram", "kg", 1, 1000, "uom-conversion:gram:kg:v1"],
        ["kg-g-v1", "kg", "gram", 1000, 1, "uom-conversion:kg:gram:v1"],
      ] as const) insertConversion.run(...row);

      const productColumns = new Set((db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(({ name }) => name));
      const addProductColumn = (name: string, definition: string) => {
        if (!productColumns.has(name)) db.exec(`ALTER TABLE products ADD COLUMN ${definition}`);
      };
      addProductColumn("catalog_type", "catalog_type TEXT NOT NULL DEFAULT 'product' CHECK(catalog_type IN ('product','profile','connector','cap','wheel'))");
      // SQLite rejects adding a REFERENCES column with a non-NULL default while
      // foreign keys are enabled. Fresh schemas carry the FK; upgrades retain
      // the same value contract and are guarded by CatalogService validation.
      addProductColumn("base_uom_code", "base_uom_code TEXT NOT NULL DEFAULT 'piece'");
      addProductColumn("catalog_version", "catalog_version INTEGER NOT NULL DEFAULT 0 CHECK(catalog_version >= 0)");
      addProductColumn("catalog_version_ref", "catalog_version_ref TEXT");
      addProductColumn("uom_registry_version", "uom_registry_version TEXT NOT NULL DEFAULT 'uom-registry:v1'");
      addProductColumn("length_mm_int", "length_mm_int INTEGER CHECK(length_mm_int IS NULL OR length_mm_int >= 0)");
      addProductColumn("width_mm_int", "width_mm_int INTEGER CHECK(width_mm_int IS NULL OR width_mm_int >= 0)");
      addProductColumn("height_mm_int", "height_mm_int INTEGER CHECK(height_mm_int IS NULL OR height_mm_int >= 0)");
      addProductColumn("diameter_mm_int", "diameter_mm_int INTEGER CHECK(diameter_mm_int IS NULL OR diameter_mm_int >= 0)");
      addProductColumn("mass_grams_int", "mass_grams_int INTEGER CHECK(mass_grams_int IS NULL OR mass_grams_int >= 0)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS product_profile_attributes (
          product_id TEXT PRIMARY KEY,
          material TEXT NOT NULL,
          form TEXT NOT NULL CHECK(form IN ('square','rectangular','round','channel','angle','flat','other')),
          width_mm INTEGER CHECK(width_mm IS NULL OR width_mm > 0),
          height_mm INTEGER CHECK(height_mm IS NULL OR height_mm > 0),
          diameter_mm INTEGER CHECK(diameter_mm IS NULL OR diameter_mm > 0),
          wall_thickness_mm INTEGER NOT NULL CHECK(wall_thickness_mm > 0),
          standard_purchase_lengths_mm_json TEXT NOT NULL,
          custom_length_allowed INTEGER NOT NULL DEFAULT 0 CHECK(custom_length_allowed IN (0,1)),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS catalog_product_versions (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          catalog_version INTEGER NOT NULL CHECK(catalog_version > 0),
          version_ref TEXT NOT NULL UNIQUE,
          schema_version TEXT NOT NULL,
          uom_registry_version TEXT NOT NULL,
          base_uom_code TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(product_id, catalog_version),
          FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
          FOREIGN KEY(base_uom_code) REFERENCES uom_definitions(code) ON DELETE RESTRICT
        );
        CREATE INDEX IF NOT EXISTS idx_catalog_product_versions_product ON catalog_product_versions(product_id, catalog_version DESC);
        CREATE INDEX IF NOT EXISTS idx_products_catalog_contract ON products(catalog_type, catalog_version, status);
        CREATE TRIGGER IF NOT EXISTS trg_catalog_product_versions_immutable_update
        BEFORE UPDATE ON catalog_product_versions BEGIN SELECT RAISE(ABORT, 'catalog_product_versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_catalog_product_versions_immutable_delete
        BEFORE DELETE ON catalog_product_versions BEGIN SELECT RAISE(ABORT, 'catalog_product_versions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_uom_definitions_immutable_update
        BEFORE UPDATE ON uom_definitions BEGIN SELECT RAISE(ABORT, 'uom_definitions are immutable; create a new registry version'); END;
        CREATE TRIGGER IF NOT EXISTS trg_uom_definitions_immutable_delete
        BEFORE DELETE ON uom_definitions BEGIN SELECT RAISE(ABORT, 'uom_definitions are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS trg_uom_conversions_immutable_update
        BEFORE UPDATE ON uom_conversions BEGIN SELECT RAISE(ABORT, 'uom_conversions are immutable; create a new version'); END;
        CREATE TRIGGER IF NOT EXISTS trg_uom_conversions_immutable_delete
        BEFORE DELETE ON uom_conversions BEGIN SELECT RAISE(ABORT, 'uom_conversions are immutable'); END;
      `);

      const legacyProducts = db.prepare(`SELECT id, sku, title, name, material,
        length_mm, width_mm, height_mm, weight_grams, status FROM products WHERE catalog_version = 0`).all() as any[];
      const exactNonNegativeInteger = (value: unknown): number | null => {
        const numeric = Number(value);
        return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
      };
      const insertVersion = db.prepare(`INSERT INTO catalog_product_versions
        (id, product_id, catalog_version, version_ref, schema_version, uom_registry_version, base_uom_code, snapshot_json, content_hash)
        VALUES (?, ?, 1, ?, 'dsdst.catalog-product.v1', 'uom-registry:v1', 'piece', ?, ?)`);
      const updateProduct = db.prepare(`UPDATE products SET catalog_type='product', base_uom_code='piece', catalog_version=1,
        catalog_version_ref=?, uom_registry_version='uom-registry:v1', length_mm_int=?, width_mm_int=?, height_mm_int=?, mass_grams_int=? WHERE id=?`);
      for (const product of legacyProducts) {
        const versionRef = `catalog-product:${product.id}:v1`;
        const snapshot = JSON.stringify({
          schema_version: "dsdst.catalog-product.v1", id: product.id, sku: product.sku ?? null,
          title: product.title || product.name || product.id, catalog_type: "product", base_uom_code: "piece",
          uom_registry_version: "uom-registry:v1",
          dimensions: {
            length_mm: exactNonNegativeInteger(product.length_mm), width_mm: exactNonNegativeInteger(product.width_mm),
            height_mm: exactNonNegativeInteger(product.height_mm), diameter_mm: null,
          },
          mass_grams: exactNonNegativeInteger(product.weight_grams), profile: null, status: product.status || "Active",
        });
        const contentHash = createHash("sha256").update(snapshot).digest("hex");
        insertVersion.run(`catalog-version-${product.id}-1`, product.id, versionRef, snapshot, contentHash);
        updateProduct.run(versionRef, exactNonNegativeInteger(product.length_mm), exactNonNegativeInteger(product.width_mm),
          exactNonNegativeInteger(product.height_mm), exactNonNegativeInteger(product.weight_grams), product.id);
      }
    },
  },
  {
    version: 65,
    name: "separate_catalog_cross_section_precision",
    up(db) {
      const productColumns = new Set((db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!productColumns.has("catalog_class")) {
        db.exec("ALTER TABLE products ADD COLUMN catalog_class TEXT CHECK(catalog_class IS NULL OR catalog_class = 'complementary')");
      }
      const profileColumns = new Set((db.prepare("PRAGMA table_info(product_profile_attributes)").all() as Array<{ name: string }>).map(({ name }) => name));
      const existingMicrometers = profileColumns.has("wall_thickness_micrometers");
      db.exec("ALTER TABLE product_profile_attributes RENAME TO product_profile_attributes_v64");
      db.exec(`CREATE TABLE product_profile_attributes (
        product_id TEXT PRIMARY KEY,
        material TEXT NOT NULL,
        form TEXT NOT NULL CHECK(form IN ('square','rectangular','round','channel','angle','flat','other')),
        width_mm INTEGER CHECK(width_mm IS NULL OR width_mm > 0),
        height_mm INTEGER CHECK(height_mm IS NULL OR height_mm > 0),
        diameter_mm INTEGER CHECK(diameter_mm IS NULL OR diameter_mm > 0),
        wall_thickness_mm INTEGER NOT NULL CHECK(wall_thickness_mm > 0),
        width_micrometers INTEGER CHECK(width_micrometers IS NULL OR width_micrometers > 0),
        height_micrometers INTEGER CHECK(height_micrometers IS NULL OR height_micrometers > 0),
        diameter_micrometers INTEGER CHECK(diameter_micrometers IS NULL OR diameter_micrometers > 0),
        wall_thickness_micrometers INTEGER NOT NULL CHECK(wall_thickness_micrometers > 0),
        standard_purchase_lengths_mm_json TEXT NOT NULL,
        custom_length_allowed INTEGER NOT NULL DEFAULT 0 CHECK(custom_length_allowed IN (0,1)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      )`);
      const source = (column: string, fallback: string) => existingMicrometers && profileColumns.has(column) ? column : fallback;
      db.exec(`INSERT INTO product_profile_attributes (
        product_id,material,form,width_mm,height_mm,diameter_mm,wall_thickness_mm,
        width_micrometers,height_micrometers,diameter_micrometers,wall_thickness_micrometers,
        standard_purchase_lengths_mm_json,custom_length_allowed,created_at,updated_at
      ) SELECT product_id,material,form,width_mm,height_mm,diameter_mm,wall_thickness_mm,
        ${source("width_micrometers", "CASE WHEN width_mm IS NULL THEN NULL ELSE CAST(width_mm * 1000 AS INTEGER) END")},
        ${source("height_micrometers", "CASE WHEN height_mm IS NULL THEN NULL ELSE CAST(height_mm * 1000 AS INTEGER) END")},
        ${source("diameter_micrometers", "CASE WHEN diameter_mm IS NULL THEN NULL ELSE CAST(diameter_mm * 1000 AS INTEGER) END")},
        ${source("wall_thickness_micrometers", "CAST(wall_thickness_mm * 1000 AS INTEGER)")},
        standard_purchase_lengths_mm_json,custom_length_allowed,created_at,updated_at
        FROM product_profile_attributes_v64`);
      db.exec("DROP TABLE product_profile_attributes_v64");
    },
  },
  {
    version: 66,
    name: "guard_catalog_uom_and_material_behavior",
    up(db) {
      const productColumns = new Set((db.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!productColumns.has("material_behavior")) {
        db.exec("ALTER TABLE products ADD COLUMN material_behavior TEXT CHECK(material_behavior IS NULL OR material_behavior = 'continuous_cut')");
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_products_base_uom_valid_insert
        BEFORE INSERT ON products
        WHEN NOT EXISTS (SELECT 1 FROM uom_definitions WHERE code=NEW.base_uom_code) BEGIN
          SELECT RAISE(ABORT, 'products.base_uom_code must reference uom_definitions');
        END;
        CREATE TRIGGER IF NOT EXISTS trg_products_base_uom_valid_update
        BEFORE UPDATE OF base_uom_code ON products
        WHEN NOT EXISTS (SELECT 1 FROM uom_definitions WHERE code=NEW.base_uom_code) BEGIN
          SELECT RAISE(ABORT, 'products.base_uom_code must reference uom_definitions');
        END;
      `);
    },
  },
  {
    version: 67,
    name: "add_procurement_acquisition_cost_contract",
    up(db) {
      db.exec(PROCUREMENT_SCHEMA_V67);
      const active = db.prepare(`SELECT id, rate, source, fetched_at
        FROM exchange_rates WHERE base_currency='USD' AND target_currency='TRY' AND is_active=1
        ORDER BY datetime(fetched_at) DESC, rowid DESC LIMIT 1`).get() as
        | { id: string; rate: number; source: string | null; fetched_at: string }
        | undefined;
      if (active && Number.isFinite(active.rate) && active.rate > 0) {
        const denominator = 1_000_000;
        const numerator = Math.round(active.rate * denominator);
        const observationId = `legacy-exchange-rate:${active.id}`;
        db.prepare(`INSERT OR IGNORE INTO fx_rate_observations
          (id,base_currency,quote_currency,rate_numerator,rate_denominator,source,observed_at,actor_id,actor_type)
          VALUES (?, 'USD', 'TRY', ?, ?, ?, ?, 'system:legacy-fx-migration', 'SYSTEM')`)
          .run(observationId, numerator, denominator, active.source || "LEGACY", active.fetched_at);
        db.prepare(`INSERT INTO fx_current_rates (pair_key,observation_id,changed_at,changed_by)
          VALUES ('USD/TRY',?,?, 'system:legacy-fx-migration')
          ON CONFLICT(pair_key) DO UPDATE SET observation_id=excluded.observation_id,
            changed_at=excluded.changed_at,changed_by=excluded.changed_by`)
          .run(observationId, active.fetched_at);
      }
    },
  },
  {
    version: 68,
    name: "remediate_procurement_cash_currency_and_vat_policy",
    up(db) {
      db.exec(PROCUREMENT_REMEDIATION_SCHEMA_V68);
    },
  },
  {
    version: 69,
    name: "add_authoritative_inventory_reservation_contract",
    up(db) {
      db.exec(INVENTORY_SCHEMA_V69);
    },
  },
  {
    version: 70,
    name: "guard_unrepresented_legacy_inventory",
    up(db) {
      assertV70LegacyInventoryRepresented(db);
    },
  },
  {
    version: 71,
    name: "add_authoritative_warehouse_execution_contract",
    up(db) {
      db.exec(WAREHOUSE_EXECUTION_SCHEMA_V71);
    },
  },
  {
    version: 72,
    name: "persist_warehouse_execution_thresholds",
    up(db) {
      db.prepare(`INSERT INTO warehouse_execution_settings
        (id,watch_threshold_pct,prepare_threshold_pct,heavy_package_threshold_grams)
        VALUES ('default',20,10,20000)
        ON CONFLICT(id) DO NOTHING`).run();
    },
  },
  {
    version: 73,
    name: "close_event_driven_replenishment_runtime",
    up(db) {
      db.exec(WAREHOUSE_REPLENISHMENT_RUNTIME_SCHEMA_V73);
    },
  },
  {
    version: 74,
    name: "add_immutable_sale_financial_snapshots",
    up(db) {
      db.exec(SALES_FINANCIAL_SCHEMA_V74);
    },
  },
  {
    version: 75,
    name: "add_returns_refunds_financial_reversals",
    up(db) {
      db.exec(RETURNS_SCHEMA_V75);
    },
  },
  {
    version: 76,
    name: "generalize_warehouse_package_return_origin",
    requiresForeignKeysOff: true,
    up(db) {
      db.exec(WAREHOUSE_PACKAGE_ORIGIN_SCHEMA_V76);
    },
  },
  {
    version: 77,
    name: "add_published_kits_and_profile_piece_inventory",
    up(db) {
      db.exec(PUBLISHED_KIT_SCHEMA_V77);
    },
  },
  {
    version: 78,
    name: "remediate_profile_cut_delivery_and_legacy_representation",
    up(db) {
      db.exec(PROFILE_CUT_REMEDIATION_SCHEMA_V78);
      const lots = db.prepare(`SELECT l.id,l.product_id,l.received_quantity_base_int,l.on_hand_base_int,l.reserved_base_int,
          l.receipt_operation_id,pol.profile_length_mm,c.landed_cost_try_minor,
          (SELECT COUNT(*) FROM profile_inventory_pieces p WHERE p.inventory_lot_id=l.id) AS piece_count,
          (SELECT COALESCE(SUM(p.current_length_mm),0) FROM profile_inventory_pieces p WHERE p.inventory_lot_id=l.id) AS piece_length,
          (SELECT COUNT(*) FROM inventory_ledger_events e WHERE e.lot_id=l.id) AS ledger_count,
          (SELECT COUNT(*) FROM inventory_ledger_events e WHERE e.lot_id=l.id AND e.event_type='RECEIPT'
             AND e.quantity_delta_base_int=l.received_quantity_base_int) AS exact_receipt_count,
          (SELECT COALESCE(SUM(b.quantity_base_int),0) FROM inventory_lot_location_balances b WHERE b.lot_id=l.id) AS location_length
        FROM inventory_lots l JOIN products p ON p.id=l.product_id
        LEFT JOIN purchase_order_lines pol ON pol.id=l.purchase_line_id
        LEFT JOIN acquisition_lot_cost_snapshots c ON c.id=l.acquisition_cost_snapshot_id
        WHERE p.catalog_type='profile' AND l.on_hand_base_int>0 ORDER BY l.id`).all() as any[];
      const insertPiece = db.prepare(`INSERT INTO profile_inventory_pieces (
        id,product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
        original_length_mm,current_length_mm,reserved_length_mm,historical_cost_minor,status,created_operation_id
      ) SELECT ?,l.product_id,l.id,l.acquisition_cost_snapshot_id,?,NULL,?,?,?,0,?,'AVAILABLE',?
        FROM inventory_lots l WHERE l.id=?`);
      const block = db.prepare(`INSERT INTO profile_piece_migration_blocks (inventory_lot_id,product_id,reason_code)
        VALUES (?,?,?)`);
      for (const lot of lots) {
        if (Number(lot.piece_count) > 0) {
          if (Number(lot.piece_length) !== Number(lot.on_hand_base_int)) block.run(lot.id, lot.product_id, "PROFILE_PIECE_BALANCE_UNPROVEN");
          continue;
        }
        const length = Number(lot.profile_length_mm);
        const received = Number(lot.received_quantity_base_int);
        const landed = Number(lot.landed_cost_try_minor);
        const provable = Number.isSafeInteger(length) && length > 0
          && Number(lot.on_hand_base_int) === received && Number(lot.reserved_base_int) === 0
          && received % length === 0 && Number(lot.ledger_count) === 1 && Number(lot.exact_receipt_count) === 1
          && Number(lot.location_length) === received && Number.isSafeInteger(landed) && landed >= 0;
        if (!provable) {
          block.run(lot.id, lot.product_id, "PROFILE_PIECE_MIGRATION_REQUIRED");
          continue;
        }
        const count = received / length;
        const baseCost = Math.floor(landed / count);
        const residue = landed % count;
        for (let index = 0; index < count; index += 1) {
          const id = `v78-profile-piece:${lot.id}:${index + 1}`;
          insertPiece.run(id, id, index + 1, length, length, baseCost + (index < residue ? 1 : 0),
            `v78:derive:${lot.receipt_operation_id}`, lot.id);
        }
      }
      db.prepare(`UPDATE products SET
          purchase_cost=(SELECT v.canonical_cost_minor/100.0 FROM published_kits k JOIN published_kit_versions v ON v.id=k.current_version_id WHERE k.product_id=products.id),
          sale_price=(SELECT v.final_sale_price_minor/100.0 FROM published_kits k JOIN published_kit_versions v ON v.id=k.current_version_id WHERE k.product_id=products.id),
          price_locked=1,updated_at=CURRENT_TIMESTAMP
        WHERE id IN (SELECT product_id FROM published_kits WHERE current_version_id IS NOT NULL)`).run();
    },
  },
  {
    version: 79,
    name: "add_channel_gateway",
    up(db) {
      db.exec(CHANNEL_GATEWAY_SCHEMA_V79);
    },
  },
  {
    version: 80,
    name: "remediate_channel_gateway_execution",
    up(db) {
      db.exec(CHANNEL_GATEWAY_REMEDIATION_SCHEMA_V80);
    },
  },
  {
    version: 81,
    name: "correct_channel_gateway_package_finance_versioning",
    up(db) {
      db.exec(CHANNEL_GATEWAY_CORRECTNESS_SCHEMA_V81);
    },
  },
  {
    version: 82,
    name: "add_shipment_carrier_gateway",
    up(db) {
      db.exec(SHIPMENT_CARRIER_SCHEMA_V82);
    },
  },
  {
    version: 83,
    name: "geliver_verified_flow_remediation",
    up(db) {
      db.exec(GELIVER_REMEDIATION_SCHEMA_V83);
    },
  },
  {
    version: 84,
    name: "wire_shipment_channel_outbound_execution",
    up(db) {
      db.exec(CHANNEL_SHIPMENT_OUTBOUND_SCHEMA_V84);
    },
  },
  {
    version: 85,
    name: "add_canonical_print_state",
    up(db) {
      const activeLegacyPrints = ["print_jobs", "label_print_jobs"].reduce((count, table) => {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
        if (!exists) return count;
        const active = Number(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE upper(status) NOT IN ('PRINTED','FAILED','CANCELLED','COMPLETED')`).pluck().get());
        return count + active;
      }, 0);
      if (activeLegacyPrints > 0) {
        throw new Error("V2-14 migration requires legacy print queues to be drained or explicitly cancelled before canonical print state is installed.");
      }
      db.exec(PRINT_STATE_SCHEMA_V85);
    },
  },
  {
    version: 86,
    name: "dedupe_canonical_print_intents",
    up(db) {
      db.exec(PRINT_DEDUP_COLUMNS_SCHEMA_V86);
      const jobs = db.prepare(`SELECT id,purpose,subject_type,subject_id,subject_code,original_job_id,
        template_id,template_version,template_content_hash,template_snapshot_json,payload_snapshot_hash,
        provider,artifact_reference,artifact_sha256,artifact_media_type,status FROM printing_jobs ORDER BY created_at,id`).all() as any[];
      const seenOriginals = new Map<string, string>();
      const seenActiveReprints = new Map<string, string>();
      const activeStatuses = new Set(["QUEUED", "RENDERED", "SUBMITTED", "ACKNOWLEDGED", "DELIVERY_UNKNOWN"]);
      const update = db.prepare("UPDATE printing_jobs SET printable_snapshot_hash=?,reprint_dedupe_hash=? WHERE id=?");
      for (const job of jobs) {
        const printableSnapshotHash = canonicalPayloadHash({
          purpose: job.purpose,
          subjectType: job.subject_type,
          subjectId: job.subject_id,
          subjectCode: job.subject_code,
          template: job.template_id ? {
            id: job.template_id,
            version: job.template_version,
            contentHash: job.template_content_hash,
            snapshotHash: createHash("sha256").update(job.template_snapshot_json, "utf8").digest("hex"),
          } : null,
          payloadSnapshotHash: job.payload_snapshot_hash,
          providerArtifact: job.artifact_sha256 ? {
            provider: job.provider,
            reference: job.artifact_reference,
            sha256: job.artifact_sha256,
            mediaType: job.artifact_media_type,
          } : null,
        });
        if (!job.original_job_id) {
          const duplicate = seenOriginals.get(printableSnapshotHash);
          if (duplicate) throw new Error(`V2-14 print dedupe migration blocked: original jobs ${duplicate} and ${job.id} have the same immutable printable snapshot.`);
          seenOriginals.set(printableSnapshotHash, job.id);
          update.run(printableSnapshotHash, null, job.id);
          continue;
        }
        const reprint = db.prepare("SELECT reason,explanation FROM printing_reprints WHERE reprint_job_id=?").get(job.id) as any;
        if (!reprint) throw new Error(`V2-14 print dedupe migration blocked: reprint job ${job.id} has no immutable reprint history.`);
        const reprintDedupeHash = canonicalPayloadHash({ originalJobId: job.original_job_id, printableSnapshotHash,
          reason: reprint.reason, explanation: reprint.explanation || null });
        if (activeStatuses.has(job.status)) {
          const duplicate = seenActiveReprints.get(reprintDedupeHash);
          if (duplicate) throw new Error(`V2-14 print dedupe migration blocked: active reprints ${duplicate} and ${job.id} represent the same request.`);
          seenActiveReprints.set(reprintDedupeHash, job.id);
        }
        update.run(printableSnapshotHash, reprintDedupeHash, job.id);
      }
      db.exec(PRINT_DEDUP_GUARDS_SCHEMA_V86);
    },
  },
  {
    version: 87,
    name: "add_reconciliation_and_repair_control_plane",
    up(db) {
      db.exec(RECONCILIATION_SCHEMA_V87);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = 87;
export const SUPPORTED_UPGRADE_STARTS = [48, 53] as const;
const FROZEN_MIGRATION_SEQUENCE = [
  ...Array.from({ length: 40 }, (_, index) => index + 1),
  ...Array.from({ length: 21 }, (_, index) => index + 42),
] as const;
const fixtureDirectory = fileURLToPath(new URL("../db/fixtures/", import.meta.url));

export type MigrationManifestEntry = {
  version: number;
  name: string;
  checksum: string;
};

const checksumFor = (migration: Migration): string => createHash("sha256")
  .update(`${migration.version}\0${migration.name}\0${migration.up.toString()}${migration.version === 67 ? `\0${PROCUREMENT_SCHEMA_V67}` : ""}${migration.version === 68 ? `\0${PROCUREMENT_REMEDIATION_SCHEMA_V68}` : ""}${migration.version === 69 ? `\0${INVENTORY_SCHEMA_V69}` : ""}${migration.version === 71 ? `\0${WAREHOUSE_EXECUTION_SCHEMA_V71}` : ""}${migration.version === 74 ? `\0${SALES_FINANCIAL_SCHEMA_V74}` : ""}${migration.version === 75 ? `\0${RETURNS_SCHEMA_V75}` : ""}${migration.version === 76 ? `\0${WAREHOUSE_PACKAGE_ORIGIN_SCHEMA_V76}` : ""}${migration.version === 77 ? `\0${PUBLISHED_KIT_SCHEMA_V77}` : ""}${migration.version === 78 ? `\0${PROFILE_CUT_REMEDIATION_SCHEMA_V78}` : ""}${migration.version === 79 ? `\0${CHANNEL_GATEWAY_SCHEMA_V79}` : ""}${migration.version === 80 ? `\0${CHANNEL_GATEWAY_REMEDIATION_SCHEMA_V80}` : ""}${migration.version === 81 ? `\0${CHANNEL_GATEWAY_CORRECTNESS_SCHEMA_V81}` : ""}${migration.version === 82 ? `\0${SHIPMENT_CARRIER_SCHEMA_V82}` : ""}${migration.version === 83 ? `\0${GELIVER_REMEDIATION_SCHEMA_V83}` : ""}${migration.version === 84 ? `\0${CHANNEL_SHIPMENT_OUTBOUND_SCHEMA_V84}` : ""}${migration.version === 85 ? `\0${PRINT_STATE_SCHEMA_V85}` : ""}${migration.version === 86 ? `\0${PRINT_DEDUP_COLUMNS_SCHEMA_V86}\0${PRINT_DEDUP_GUARDS_SCHEMA_V86}` : ""}${migration.version === 87 ? `\0${RECONCILIATION_SCHEMA_V87}` : ""}`)
  .digest("hex");

export function getMigrationManifest(): MigrationManifestEntry[] {
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    checksum: checksumFor(migration),
  }));
}

export function validateMigrationManifest(manifest: MigrationManifestEntry[]): void {
  const versions = new Set<number>();
  let previous = 0;
  for (const entry of manifest) {
    if (!Number.isInteger(entry.version) || entry.version <= 0) {
      throw new Error(`Invalid migration version: ${entry.version}`);
    }
    if (versions.has(entry.version)) throw new Error(`Duplicate migration version: ${entry.version}`);
    if (entry.version <= previous) throw new Error(`Migration order is not strictly increasing at v${entry.version}`);
    versions.add(entry.version);
    previous = entry.version;
  }
  if (manifest.at(-1)?.version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Migration manifest ends at v${manifest.at(-1)?.version ?? "none"}, expected v${CURRENT_SCHEMA_VERSION}`);
  }
  for (const [index, frozenVersion] of FROZEN_MIGRATION_SEQUENCE.entries()) {
    if (manifest[index]?.version !== frozenVersion) {
      throw new Error(`Frozen migration sequence mismatch at position ${index + 1}: expected v${frozenVersion}, found v${manifest[index]?.version ?? "none"}`);
    }
  }
}

function validateMigrationDefinitions(): MigrationManifestEntry[] {
  const manifest = getMigrationManifest();
  validateMigrationManifest(manifest);
  return manifest;
}

function ensureMigrationTable(db: Database.Database, allowUntrackedSchemaBootstrap: boolean): boolean {
  const migrationTableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get());
  const existingSchemaObjects = Number(db.prepare(`
    SELECT COUNT(*) FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
  `).pluck().get());
  if (!migrationTableExists && existingSchemaObjects > 0 && !allowUntrackedSchemaBootstrap) {
    throw new Error("Migration history is missing from an existing Panel schema");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      checksum   TEXT,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const columns = new Set(
    (db.prepare("PRAGMA table_info(schema_migrations)").all() as { name: string }[]).map((column) => column.name),
  );
  const historyRows = Number(db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get());
  if (historyRows === 0 && existingSchemaObjects > 0 && !allowUntrackedSchemaBootstrap) {
    throw new Error("Migration history is missing from an existing Panel schema");
  }
  return columns.has("checksum");
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

const V63_COMMAND_SCHEMA_OBJECTS = [
  { type: "table", name: "command_operations" },
  { type: "table", name: "command_audit_log" },
  { type: "table", name: "command_outbox" },
  { type: "index", name: "idx_command_operations_lookup" },
  { type: "index", name: "idx_command_audit_operation" },
  { type: "index", name: "idx_command_outbox_dispatch" },
  { type: "trigger", name: "trg_command_operations_immutable_update" },
  { type: "trigger", name: "trg_command_operations_immutable_delete" },
  { type: "trigger", name: "trg_command_audit_immutable_update" },
  { type: "trigger", name: "trg_command_audit_immutable_delete" },
  { type: "trigger", name: "trg_command_outbox_payload_immutable" },
  { type: "trigger", name: "trg_command_outbox_no_delete" },
] as const;

const V64_CATALOG_SCHEMA_OBJECTS = [
  { type: "table", name: "uom_definitions" },
  { type: "table", name: "uom_conversions" },
  { type: "table", name: "product_profile_attributes" },
  { type: "table", name: "catalog_product_versions" },
  { type: "index", name: "idx_catalog_product_versions_product" },
  { type: "index", name: "idx_products_catalog_contract" },
  { type: "trigger", name: "trg_catalog_product_versions_immutable_update" },
  { type: "trigger", name: "trg_catalog_product_versions_immutable_delete" },
  { type: "trigger", name: "trg_uom_definitions_immutable_update" },
  { type: "trigger", name: "trg_uom_definitions_immutable_delete" },
  { type: "trigger", name: "trg_uom_conversions_immutable_update" },
  { type: "trigger", name: "trg_uom_conversions_immutable_delete" },
] as const;

const V66_CATALOG_SCHEMA_OBJECTS = [
  { type: "trigger", name: "trg_products_base_uom_valid_insert" },
  { type: "trigger", name: "trg_products_base_uom_valid_update" },
] as const;

const V67_PROCUREMENT_TABLES = new Set([
  "fx_rate_observations", "fx_current_rates", "procurement_suppliers", "purchase_orders",
  "purchase_order_lines", "purchase_attachments", "purchase_cost_components",
  "purchase_cost_allocations", "acquisition_lot_cost_snapshots", "purchase_payments",
  "procurement_cash_postings",
]);

const V69_INVENTORY_TABLES = new Set([
  "inventory_lots", "inventory_ledger_events", "inventory_lot_location_balances",
  "inventory_reservations", "inventory_reservation_lines", "inventory_reservation_allocations",
]);

const V71_WAREHOUSE_TABLES = new Set([
  "warehouse_topologies", "warehouse_rack_configs", "warehouse_level_configs",
  "warehouse_position_configs", "warehouse_location_slots", "warehouse_execution_settings",
  "warehouse_excess_approvals", "warehouse_goods_receipts", "warehouse_execution_packages",
  "warehouse_package_movements_v2", "warehouse_replenishment_tasks",
  "warehouse_stock_discrepancies_v2", "warehouse_stock_counts_v2",
]);

type SchemaDefinition = { type: string; name: string; sql: string };

const canonicalSchemaDefinition = (sql: string): string => sql
  .trim()
  .split(/('(?:''|[^'])*')/g)
  .map((segment, index) => index % 2 === 1
    ? segment
    : segment.replace(/\s+/g, " ").replace(/\s*([(),;])\s*/g, "$1"))
  .join("");

function assertV63CommandSchemaDefinitions(actual: Database.Database): void {
  const reference = new Database(":memory:");
  try {
    const migration = migrations.find(({ version }) => version === 63);
    if (!migration) throw new Error("Migration v63 definition is unavailable");
    migration.up(reference);

    for (const object of V63_COMMAND_SCHEMA_OBJECTS) {
      const expected = reference.prepare(`
        SELECT type, name, sql FROM sqlite_master
        WHERE type = ? AND name = ? AND sql IS NOT NULL
      `).get(object.type, object.name) as SchemaDefinition | undefined;
      const found = actual.prepare(`
        SELECT type, name, sql FROM sqlite_master
        WHERE type = ? AND name = ? AND sql IS NOT NULL
      `).get(object.type, object.name) as SchemaDefinition | undefined;
      if (!expected || !found
        || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(expected.sql)) {
        throw new Error(`Migration v63 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV64CatalogSchemaDefinitions(actual: Database.Database, maxVersion = 64): void {
  const reference = new Database(":memory:");
  try {
    const hasV65Shape = (actual.prepare("PRAGMA table_info(product_profile_attributes)").all() as Array<{ name: string }>)
      .some(({ name }) => name === "wall_thickness_micrometers");
    const effectiveMaxVersion = hasV65Shape ? Math.max(maxVersion, 65) : maxVersion;
    reference.exec(fs.readFileSync(path.join(fixtureDirectory, "panel-v53.sql"), "utf8"));
    for (const migration of migrations) {
      if (migration.version <= 53 || migration.version > effectiveMaxVersion) continue;
      reference.transaction(() => migration.up(reference))();
    }
    for (const object of V64_CATALOG_SCHEMA_OBJECTS) {
      const expected = reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!expected || !found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(expected.sql)) {
        throw new Error(`Migration v64 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV66CatalogSchemaDefinitions(actual: Database.Database): void {
  const reference = new Database(":memory:");
  try {
    reference.exec(fs.readFileSync(path.join(fixtureDirectory, "panel-v53.sql"), "utf8"));
    for (const migration of migrations) {
      if (migration.version <= 53 || migration.version > 66) continue;
      reference.transaction(() => migration.up(reference))();
    }
    for (const object of V66_CATALOG_SCHEMA_OBJECTS) {
      const expected = reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!expected || !found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(expected.sql)) {
        throw new Error(`Migration v66 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV67ProcurementSchemaDefinitions(actual: Database.Database): void {
  const reference = new Database(":memory:");
  try {
    reference.exec(PROCUREMENT_SCHEMA_V67);
    const expected = (reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<SchemaDefinition & { tbl_name: string }>)
      .filter((object) => V67_PROCUREMENT_TABLES.has(object.tbl_name));
    for (const object of expected) {
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(object.sql)) {
        throw new Error(`Migration v67 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV68ProcurementSchemaDefinitions(actual: Database.Database): void {
  const reference = new Database(":memory:");
  try {
    reference.exec(`CREATE TABLE cash_transactions (
      id TEXT PRIMARY KEY, account_id TEXT, type TEXT, amount REAL, currency TEXT,
      exchange_rate_at_transaction REAL, source_type TEXT, source_id TEXT,
      description TEXT, transaction_date DATETIME, is_deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );`);
    reference.exec(PROCUREMENT_SCHEMA_V67);
    reference.exec(PROCUREMENT_REMEDIATION_SCHEMA_V68);
    const cashObjects = new Set([
      "idx_cash_transactions_procurement_payment",
      "trg_procurement_cash_projection_immutable_update",
      "trg_procurement_cash_projection_immutable_delete",
    ]);
    const expected = (reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<SchemaDefinition & { tbl_name: string }>)
      .filter((object) => V67_PROCUREMENT_TABLES.has(object.tbl_name) || cashObjects.has(object.name));
    for (const object of expected) {
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(object.sql)) {
        throw new Error(`Migration v68 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV69InventorySchemaDefinitions(actual: Database.Database, maxVersion = CURRENT_SCHEMA_VERSION): void {
  const reference = new Database(":memory:");
  try {
    reference.exec("CREATE TABLE products (id TEXT PRIMARY KEY, central_stock INTEGER); CREATE TABLE acquisition_lot_cost_snapshots (id TEXT PRIMARY KEY);");
    reference.exec(INVENTORY_SCHEMA_V69);
    const expected = (reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<SchemaDefinition & { tbl_name: string }>)
      .filter((object) => V69_INVENTORY_TABLES.has(object.tbl_name)
        || object.name === "trg_inventory_central_stock_projection_guard"
        || object.name === "trg_inventory_central_stock_insert_guard");
    for (const object of expected) {
      // V2-10 v75 deliberately widens the immutable inventory event enum with
      // RETURN and recreates only this table's indexes/triggers. All other v69
      // definitions remain byte-for-byte pinned here.
      if (maxVersion >= 75 && (
        object.tbl_name === "inventory_ledger_events"
        || object.name === "idx_inventory_ledger_product"
        || object.name === "idx_inventory_ledger_lot"
        || object.name === "trg_inventory_ledger_immutable_update"
        || object.name === "trg_inventory_ledger_immutable_delete"
      )) continue;
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(object.sql)) {
        throw new Error(`Migration v69 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertV70LegacyInventoryRepresented(db: Database.Database): void {
  const unrepresented = db.prepare(`
    SELECT p.id
    FROM products p
    WHERE COALESCE(p.central_stock, 0) <> 0
      AND NOT EXISTS (
        SELECT 1 FROM inventory_ledger_events e WHERE e.product_id = p.id
      )
    ORDER BY p.id
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (unrepresented) {
    throw new Error(
      `INVENTORY_MIGRATION_REQUIRED: product ${unrepresented.id} has nonzero legacy central_stock without authoritative inventory ledger representation`,
    );
  }
}

function assertV71WarehouseSchemaDefinitions(actual: Database.Database, maxVersion = 71): void {
  const reference = new Database(":memory:");
  try {
    reference.exec(`
      CREATE TABLE products (id TEXT PRIMARY KEY);
      CREATE TABLE acquisition_lot_cost_snapshots (id TEXT PRIMARY KEY);
      CREATE TABLE inventory_lots (id TEXT PRIMARY KEY);
    `);
    reference.exec(WAREHOUSE_EXECUTION_SCHEMA_V71);
    if (maxVersion >= 73) reference.exec(WAREHOUSE_REPLENISHMENT_RUNTIME_SCHEMA_V73);
    const expected = (reference.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<SchemaDefinition & { tbl_name: string }>)
      .filter((object) => V71_WAREHOUSE_TABLES.has(object.tbl_name));
    for (const object of expected) {
      // V2-10 v76 generalizes only the package origin while preserving the
      // accepted V2-08 topology, receipt, movement and replenishment model.
      if (maxVersion >= 76 && (object.tbl_name === "warehouse_execution_packages" || object.name === "idx_warehouse_packages_product_lot")) continue;
      const found = actual.prepare("SELECT type,name,sql FROM sqlite_master WHERE type=? AND name=? AND sql IS NOT NULL")
        .get(object.type, object.name) as SchemaDefinition | undefined;
      if (!found || canonicalSchemaDefinition(found.sql) !== canonicalSchemaDefinition(object.sql)) {
        throw new Error(`Migration v71 schema effect is missing or incompatible: ${object.type} ${object.name}`);
      }
    }
  } finally {
    reference.close();
  }
}

function assertSchemaEffects(actual: Database.Database, maxVersion: number): void {
  if (maxVersion < SUPPORTED_UPGRADE_STARTS[0]) {
    throw new Error(`Migration checksum history at v${maxVersion} is not a supported verifiable checkpoint`);
  }
  const baseVersion = maxVersion >= SUPPORTED_UPGRADE_STARTS[1] ? SUPPORTED_UPGRADE_STARTS[1] : SUPPORTED_UPGRADE_STARTS[0];
  const reference = new Database(":memory:");
  try {
    reference.exec(fs.readFileSync(path.join(fixtureDirectory, `panel-v${baseVersion}.sql`), "utf8"));
    for (const migration of migrations) {
      if (migration.version <= baseVersion || migration.version > maxVersion) continue;
      reference.transaction(() => migration.up(reference))();
    }
    const expectedObjects = reference.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND sql IS NOT NULL
      ORDER BY type, name
    `).all() as Array<{ type: string; name: string }>;
    for (const object of expectedObjects) {
      const exists = actual.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? AND sql IS NOT NULL")
        .get(object.type, object.name);
      if (!exists) throw new Error(`Migration schema effect is missing: ${object.type} ${object.name}`);
      if (object.type === "table") {
        const expectedColumns = reference.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all() as ColumnInfo[];
        const actualColumns = actual.prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`).all() as ColumnInfo[];
        for (const expectedColumn of expectedColumns) {
          const actualColumn = actualColumns.find((column) => column.name === expectedColumn.name);
          const preV61ProductTypeDefault = maxVersion < 61 && object.name === "products" && expectedColumn.name === "product_type"
            && actualColumn && actualColumn.type === expectedColumn.type && actualColumn.notnull === expectedColumn.notnull
            && actualColumn.pk === expectedColumn.pk
            && ["'finished'", "'simple'"].includes(String(actualColumn.dflt_value));
          if (!actualColumn || actualColumn.type !== expectedColumn.type || actualColumn.notnull !== expectedColumn.notnull
            || (!preV61ProductTypeDefault && actualColumn.dflt_value !== expectedColumn.dflt_value)
            || actualColumn.pk !== expectedColumn.pk) {
            throw new Error(`Migration schema effect is missing or incompatible: ${object.name}.${expectedColumn.name}`);
          }
        }
      }
      if (object.type === "index") {
        const expectedIndex = (reference.prepare(`PRAGMA index_info(${quoteIdentifier(object.name)})`).all() as Array<{ seqno: number; name: string }>)
          .map(({ seqno, name }) => ({ seqno, name }));
        const actualIndex = (actual.prepare(`PRAGMA index_info(${quoteIdentifier(object.name)})`).all() as Array<{ seqno: number; name: string }>)
          .map(({ seqno, name }) => ({ seqno, name }));
        if (JSON.stringify(actualIndex) !== JSON.stringify(expectedIndex)) {
          throw new Error(`Migration schema effect is incompatible: index ${object.name}`);
        }
      }
    }
  } finally {
    reference.close();
  }
}

function validateAppliedMigrations(db: Database.Database, manifest: MigrationManifestEntry[], hasChecksumColumn: boolean): Set<number> {
  const rows = db.prepare(`SELECT version, name, ${hasChecksumColumn ? "checksum" : "NULL AS checksum"} FROM schema_migrations ORDER BY version`).all() as Array<{
    version: number;
    name: string;
    checksum: string | null;
  }>;
  const applied = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const entry = manifest[index];
    if (!entry) throw new Error(`Database contains unsupported migration version v${row.version}`);
    if (row.version !== entry.version) {
      throw new Error(`Migration history is not an exact prefix: expected v${entry.version}, found v${row.version}`);
    }
    if (row.name !== entry.name) {
      throw new Error(`Migration v${row.version} name mismatch: database=${row.name}, source=${entry.name}`);
    }
    if (hasChecksumColumn && row.checksum === null) {
      throw new Error(`Migration v${row.version} has a NULL checksum in a checksum-aware history`);
    }
    if (row.checksum && row.checksum !== entry.checksum) {
      throw new Error(`Migration v${row.version} checksum mismatch`);
    }
    applied.add(row.version);
  }
  if (rows.length > 0) {
    const maxVersion = rows.at(-1)!.version;
    assertSchemaEffects(db, maxVersion);
    if (maxVersion >= 63) assertV63CommandSchemaDefinitions(db);
    if (maxVersion >= 64) assertV64CatalogSchemaDefinitions(db, maxVersion);
    if (maxVersion >= 66) assertV66CatalogSchemaDefinitions(db);
    if (maxVersion === 67) assertV67ProcurementSchemaDefinitions(db);
    if (maxVersion >= 68) assertV68ProcurementSchemaDefinitions(db);
    if (maxVersion >= 69) assertV69InventorySchemaDefinitions(db, maxVersion);
    if (maxVersion >= 70) assertV70LegacyInventoryRepresented(db);
    if (maxVersion >= 71) assertV71WarehouseSchemaDefinitions(db, maxVersion);
  }
  if (!hasChecksumColumn) {
    db.transaction(() => {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
      const backfillChecksum = db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ? AND checksum IS NULL");
      for (const row of rows) {
        backfillChecksum.run(manifest.find(({ version }) => version === row.version)!.checksum, row.version);
      }
    })();
  }
  return applied;
}

export type MigrationRunOptions = {
  allowUntrackedSchemaBootstrap?: boolean;
};

export function runMigrations(
  db: Database.Database,
  targetVersion = CURRENT_SCHEMA_VERSION,
  options: MigrationRunOptions = {},
): void {
  const manifest = validateMigrationDefinitions();
  if (!manifest.some(({ version }) => version === targetVersion)) {
    throw new Error(`Unsupported migration target v${targetVersion}`);
  }
  const hasChecksumColumn = ensureMigrationTable(db, options.allowUntrackedSchemaBootstrap === true);
  const applied = validateAppliedMigrations(db, manifest, hasChecksumColumn);

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
  );

  let applied_count = 0;

  for (const migration of migrations) {
    if (migration.version > targetVersion) continue;
    if (applied.has(migration.version)) continue;

    const apply = () => db.transaction(() => {
      migration.up(db);
      if (migration.requiresForeignKeysOff) {
        const violation = db.prepare("PRAGMA foreign_key_check").get();
        if (violation) throw new Error(`Migration v${migration.version} produced a foreign-key violation`);
      }
      if (migration.version === 63) assertV63CommandSchemaDefinitions(db);
      if (migration.version === 64) assertV64CatalogSchemaDefinitions(db);
      if (migration.version === 66) assertV66CatalogSchemaDefinitions(db);
      if (migration.version === 67) assertV67ProcurementSchemaDefinitions(db);
      if (migration.version === 68) assertV68ProcurementSchemaDefinitions(db);
      if (migration.version === 69) assertV69InventorySchemaDefinitions(db);
      if (migration.version === 70) assertV70LegacyInventoryRepresented(db);
      if (migration.version === 71) assertV71WarehouseSchemaDefinitions(db);
      insertMigration.run(migration.version, migration.name, checksumFor(migration));
    })();

    if (migration.requiresForeignKeysOff) {
      const foreignKeysEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
      if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
      try { apply(); } finally { if (foreignKeysEnabled) db.pragma("foreign_keys = ON"); }
    } else {
      apply();
    }

    console.log(`[Migration] Applied v${migration.version}: ${migration.name}`);
    applied_count++;
  }

  if (applied_count > 0) {
    console.log(`[Migration] ${applied_count} migration(s) applied.`);
  }
}

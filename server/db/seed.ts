import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_WIDGETS = [
  { key: "dashboard_month_revenue",          title: "Bu Ay Toplam Ciro",         description: "Aktif satışlardan bu ay oluşan net ciro.",                         type: "kpi", module: "overview", size: "small",  grid: { x: 0, y: 0, w: 4, h: 3 } },
  { key: "dashboard_total_expenses",         title: "Toplam Giderler",           description: "Bu ay gerçekleşen giderler ve bekleyen periyodik ödemeler.",       type: "kpi", module: "overview", size: "small",  grid: { x: 4, y: 0, w: 4, h: 3 } },
  { key: "dashboard_est_net_profit",         title: "Tahmini Net Kar",           description: "Bu ay toplam ciro eksi toplam gider tahmini.",                    type: "kpi", module: "overview", size: "small",  grid: { x: 8, y: 0, w: 4, h: 3 } },
  { key: "dashboard_low_stock",              title: "Kritik Stok",               description: "Merkez depo stoğu kritik seviyede olan ürün sayısı.",             type: "kpi", module: "overview", size: "small",  grid: { x: 0, y: 3, w: 4, h: 3 } },
  { key: "dashboard_stock_sales_value",      title: "Toplam Stok Satış Değeri",  description: "Merkez depo stoklarının satış fiyatı üzerinden potansiyel değeri.", type: "kpi", module: "overview", size: "small",  grid: { x: 4, y: 3, w: 4, h: 3 } },
  { key: "dashboard_stock_cost_value",       title: "Toplam Stok Maliyeti",      description: "Merkez depo stoklarının alış maliyeti toplamı.",                  type: "kpi", module: "overview", size: "small",  grid: { x: 8, y: 3, w: 4, h: 3 } },
  { key: "dashboard_stock_est_gross_profit", title: "Tahmini Brüt Kâr",          description: "Mevcut stoktan beklenen potansiyel brüt kâr.",                    type: "kpi", module: "overview", size: "small",  grid: { x: 0, y: 6, w: 4, h: 3 } },
  { key: "dashboard_avg_profit_margin",      title: "Ortalama Kâr Marjı",        description: "Mevcut stokların satış değerine göre ortalama kâr marjı.",        type: "kpi", module: "overview", size: "small",  grid: { x: 4, y: 6, w: 4, h: 3 } },
  { key: "payment_month_pending_count",  title: "Bu Ay Bekleyen İşlem",    type: "kpi",  module: "payments",  size: "small"  },
  { key: "payment_month_pending_amount", title: "Bu Ay Bekleyen Tutar",    type: "kpi",  module: "payments",  size: "small"  },
  { key: "payment_overdue_count",        title: "Geciken Ödeme",           type: "kpi",  module: "payments",  size: "small"  },
  { key: "product_total_sold",           title: "Toplam Satılan Adet",     type: "kpi",  module: "products",  size: "small"  },
  { key: "product_total_revenue",        title: "Toplam Satış Geliri",     type: "kpi",  module: "products",  size: "small"  },
  { key: "product_top_material",         title: "En Çok Satan Materyal",   type: "kpi",  module: "products",  size: "small"  },
  { key: "product_material_pie",         title: "Materyal Satış Dağılımı", type: "pie",  module: "products",  size: "medium" },
  { key: "sales_revenue_trend",          title: "Satış Trend Grafiği",     type: "line", module: "products",  size: "large"  },
  { key: "product_reorder_summary",      title: "Akıllı Sipariş Önerisi",  type: "kpi",  module: "products",  size: "medium" },
  { key: "payment_upcoming_list",        title: "Yaklaşan Ödemeler",       type: "list", module: "payments",  size: "medium" },
];

/**
 * applySeed — inserts default rows only when the table is empty.
 * Safe to call on every startup; all inserts use INSERT OR IGNORE / count checks.
 */
export function applySeed(db: Database.Database): void {
  // Default admin user.
  // must_change_password=1 forces a password change on first login.
  const { count: userCount } = db.prepare("SELECT COUNT(*) as count FROM users").get() as any;
  if (userCount === 0) {
    const hash = bcrypt.hashSync("admin", 10);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, must_change_password)
      VALUES (?, 'admin', ?, 'admin', 1)
    `).run(uuidv4(), hash);
  }

  // Default dashboard widgets (only if table is empty).
  const { count: widgetCount } = db.prepare("SELECT COUNT(*) as count FROM dashboard_widgets").get() as any;
  if (widgetCount === 0) {
    const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin' ORDER BY created_at ASC LIMIT 1").get() as any;
    const dashboardOwnerId = adminUser?.id || "admin";
    const insertWidget = db.prepare(`
      INSERT INTO dashboard_widgets
        (id, user_id, widget_key, title, description, widget_type, source_module, size, position, is_visible, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);
    DEFAULT_WIDGETS.forEach((w, i) => {
      insertWidget.run(
        uuidv4(),
        dashboardOwnerId,
        w.key,
        w.title,
        "description" in w ? w.description : "",
        w.type,
        w.module,
        w.size,
        i,
        "grid" in w ? JSON.stringify({ grid: w.grid }) : "{}",
      );
    });
  }

  // Default cash accounts.
  const { count: accountCount } = db.prepare("SELECT COUNT(*) as count FROM cash_accounts").get() as any;
  if (accountCount === 0) {
    const insertAccount = db.prepare(
      "INSERT INTO cash_accounts (id, name, currency, type) VALUES (?, ?, ?, ?)"
    );
    insertAccount.run(uuidv4(), "Nakit TL",             "TRY", "cash");
    insertAccount.run(uuidv4(), "Banka TL",             "TRY", "bank");
    insertAccount.run(uuidv4(), "USD Kasa",             "USD", "cash");
    insertAccount.run(uuidv4(), "Trendyol Bekleyen",    "TRY", "platform");
    insertAccount.run(uuidv4(), "Hepsiburada Bekleyen", "TRY", "platform");
    insertAccount.run(uuidv4(), "Amazon Bekleyen",      "TRY", "platform");
  }

  // Default settings (INSERT OR IGNORE — never overwrites user-changed values).
  const s = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  s.run("company_name",              "DSDST Panel");
  s.run("low_stock_threshold",       "50");
  s.run("currency_symbol",           "₺");
  s.run("language",                  "tr");
  s.run("usd_exchange_rate",         "32.5");
  s.run("default_buffer_percentage", "20");
  s.run("default_profit_percentage", "30");
  s.run("api_key",                   uuidv4());
  s.run("sales_channels", JSON.stringify(["Satış Sistemi", "Website", "Trendyol", "Hepsiburada", "Amazon", "N11"]));
  s.run("commission_rates", JSON.stringify({
    "Satış Sistemi": 0, Website: 0, Trendyol: 15, Hepsiburada: 15, Amazon: 10, N11: 15,
  }));
  s.run("product_categories",  JSON.stringify(["Aliminyum", "PPR", "Dokum Demir", "Karbon Celik"]));
  s.run("income_categories",   JSON.stringify(["Satış", "İade", "Hizmet Bedeli", "Diğer"]));
  s.run("expense_categories",  JSON.stringify(["Kargo", "Komisyon", "Maliyet", "Reklam", "Vergi", "Diğer"]));
}

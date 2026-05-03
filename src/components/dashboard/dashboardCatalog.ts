export type DashboardWidgetSize = 'small' | 'medium' | 'large' | 'full';

export interface DashboardWidgetDefinition {
  key: string;
  title: string;
  description: string;
  type: string;
  module: 'overview' | 'payments' | 'products' | 'finance';
  size: DashboardWidgetSize;
}

export const DASHBOARD_WIDGET_CATALOG: DashboardWidgetDefinition[] = [
  { key: 'dashboard_month_revenue', title: 'Bu Ay Toplam Ciro', description: 'Aktif satışlardan bu ay oluşan net ciro.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_total_expenses', title: 'Toplam Giderler', description: 'Bu ay gerçekleşen giderler ve bekleyen periyodik ödemeler.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_est_net_profit', title: 'Tahmini Net Kar', description: 'Bu ay toplam ciro eksi toplam gider tahmini.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_low_stock', title: 'Kritik Stok', description: 'Merkez depo stoğu kritik seviyede olan ürün sayısı.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_stock_sales_value', title: 'Toplam Stok Satış Değeri', description: 'Merkez depo stoklarının satış fiyatı üzerinden potansiyel değeri.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_stock_cost_value', title: 'Toplam Stok Maliyeti', description: 'Merkez depo stoklarının alış maliyeti toplamı.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_stock_est_gross_profit', title: 'Tahmini Brüt Kâr', description: 'Mevcut stoktan beklenen potansiyel brüt kâr.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_avg_profit_margin', title: 'Ortalama Kâr Marjı', description: 'Mevcut stokların satış değerine göre ortalama kâr marjı.', type: 'kpi', module: 'overview', size: 'small' },
  { key: 'dashboard_cash_total', title: 'Toplam Kasa Bakiyesi', description: 'Platform harici aktif kasa ve banka bakiyesi.', type: 'kpi', module: 'finance', size: 'small' },
  { key: 'dashboard_pending_platform', title: 'Bekleyen Platform Tahsilatı', description: 'Pazaryeri bekleyen hesaplarındaki toplam bakiye.', type: 'kpi', module: 'finance', size: 'small' },
  { key: 'dashboard_month_cash_in', title: 'Bu Ay Nakit Giriş', description: 'Satış kaynaklı bu ay nakit girişi.', type: 'kpi', module: 'finance', size: 'small' },
  { key: 'dashboard_month_cash_out', title: 'Bu Ay Nakit Çıkış', description: 'Gider kaynaklı bu ay nakit çıkışı.', type: 'kpi', module: 'finance', size: 'small' },
  { key: 'dashboard_monthly_profit_chart', title: 'Gelir / Gider / Kâr Trendi', description: 'Son altı ay gelir, gider ve kâr eğilimi.', type: 'line', module: 'overview', size: 'large' },
  { key: 'dashboard_platform_revenue_chart', title: 'Platform Ciro Dağılımı', description: 'Satış kanallarına göre ciro dağılımı.', type: 'bar', module: 'overview', size: 'medium' },

  { key: 'payment_month_pending_count', title: 'Bu Ay Bekleyen İşlem', description: 'Bu ay bekleyen periyodik ödeme adedi.', type: 'kpi', module: 'payments', size: 'small' },
  { key: 'payment_month_pending_amount', title: 'Bu Ay Bekleyen Tutar', description: 'Bu ay bekleyen periyodik ödeme tutarı.', type: 'kpi', module: 'payments', size: 'small' },
  { key: 'payment_auto_process_count', title: 'Otomatik İşlenecek', description: 'Otomatik işlenecek bekleyen ödeme adedi.', type: 'kpi', module: 'payments', size: 'small' },
  { key: 'payment_overdue_count', title: 'Geciken Ödeme', description: 'Vadesi geçmiş ödeme sayısı.', type: 'kpi', module: 'payments', size: 'small' },
  { key: 'payment_processed_count', title: 'İşlenen Ödeme', description: 'Bu ay işlenen ödeme sayısı.', type: 'kpi', module: 'payments', size: 'small' },
  { key: 'payment_upcoming_list', title: 'Yaklaşan Ödemeler', description: 'Önümüzdeki 30 gün içindeki ödemeler.', type: 'list', module: 'payments', size: 'medium' },
  { key: 'payment_status_share', title: 'Ödeme Durum Dağılımı', description: 'Ödemelerin durum bazlı dağılımı.', type: 'pie', module: 'payments', size: 'medium' },
  { key: 'payment_category_share', title: 'Ödeme Kategori Dağılımı', description: 'Ödemelerin kategori bazlı dağılımı.', type: 'pie', module: 'payments', size: 'medium' },
  { key: 'payment_monthly_amounts', title: 'Aylık Ödeme Tutarı', description: 'Aylık ödeme tutarları.', type: 'bar', module: 'payments', size: 'large' },

  { key: 'product_total_sold', title: 'Toplam Satılan Adet', description: 'Filtreye göre toplam satılan ürün adedi.', type: 'kpi', module: 'products', size: 'small' },
  { key: 'product_total_revenue', title: 'Toplam Satış Geliri', description: 'Filtreye göre ürün satış geliri.', type: 'kpi', module: 'products', size: 'small' },
  { key: 'product_top_material', title: 'En Çok Satan Materyal', description: 'En çok satış alan materyal.', type: 'kpi', module: 'products', size: 'small' },
  { key: 'product_top_model', title: 'En Çok Satan Model', description: 'En çok satış alan model.', type: 'kpi', module: 'products', size: 'small' },
  { key: 'product_material_pie', title: 'Materyal Satış Dağılımı', description: 'Materyal bazlı satış dağılımı.', type: 'pie', module: 'products', size: 'medium' },
  { key: 'product_model_pie', title: 'Model Satış Dağılımı', description: 'Model bazlı satış dağılımı.', type: 'pie', module: 'products', size: 'medium' },
  { key: 'sales_revenue_trend', title: 'Satış Trend Grafiği', description: 'Son 30 gün satış trendi.', type: 'line', module: 'products', size: 'large' },
  { key: 'product_reorder_summary', title: 'Akıllı Sipariş Önerisi', description: 'Kritik ürünler ve önerilen sipariş adedi.', type: 'kpi', module: 'products', size: 'medium' },
];

export const OVERVIEW_DEFAULT_WIDGET_KEYS = [
  'dashboard_month_revenue',
  'dashboard_total_expenses',
  'dashboard_est_net_profit',
  'dashboard_low_stock',
  'dashboard_stock_sales_value',
  'dashboard_stock_cost_value',
  'dashboard_stock_est_gross_profit',
  'dashboard_avg_profit_margin',
];

export function getDashboardWidgetDefinition(key: string) {
  return DASHBOARD_WIDGET_CATALOG.find((widget) => widget.key === key);
}

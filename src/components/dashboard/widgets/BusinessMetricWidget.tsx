import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  DollarSign,
  Landmark,
  Package,
  Percent,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { useCurrency } from '../../../CurrencyContext';

type Summary = {
  metrics?: Record<string, any>;
};

const pct = (value: number) => `%${Math.abs(value || 0).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
const periodSensitiveKeys = new Set([
  'dashboard_month_revenue',
  'dashboard_total_expenses',
  'dashboard_est_net_profit',
  'dashboard_month_cash_in',
  'dashboard_month_cash_out',
]);

function MetricIcon({ tone, icon: Icon }: { tone: string; icon: any }) {
  return (
    <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${tone}`}>
      <Icon className="w-5 h-5" />
    </div>
  );
}

export function BusinessMetricWidget({
  widgetKey,
  title,
  summary,
}: {
  widgetKey: string;
  title: string;
  summary: Summary | null;
}) {
  const { FormatAmount } = useCurrency();
  const metrics = summary?.metrics || {};
  const periodLabel = metrics.dashboardPeriodLabel || 'Seçili dönem';
  const estimatedNetProfit = Number(metrics.estimatedNetProfit ?? ((metrics.totalRevenue || 0) - (metrics.totalExpenses || 0)));
  const stockEstProfit = Number(metrics.stockEstProfit ?? ((metrics.totalStockSalesValue || 0) - (metrics.totalStockCostValue || 0)));
  const avgProfitMargin = Number(metrics.stockAvgProfitMargin ?? (
    metrics.totalStockSalesValue > 0 ? (stockEstProfit / metrics.totalStockSalesValue) * 100 : 0
  ));

  const map: Record<string, any> = {
    dashboard_month_revenue: {
      icon: TrendingUp,
      tone: 'bg-emerald-50 text-emerald-600',
      value: <FormatAmount amount={metrics.totalRevenue || 0} />,
      note: metrics.revenueChangePct
        ? `${metrics.revenueChangePct >= 0 ? '↑' : '↓'} ${pct(metrics.revenueChangePct)} Önceki döneme göre`
        : `${periodLabel} gerçekleşen ciro`,
      noteClass: metrics.revenueChangePct < 0 ? 'text-red-500' : 'text-emerald-600',
    },
    dashboard_total_expenses: {
      icon: TrendingDown,
      tone: 'bg-red-50 text-red-500',
      value: <FormatAmount amount={metrics.totalExpenses || 0} />,
      note: metrics.dashboardPeriodKey === 'all_time'
        ? 'Tüm zaman gerçekleşen ve bekleyen gider'
        : metrics.expensesChangePct
          ? `${metrics.expensesChangePct >= 0 ? '↑' : '↓'} ${pct(metrics.expensesChangePct)} Önceki döneme göre`
          : `${periodLabel} toplam gider`,
      noteClass: metrics.dashboardPeriodKey === 'all_time'
        ? 'text-slate-500'
        : metrics.expensesChangePct > 0 ? 'text-red-500' : 'text-emerald-600',
    },
    dashboard_est_net_profit: {
      icon: DollarSign,
      tone: 'bg-blue-50 text-blue-600',
      value: <FormatAmount amount={estimatedNetProfit} />,
      note: `${periodLabel} marj: %${Number(metrics.estimatedNetProfitMargin || 0).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`,
      noteClass: estimatedNetProfit >= 0 ? 'text-emerald-600' : 'text-red-500',
    },
    dashboard_low_stock: {
      icon: AlertTriangle,
      tone: 'bg-orange-50 text-red-500',
      value: <>{metrics.lowStockCount || 0} <span className="text-2xl">Ürün</span></>,
      valueClass: 'text-red-500',
      note: (metrics.lowStockCount || 0) > 0 ? 'Acil sipariş gerekli' : 'Kritik stok yok',
      noteClass: (metrics.lowStockCount || 0) > 0 ? 'text-slate-500' : 'text-emerald-600',
    },
    dashboard_stock_sales_value: {
      icon: Package,
      tone: 'bg-blue-50 text-blue-600',
      value: <FormatAmount amount={metrics.totalStockSalesValue || 0} />,
      note: 'Mevcut stokların potansiyel değeri',
      noteClass: 'text-emerald-600',
    },
    dashboard_stock_cost_value: {
      icon: Package,
      tone: 'bg-orange-50 text-orange-600',
      value: <FormatAmount amount={metrics.totalStockCostValue || 0} />,
      note: 'Alış maliyeti üzerinden stok değeri',
      noteClass: 'text-red-500',
    },
    dashboard_stock_est_gross_profit: {
      icon: ArrowUpRight,
      tone: 'bg-emerald-50 text-emerald-600',
      value: <FormatAmount amount={stockEstProfit} />,
      note: 'Satıştan beklenen potansiyel brüt kâr',
      noteClass: 'text-emerald-600',
    },
    dashboard_avg_profit_margin: {
      icon: Percent,
      tone: 'bg-blue-50 text-blue-600',
      value: <>%{avgProfitMargin.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</>,
      note: 'Stokların ortalama satış kâr marjı',
      noteClass: 'text-emerald-600',
    },
    dashboard_cash_total: {
      icon: Landmark,
      tone: 'bg-emerald-50 text-emerald-600',
      value: <FormatAmount amount={metrics.cashTotal || 0} />,
      note: 'Platform harici kasa ve banka bakiyesi',
      noteClass: 'text-slate-500',
    },
    dashboard_pending_platform: {
      icon: Banknote,
      tone: 'bg-amber-50 text-amber-600',
      value: <FormatAmount amount={metrics.pendingPlatform || 0} />,
      note: 'Pazaryeri bekleyen tahsilat',
      noteClass: 'text-amber-600',
    },
    dashboard_month_cash_in: {
      icon: ArrowUpRight,
      tone: 'bg-emerald-50 text-emerald-600',
      value: <FormatAmount amount={metrics.monthlyCashIn || 0} />,
      note: `${periodLabel} satış kaynaklı nakit girişi`,
      noteClass: 'text-emerald-600',
    },
    dashboard_month_cash_out: {
      icon: ArrowDownRight,
      tone: 'bg-red-50 text-red-500',
      value: <FormatAmount amount={metrics.monthlyCashOut || 0} />,
      note: `${periodLabel} gider kaynaklı nakit çıkışı`,
      noteClass: 'text-red-500',
    },
  };

  const item = map[widgetKey];
  if (!item) return <div className="text-sm text-slate-400">Widget bulunamadı.</div>;
  const displayTitle = periodSensitiveKeys.has(widgetKey)
    ? title.replace(/^Bu Ay\s+/i, `${periodLabel} `).replace(/^Toplam Giderler$/i, `${periodLabel} Toplam Giderler`).replace(/^Tahmini Net Kar$/i, `${periodLabel} Tahmini Net Kar`)
    : title;

  return (
    <div className="flex h-full min-w-0 flex-col justify-between overflow-hidden">
      <MetricIcon tone={item.tone} icon={item.icon} />
      <div className="mt-5 min-w-0">
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 break-words text-xs font-black uppercase tracking-wider text-slate-500 [overflow-wrap:anywhere]">
            {displayTitle}
          </div>
        </div>
        <div className={`max-w-full break-words text-[clamp(1.65rem,2.4vw,2.55rem)] font-black leading-none tracking-tight text-slate-900 [overflow-wrap:anywhere] ${item.valueClass || ''}`}>
          {item.value}
        </div>
        <div className={`mt-4 max-w-full break-words text-sm font-extrabold leading-snug [overflow-wrap:anywhere] ${item.noteClass}`}>
          {item.note}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useMemo, useCallback } from "react";
import { api } from "../lib/api";
import {
  TrendingUp, TrendingDown, AlertTriangle, ShoppingCart, Package, Activity,
  RefreshCw, Layers, Zap, DollarSign,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, Legend,
} from "recharts";

type Tab = "overview" | "reorder" | "dead" | "top" | "critical" | "components" | "breakdown";

const COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#84cc16"];
const PRIORITY_COLOR: Record<string, string> = {
  acil: "bg-red-500/15 text-red-300 ring-red-500/30",
  "yakında": "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  normal: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  gereksiz: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};

function fmt(n: any, opts: { decimals?: number; currency?: string } = {}) {
  const num = Number(n) || 0;
  const decimals = opts.decimals ?? 0;
  const formatted = num.toLocaleString("tr-TR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return opts.currency ? `${formatted} ${opts.currency}` : formatted;
}

function Card({ title, children, className = "" }: any) {
  return (
    <div className={`bg-slate-900/60 backdrop-blur ring-1 ring-slate-800 rounded-xl p-4 ${className}`}>
      {title && <div className="text-sm text-slate-400 mb-2">{title}</div>}
      {children}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, sub, color = "text-sky-300" }: any) {
  return (
    <div className="bg-slate-900/60 backdrop-blur ring-1 ring-slate-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400 uppercase tracking-wide">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className="text-2xl font-semibold text-slate-100">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function InsightsPage() {
  const [period, setPeriod] = useState(30);
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<any>(null);
  const [trend, setTrend] = useState<any>(null);
  const [reorder, setReorder] = useState<any>(null);
  const [dead, setDead] = useState<any>(null);
  const [top, setTop] = useState<any>(null);
  const [critical, setCritical] = useState<any>(null);
  const [components, setComponents] = useState<any>(null);
  const [blocking, setBlocking] = useState<any>(null);
  const [breakdown, setBreakdown] = useState<any>(null);
  const [breakdownDim, setBreakdownDim] = useState("material");
  const [breakdownMetric, setBreakdownMetric] = useState("revenue");
  const [loading, setLoading] = useState(false);
  const [leadTime, setLeadTime] = useState(45);
  const [safetyDays, setSafetyDays] = useState(30);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [o, t, r, d, top20, crit, cons, block, br] = await Promise.all([
        api.get(`/insights/overview?period=${period}`),
        api.get(`/insights/sales/trend?period=${period}`),
        api.get(`/insights/reorder?leadTime=${leadTime}&safetyDays=${safetyDays}&period=${Math.max(period, 60)}`),
        api.get(`/insights/sales/dead?period=${Math.max(period, 60)}`),
        api.get(`/insights/sales/top?period=${period}&limit=20`),
        api.get(`/insights/stock/critical?safetyDays=${safetyDays}&period=${period}`),
        api.get(`/insights/components/runway?period=${period}`),
        api.get(`/insights/components/blocking`),
        api.get(`/insights/breakdown?dimension=${breakdownDim}&metric=${breakdownMetric}&period=${period}`),
      ]);
      setOverview(o); setTrend(t); setReorder(r); setDead(d); setTop(top20);
      setCritical(crit); setComponents(cons); setBlocking(block); setBreakdown(br);
    } catch (err) {
      console.error("Insights fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [period, leadTime, safetyDays, breakdownDim, breakdownMetric]);

  useEffect(() => { refresh(); }, [refresh]);

  const trendChart = useMemo(() => {
    if (!trend?.items) return [];
    return trend.items.map((i: any) => ({ day: i.day.slice(5), revenue: Math.round(i.revenue), profit: Math.round(i.gross_profit), count: i.sale_count }));
  }, [trend]);

  const breakdownChart = useMemo(() => {
    if (!breakdown?.items) return [];
    return breakdown.items.slice(0, 12).map((i: any) => ({ name: i.bucket, value: Math.round(i.value), share: i.share }));
  }, [breakdown]);

  const tabBtn = (id: Tab, label: string, count?: number) => (
    <button
      key={id}
      onClick={() => setTab(id)}
      className={`px-3 py-1.5 text-sm rounded-lg transition ${tab === id ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/50" : "text-slate-400 hover:bg-slate-800/60"}`}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 text-xs opacity-60">({count})</span>}
    </button>
  );

  return (
    <div className="p-6 space-y-4 text-slate-100">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Stok & Sipariş Analizi</h1>
          <p className="text-sm text-slate-400">Satış, stok, sipariş önerisi ve component analizi tek panelde</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">Dönem</span>
          <select value={period} onChange={(e) => setPeriod(Number(e.target.value))} className="bg-slate-800 ring-1 ring-slate-700 rounded-lg px-3 py-1.5 text-sm">
            <option value={7}>Son 7 gün</option>
            <option value={30}>Son 30 gün</option>
            <option value={60}>Son 60 gün</option>
            <option value={90}>Son 90 gün</option>
            <option value={180}>Son 180 gün</option>
          </select>
          <button onClick={refresh} disabled={loading} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 ring-1 ring-slate-700 rounded-lg text-sm flex items-center gap-2 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} /> Yenile
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          icon={Package}
          label="Stok Değeri (USD)"
          value={fmt(overview?.stock?.purchase_value_usd, { decimals: 0 })}
          sub={`${overview?.product?.total_sellable ?? "—"} ürün`}
          color="text-emerald-300"
        />
        <KpiCard
          icon={DollarSign}
          label={`Ciro (${period}g)`}
          value={fmt(overview?.sales?.revenue_try, { decimals: 0, currency: "₺" })}
          sub={`${fmt(overview?.sales?.units_sold)} adet · marj ${(((overview?.sales?.margin) ?? 0) * 100).toFixed(1)}%`}
          color="text-sky-300"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Kritik Stok"
          value={fmt(overview?.product?.critical_stock)}
          sub="Min altı veya tükenmek üzere"
          color="text-amber-300"
        />
        <KpiCard
          icon={TrendingDown}
          label={`Satılmayan (${period}g)`}
          value={fmt(overview?.product?.dead_in_period)}
          sub={`En hızlı: ${overview?.sales?.fastest_seller?.sku ?? "—"}`}
          color="text-rose-300"
        />
      </div>

      {/* Sales trend */}
      <Card title="Satış Trendi">
        <div className="h-56">
          <ResponsiveContainer>
            <LineChart data={trendChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="day" stroke="#64748b" fontSize={11} />
              <YAxis stroke="#64748b" fontSize={11} />
              <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }} />
              <Legend />
              <Line type="monotone" dataKey="revenue" name="Ciro (₺)" stroke="#0ea5e9" dot={false} />
              <Line type="monotone" dataKey="profit" name="Brüt Kâr (₺)" stroke="#22c55e" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 bg-slate-900/40 rounded-xl p-1 ring-1 ring-slate-800">
        {tabBtn("overview", "Genel")}
        {tabBtn("reorder", "Sipariş Önerileri", reorder?.items?.filter((i: any) => i.priority === "acil" || i.priority === "yakında").length)}
        {tabBtn("dead", "Satılmayanlar", dead?.items?.length)}
        {tabBtn("top", "En Çok Satanlar")}
        {tabBtn("critical", "Stok Riski", critical?.items?.length)}
        {tabBtn("components", "Component Riski", blocking?.items?.length)}
        {tabBtn("breakdown", "Kırılım Analizi")}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title={`Sipariş Önerisi - Acil + Yakında`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase">
                  <tr><th className="text-left py-1">SKU</th><th className="text-left">Ürün</th><th className="text-right">Stok</th><th className="text-right">Gün</th><th className="text-right">Öneri</th><th>Öncelik</th></tr>
                </thead>
                <tbody>
                  {(reorder?.items ?? []).filter((i: any) => i.priority === "acil" || i.priority === "yakında").slice(0, 10).map((i: any) => (
                    <tr key={i.id} className="border-t border-slate-800">
                      <td className="py-1.5 font-mono text-xs text-slate-300">{i.sku}</td>
                      <td className="text-slate-300 text-xs truncate max-w-xs">{i.name}</td>
                      <td className="text-right">{fmt(i.stock)}</td>
                      <td className="text-right">{i.days_until_stockout ?? "∞"}</td>
                      <td className="text-right font-semibold text-sky-300">{fmt(i.recommended_qty)}</td>
                      <td><span className={`text-xs px-2 py-0.5 rounded ring-1 ${PRIORITY_COLOR[i.priority] ?? ""}`}>{i.priority}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="En Çok Satanlar">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase"><tr><th className="text-left py-1">SKU</th><th className="text-left">Materyal</th><th className="text-right">Adet</th><th className="text-right">Ciro</th></tr></thead>
                <tbody>
                  {(top?.items ?? []).slice(0, 10).map((i: any) => (
                    <tr key={i.id} className="border-t border-slate-800">
                      <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                      <td className="text-xs text-slate-300">{i.material}</td>
                      <td className="text-right">{fmt(i.qty)}</td>
                      <td className="text-right text-sky-300">{fmt(i.revenue, { decimals: 0, currency: "₺" })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === "reorder" && (
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <label className="text-xs text-slate-400">Lead Time</label>
            <input type="number" value={leadTime} onChange={(e) => setLeadTime(+e.target.value || 1)} className="w-20 bg-slate-800 ring-1 ring-slate-700 rounded px-2 py-1 text-sm" />
            <label className="text-xs text-slate-400">Güvenlik Stoğu (gün)</label>
            <input type="number" value={safetyDays} onChange={(e) => setSafetyDays(+e.target.value || 1)} className="w-20 bg-slate-800 ring-1 ring-slate-700 rounded px-2 py-1 text-sm" />
            <span className="text-xs text-slate-500">Toplam: {leadTime + safetyDays} günlük stok hedefi</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase">
                <tr>
                  <th className="text-left py-1">SKU</th>
                  <th className="text-left">Tedarikçi Kodu</th>
                  <th className="text-left">Ürün</th>
                  <th className="text-right">Stok</th>
                  <th className="text-right">Gün/Stok</th>
                  <th className="text-right">Günlük Satış</th>
                  <th className="text-right">Önerilen</th>
                  <th>Öncelik</th>
                </tr>
              </thead>
              <tbody>
                {(reorder?.items ?? []).map((i: any) => (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                    <td className="font-mono text-xs text-slate-500">{i.supplier_code ?? "—"}</td>
                    <td className="text-xs text-slate-300 truncate max-w-sm">{i.name}</td>
                    <td className="text-right">{fmt(i.stock)}</td>
                    <td className="text-right">{i.days_until_stockout ?? "∞"}</td>
                    <td className="text-right text-slate-400">{i.avg_daily?.toFixed(2)}</td>
                    <td className="text-right font-semibold text-sky-300">{fmt(i.recommended_qty)}</td>
                    <td><span className={`text-xs px-2 py-0.5 rounded ring-1 ${PRIORITY_COLOR[i.priority] ?? ""}`}>{i.priority}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "dead" && (
        <Card title={`${dead?.period_days ?? period}+ gündür satmayan ürünler — toplam ${dead?.items?.length ?? 0}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase">
                <tr><th className="text-left py-1">SKU</th><th className="text-left">Ürün</th><th className="text-right">Stok</th><th className="text-right">Bağlı Sermaye (USD)</th><th className="text-right">Son Satış</th></tr>
              </thead>
              <tbody>
                {(dead?.items ?? []).map((i: any) => (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                    <td className="text-xs text-slate-300 truncate max-w-md">{i.name}</td>
                    <td className="text-right">{fmt(i.stock)}</td>
                    <td className="text-right text-rose-300">${fmt(i.tied_capital_usd, { decimals: 0 })}</td>
                    <td className="text-right text-xs text-slate-500">{i.last_sale ? new Date(i.last_sale).toLocaleDateString("tr-TR") : "Hiç"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "top" && (
        <Card title="En Çok Satanlar">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase">
                <tr><th className="text-left py-1">SKU</th><th className="text-left">Ürün</th><th className="text-left">Materyal</th><th className="text-left">Form</th><th className="text-right">Adet</th><th className="text-right">Sipariş</th><th className="text-right">Günlük</th><th className="text-right">Ciro (₺)</th></tr>
              </thead>
              <tbody>
                {(top?.items ?? []).map((i: any) => (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                    <td className="text-xs text-slate-300 truncate max-w-md">{i.name}</td>
                    <td className="text-xs">{i.material}</td>
                    <td className="text-xs text-slate-400">{i.form_code}</td>
                    <td className="text-right">{fmt(i.qty)}</td>
                    <td className="text-right text-slate-400">{i.order_count}</td>
                    <td className="text-right text-slate-400">{i.avg_daily_sales?.toFixed(2)}</td>
                    <td className="text-right text-sky-300">{fmt(i.revenue, { decimals: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "critical" && (
        <Card title="Kritik Stok / Yakında Tükenecek">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase">
                <tr><th className="text-left py-1">SKU</th><th className="text-left">Ürün</th><th className="text-right">Stok</th><th className="text-right">Min</th><th className="text-right">Günlük Satış</th><th className="text-right">Gün/Stok</th></tr>
              </thead>
              <tbody>
                {(critical?.items ?? []).map((i: any) => (
                  <tr key={i.id} className="border-t border-slate-800">
                    <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                    <td className="text-xs text-slate-300 truncate max-w-md">{i.name}</td>
                    <td className="text-right">{fmt(i.stock)}</td>
                    <td className="text-right text-slate-500">{fmt(i.min_stock)}</td>
                    <td className="text-right text-slate-400">{i.avg_daily?.toFixed(2)}</td>
                    <td className="text-right text-amber-300">{i.days_until_stockout ?? "∞"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "components" && (
        <div className="grid lg:grid-cols-2 gap-3">
          <Card title="H Parça Kullanım Hızı (Runway)">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase">
                  <tr><th className="text-left py-1">SKU</th><th className="text-right">Stok</th><th className="text-right">Tüketim</th><th className="text-right">Günlük</th><th className="text-right">Kalan Gün</th></tr>
                </thead>
                <tbody>
                  {(components?.items ?? []).map((i: any) => (
                    <tr key={i.id} className="border-t border-slate-800">
                      <td className="py-1.5 font-mono text-xs">{i.sku}</td>
                      <td className="text-right">{fmt(i.central_stock)}</td>
                      <td className="text-right">{fmt(i.units_consumed)}</td>
                      <td className="text-right text-slate-400">{i.daily_consumption?.toFixed(2)}</td>
                      <td className={`text-right ${i.days_left !== null && i.days_left < 30 ? "text-rose-300" : i.days_left !== null && i.days_left < 60 ? "text-amber-300" : "text-emerald-300"}`}>{i.days_left ?? "∞"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Component Yetersizliği — Satılamayan Final Ürünler">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-400 text-xs uppercase">
                  <tr><th className="text-left py-1">Final Ürün</th><th className="text-right">Satılabilir</th><th className="text-left">Darboğaz</th></tr>
                </thead>
                <tbody>
                  {(blocking?.items ?? []).map((i: any) => {
                    const bottleneck = i.components?.reduce((min: any, c: any) => !min || c.possible < min.possible ? c : min, null);
                    return (
                      <tr key={i.final_id} className="border-t border-slate-800">
                        <td className="py-1.5 font-mono text-xs">{i.final_sku}</td>
                        <td className="text-right text-amber-300">{fmt(i.available)}</td>
                        <td className="text-xs text-slate-400">{bottleneck ? `${bottleneck.sku}: ${bottleneck.stock}/${bottleneck.qty_per_unit} = ${bottleneck.possible}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === "breakdown" && (
        <Card>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <label className="text-xs text-slate-400">Boyut</label>
            <select value={breakdownDim} onChange={(e) => setBreakdownDim(e.target.value)} className="bg-slate-800 ring-1 ring-slate-700 rounded px-2 py-1 text-sm">
              <option value="material">Materyal</option>
              <option value="series">Seri</option>
              <option value="tube_type">Boru Tipi</option>
              <option value="size">Ölçü</option>
              <option value="form">Form</option>
              <option value="supplier_code">Tedarikçi Kodu</option>
            </select>
            <label className="text-xs text-slate-400">Metrik</label>
            <select value={breakdownMetric} onChange={(e) => setBreakdownMetric(e.target.value)} className="bg-slate-800 ring-1 ring-slate-700 rounded px-2 py-1 text-sm">
              <option value="revenue">Ciro</option>
              <option value="qty">Adet</option>
              <option value="profit">Kâr</option>
            </select>
          </div>
          <div className="grid lg:grid-cols-2 gap-3">
            <div className="h-72">
              <ResponsiveContainer>
                <BarChart data={breakdownChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="name" stroke="#64748b" fontSize={11} angle={-30} textAnchor="end" height={70} />
                  <YAxis stroke="#64748b" fontSize={11} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }} />
                  <Bar dataKey="value" fill="#0ea5e9" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-72">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={breakdownChart} dataKey="value" nameKey="name" outerRadius={90} label={(e: any) => `${e.name} ${(e.share * 100).toFixed(0)}%`}>
                    {breakdownChart.map((_, idx) => <Cell key={idx} fill={COLORS[idx % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead className="text-slate-400 text-xs uppercase">
                <tr><th className="text-left py-1">Grup</th><th className="text-right">Ürün</th><th className="text-right">Değer</th><th className="text-right">Pay</th><th className="text-right">Stok Adet</th><th className="text-right">Stok Değer (USD)</th></tr>
              </thead>
              <tbody>
                {(breakdown?.items ?? []).map((i: any) => (
                  <tr key={i.bucket} className="border-t border-slate-800">
                    <td className="py-1.5 text-slate-300">{i.bucket}</td>
                    <td className="text-right text-slate-400">{fmt(i.product_count)}</td>
                    <td className="text-right text-sky-300">{fmt(i.value, { decimals: 0 })}</td>
                    <td className="text-right">{(i.share * 100).toFixed(1)}%</td>
                    <td className="text-right text-slate-400">{fmt(i.stock_units)}</td>
                    <td className="text-right text-emerald-300">${fmt(i.stock_value_usd, { decimals: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

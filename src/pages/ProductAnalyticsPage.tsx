import React, { useState, useEffect, useMemo } from "react";
import { api } from "../lib/api";
import {
  BarChart2,
  Package,
  Layers,
  Filter,
  AlertTriangle,
  ShoppingCart,
  Download,
  Search,
  TrendingUp,
  TrendingDown,
  PieChart as PieChartIcon,
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCcw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from "recharts";

type ViewTab =
  | "dashboard"
  | "cross"
  | "material"
  | "series"
  | "model"
  | "size"
  | "reorder"
  | "charts"
  | "slow";

export default function ProductAnalyticsPage() {
  const [activeTab, setActiveTab] = useState<ViewTab>("dashboard");
  const [isLoading, setIsLoading] = useState(false);

  // Filters
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [materialFilter, setMaterialFilter] = useState("Tümü");
  const [modelFilter, setModelFilter] = useState("Tümü");
  const [pipeSizeFilter, setPipeSizeFilter] = useState("Tümü");
  const [tubeTypeFilter, setTubeTypeFilter] = useState("Tümü");

  const [pipeSizeOptions, setPipeSizeOptions] = useState<string[]>([
    "Tümü",
    "Bilinmiyor",
  ]);

  // Data State
  const [summary, setSummary] = useState<any>({});
  const [cross, setCross] = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [reports, setReports] = useState<{
    material: any[];
    series: any[];
    model: any[];
    size: any[];
  }>({ material: [], series: [], model: [], size: [] });
  const [charts, setCharts] = useState<any>({
    materialShare: [],
    modelShare: [],
    pipeTypeShare: [],
    sizeShare: [],
    trend: [],
  });

  const fetchFilters = async () => {
    try {
      const res = await api.get("/analytics/products/filter-options");
      if (res.pipeSizes) setPipeSizeOptions(res.pipeSizes);
    } catch (e) {}
  };

  const fetchAnalytics = async () => {
    setIsLoading(true);
    try {
      const q = new URLSearchParams();
      if (startDate) q.append("startDate", startDate);
      if (endDate) q.append("endDate", endDate);
      if (materialFilter !== "Tümü") q.append("material", materialFilter);
      if (modelFilter !== "Tümü") q.append("model", modelFilter);
      if (pipeSizeFilter !== "Tümü") q.append("pipeSize", pipeSizeFilter);
      if (tubeTypeFilter !== "Tümü") q.append("tubeType", tubeTypeFilter);

      const qs = q.toString();

      const [sumRes, crsRes, sugRes, repRes, chartRes] = await Promise.all([
        api.get(`/analytics/products/summary?${qs}`),
        api.get(`/analytics/products/cross?${qs}`),
        api.get(`/analytics/products/reorder-suggestions?${qs}`),
        api.get(`/analytics/products/reports?${qs}`),
        api.get(`/analytics/products/charts?${qs}`),
      ]);

      setSummary(sumRes);
      setCross(crsRes);
      setReports(repRes);
      setCharts(chartRes);

      const loadedSuggestions = sugRes.map((s: any) => {
        const dailyAvg = s.soldQty / 30;
        let priority = "Talep Yok";
        let action = "İzle";
        if (s.soldQty > 0) {
          if (s.currentStock <= dailyAvg * 15) {
            priority = "Kritik";
            action = "Acil Sipariş";
          } else if (s.currentStock <= dailyAvg * 30) {
            priority = "Düşük Stok";
            action = "Sipariş Ver";
          } else if (s.currentStock > dailyAvg * 180) {
            priority = "Fazla Stok";
            action = "Kampanya / İndirim";
          } else {
            priority = "Normal";
            action = "İyi Durum";
          }
        } else if (s.currentStock > 0) {
          priority = "Ölü Stok";
          action = "Eritilmesi Gerek";
        }
        return { ...s, dailyAvg: dailyAvg.toFixed(2), priority, action };
      });
      setSuggestions(
        loadedSuggestions.sort((a: any, b: any) => b.soldQty - a.soldQty),
      );
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchFilters();
    fetchAnalytics();
  }, []);

  const downloadCSV = (data: any[], filename: string) => {
    if (!data || data.length === 0) return;
    const headers = Object.keys(data[0]).join(",");
    const rows = data
      .map((row) =>
        Object.values(row)
          .map((v) =>
            typeof v === "string" ? '"' + v.replace(/"/g, '""') + '"' : v,
          )
          .join(","),
      )
      .join("\n");
    const blob = new Blob(["\uFEFF" + headers + "\n" + rows], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.csv`;
    link.click();
  };

  const COLORS = [
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#ec4899",
    "#f97316",
    "#14b8a6",
    "#6366f1",
    "#64748b",
  ];

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-3 border border-gray-100 shadow-xl rounded-xl">
          <p className="font-bold text-gray-900 mb-2">
            {label || payload[0]?.name}
          </p>
          {payload.map((entry: any, index: number) => (
            <div
              key={index}
              className="flex items-center gap-2 text-sm text-gray-600"
            >
              <div
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              {entry.name}:{" "}
              <span className="font-black text-gray-900">
                {entry.value?.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  const slowMovers = useMemo(
    () =>
      suggestions
        .filter((s) => s.soldQty === 0 && s.currentStock > 0)
        .sort((a, b) => b.currentStock - a.currentStock),
    [suggestions],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-end gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-black text-gray-900 tracking-tight">
            Ürün & Satış Analizi
          </h1>
          <p className="text-sm text-gray-500 font-medium mt-1">
            Gelişmiş karar destek ve stok raporlama modülü
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchAnalytics}
            className="bg-white border flex items-center gap-2 border-gray-200 text-gray-700 px-4 py-2 rounded-xl text-sm font-bold shadow-sm hover:bg-gray-50"
          >
            <RefreshCcw className="w-4 h-4" /> Yenile
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex flex-wrap items-end gap-4 overflow-x-auto">
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
            Tarih Aralığı (Sadece Satışları Filtreler)
          </label>
          <div className="flex gap-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-[140px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 uppercase font-mono"
            />
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-[140px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 uppercase font-mono"
            />
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
            Materyal
          </label>
          <select
            value={materialFilter}
            onChange={(e) => setMaterialFilter(e.target.value)}
            className="w-[130px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 font-medium"
          >
            <option>Tümü</option>
            <option>Alüminyum</option>
            <option>Demir Döküm</option>
            <option>Bambu</option>
            <option>Karbon Çelik</option>
            <option>PPR</option>
            <option>Bilinmiyor</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
            Model
          </label>
          <select
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            className="w-[130px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 font-medium"
          >
            <option>Tümü</option>
            <option>Tee</option>
            <option>Dirsek</option>
            <option>Base</option>
            <option>Cross</option>
            <option>5 Way</option>
            <option>6 Way</option>
            <option>Bilinmiyor</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
            Boru Tipi
          </label>
          <select
            value={tubeTypeFilter}
            onChange={(e) => setTubeTypeFilter(e.target.value)}
            className="w-[120px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 font-medium"
          >
            <option>Tümü</option>
            <option>Yuvarlak</option>
            <option>Kare</option>
            <option>Bilinmiyor</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-black text-gray-400 uppercase tracking-widest mb-1.5 ml-1">
            Boru Ölçüsü
          </label>
          <select
            value={pipeSizeFilter}
            onChange={(e) => setPipeSizeFilter(e.target.value)}
            className="w-[120px] text-sm border-gray-200 rounded-lg px-3 py-2 bg-gray-50 font-mono"
          >
            {pipeSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <button
          onClick={fetchAnalytics}
          disabled={isLoading}
          className="bg-primary text-white font-bold px-6 py-2 rounded-xl flex items-center gap-2 hover:bg-primary/90 transition-all ml-auto shadow-md"
        >
          {isLoading ? (
            <Activity className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          Filtrele
        </button>
      </div>

      {/* Tabs */}
      <div className="flex bg-white rounded-xl shadow-sm border border-gray-100 p-1.5 overflow-x-auto hide-scrollbar gap-1">
        <TabBtn
          active={activeTab === "dashboard"}
          onClick={() => setActiveTab("dashboard")}
          icon={<BarChart2 />}
          label="Dashboard"
        />
        <TabBtn
          active={activeTab === "cross"}
          onClick={() => setActiveTab("cross")}
          icon={<Layers />}
          label="Çapraz Analiz"
        />
        <TabBtn
          active={activeTab === "reorder"}
          onClick={() => setActiveTab("reorder")}
          icon={<ShoppingCart />}
          label="Akıllı Sipariş"
        />
        <TabBtn
          active={activeTab === "material"}
          onClick={() => setActiveTab("material")}
          icon={<Package />}
          label="Materyal Raporu"
        />
        <TabBtn
          active={activeTab === "series"}
          onClick={() => setActiveTab("series")}
          icon={<Layers />}
          label="Seri Raporu"
        />
        <TabBtn
          active={activeTab === "model"}
          onClick={() => setActiveTab("model")}
          icon={<Activity />}
          label="Model Raporu"
        />
        <TabBtn
          active={activeTab === "size"}
          onClick={() => setActiveTab("size")}
          icon={<BarChart2 />}
          label="Ölçü Raporu"
        />
        <TabBtn
          active={activeTab === "charts"}
          onClick={() => setActiveTab("charts")}
          icon={<PieChartIcon />}
          label="Görsel Analiz"
        />
        <TabBtn
          active={activeTab === "slow"}
          onClick={() => setActiveTab("slow")}
          icon={<AlertTriangle />}
          label="Yavaş Dönenler"
        />
      </div>

      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-gray-100 shadow-sm mt-4">
          <Activity className="w-10 h-10 text-primary animate-spin mb-4" />
          <p className="font-bold text-gray-500">
            Analiz verileri derleniyor...
          </p>
        </div>
      ) : (
        <div className="mt-6 animation-fade-in">
          {/* DASHBOARD TAB */}
          {activeTab === "dashboard" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <KPICard
                  title="Toplam SKU"
                  value={summary.totalSku}
                  icon={<Package />}
                  color="blue"
                />
                <KPICard
                  title="Toplam Satılan"
                  value={summary.totalSoldQty}
                  sub={`₺${summary.totalRevenue?.toLocaleString("tr-TR", { maximumFractionDigits: 0 })} Gelir`}
                  icon={<TrendingUp />}
                  color="emerald"
                />
                <KPICard
                  title="Toplam Stok"
                  value={summary.totalStock}
                  icon={<Layers />}
                  color="amber"
                />
                <KPICard
                  title="Aktif Satış Trendi"
                  value={charts?.trend?.length > 0 ? "Pozitif" : "N/A"}
                  icon={<Activity />}
                  color="indigo"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <StatusCard
                  title="En Çok Satan Materyal"
                  value={summary.topMaterial}
                  icon={<ArrowUpRight />}
                  bg="bg-blue-50 text-blue-800"
                />
                <StatusCard
                  title="En Çok Satan Model"
                  value={summary.topModel}
                  icon={<ArrowUpRight />}
                  bg="bg-emerald-50 text-emerald-800"
                />
                <StatusCard
                  title="En Çok Satan Seri"
                  value={summary.topSeries}
                  icon={<ArrowUpRight />}
                  bg="bg-cyan-50 text-cyan-800"
                />
                <StatusCard
                  title="En Çok Satan Ölçü"
                  value={summary.topSize}
                  icon={<ArrowUpRight />}
                  bg="bg-indigo-50 text-indigo-800"
                />

                <StatusCard
                  title="En Az Satan Materyal"
                  value={summary.bottomMaterial}
                  icon={<ArrowDownRight />}
                  bg="bg-rose-50 text-rose-800"
                />
                <StatusCard
                  title="En Az Satan Model"
                  value={summary.bottomModel}
                  icon={<ArrowDownRight />}
                  bg="bg-orange-50 text-orange-800"
                />
                <StatusCard
                  title="Kritik Stoklu SKU"
                  value={`${suggestions.filter((s) => s.priority === "Kritik").length} Adet`}
                  icon={<AlertTriangle />}
                  bg="bg-red-50 text-red-800"
                />
              </div>

              {/* Mini Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white p-6 justify-center flex flex-col rounded-2xl border border-gray-100 shadow-sm h-[350px]">
                  <h3 className="text-sm font-black text-gray-800 mb-6 uppercase tracking-widest text-center">
                    Satış Trendi
                  </h3>
                  {charts.trend && charts.trend.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={charts.trend}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#E5E7EB"
                        />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 10 }}
                          tickMargin={10}
                          minTickGap={30}
                          stroke="#9CA3AF"
                        />
                        <YAxis
                          tick={{ fontSize: 11 }}
                          stroke="#9CA3AF"
                          axisLine={false}
                          tickLine={false}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Line
                          type="monotone"
                          dataKey="qty"
                          name="Satılan Adet"
                          stroke="#3b82f6"
                          strokeWidth={3}
                          dot={false}
                          activeDot={{ r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState />
                  )}
                </div>
                <div className="bg-white p-6 justify-center flex flex-col rounded-2xl border border-gray-100 shadow-sm h-[350px]">
                  <h3 className="text-sm font-black text-gray-800 mb-6 uppercase tracking-widest text-center">
                    Materyal Dağılımı
                  </h3>
                  {charts.materialShare && charts.materialShare.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={charts.materialShare}
                          innerRadius={70}
                          outerRadius={100}
                          paddingAngle={2}
                          dataKey="value"
                          label={({ name, percent }) =>
                            `${name} ${(percent * 100).toFixed(0)}%`
                          }
                        >
                          {charts.materialShare.map(
                            (entry: any, index: number) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={COLORS[index % COLORS.length]}
                              />
                            ),
                          )}
                        </Pie>
                        <RechartsTooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* CHARTS TAB */}
          {activeTab === "charts" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartCard title="Boru Ölçüsü Dağılımı (Satış)">
                  {charts.sizeShare?.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={charts.sizeShare}
                        layout="vertical"
                        margin={{ left: 30 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          horizontal={false}
                          stroke="#E5E7EB"
                        />
                        <XAxis type="number" hide />
                        <YAxis
                          dataKey="name"
                          type="category"
                          tick={{ fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                          width={80}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Bar
                          dataKey="value"
                          name="Satılan Adet"
                          fill="#8b5cf6"
                          radius={[0, 4, 4, 0]}
                          barSize={16}
                        >
                          {charts.sizeShare.map((_: any, index: number) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={COLORS[index % COLORS.length]}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState />
                  )}
                </ChartCard>

                <ChartCard title="Model Satış Payı">
                  {charts.modelShare?.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={charts.modelShare}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#E5E7EB"
                        />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis hide />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Bar
                          dataKey="value"
                          name="Satılan Adet"
                          fill="#10b981"
                          radius={[4, 4, 0, 0]}
                          barSize={24}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState />
                  )}
                </ChartCard>

                <ChartCard title="Materyal Bazlı Stok vs Satış">
                  {reports.material?.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={reports.material}>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="#E5E7EB"
                        />
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 11 }}
                          axisLine={false}
                        />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Legend
                          wrapperStyle={{
                            fontSize: "12px",
                            fontWeight: "bold",
                          }}
                        />
                        <Bar
                          dataKey="soldQty"
                          name="Satılan Adet"
                          fill="#3b82f6"
                          radius={[4, 4, 0, 0]}
                        />
                        <Bar
                          dataKey="currentStock"
                          name="Mevcut Stok"
                          fill="#f59e0b"
                          radius={[4, 4, 0, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState />
                  )}
                </ChartCard>
              </div>
            </div>
          )}

          {/* CROSS TAB */}
          {activeTab === "cross" && (
            <DataGridCard
              title="Çapraz Analiz (Materyal + Model + Ölçü)"
              data={cross}
              filename="capraz_analiz"
              onDownload={downloadCSV}
              columns={[
                { key: "material", label: "Materyal" },
                { key: "series", label: "Seri" },
                { key: "model", label: "Model" },
                { key: "tubeType", label: "Boru Tipi" },
                { key: "size", label: "Ölçü", isMono: true },
                { key: "skuCount", label: "SKU", align: "center" },
                {
                  key: "soldQty",
                  label: "Satış",
                  align: "right",
                  isBold: true,
                  color: "text-primary",
                },
                {
                  key: "currentStock",
                  label: "Stok",
                  align: "right",
                  isBold: true,
                },
                {
                  key: "revenue",
                  label: "Gelir (₺)",
                  align: "right",
                  isMoney: true,
                },
              ]}
            />
          )}

          {/* MATERIAL TAB */}
          {activeTab === "material" && (
            <DataGridCard
              title="Materyal Raporu"
              data={reports.material}
              filename="materyal_raporu"
              onDownload={downloadCSV}
              columns={[
                {
                  key: "name",
                  label: "Materyal Adı",
                  isBold: true,
                  color: "text-gray-900",
                },
                { key: "skuCount", label: "Bğl. SKU", align: "center" },
                {
                  key: "soldQty",
                  label: "Satılan Adet",
                  align: "right",
                  isBold: true,
                  color: "text-emerald-600",
                },
                {
                  key: "currentStock",
                  label: "Toplam Stok",
                  align: "right",
                  isBold: true,
                },
                {
                  key: "revenue",
                  label: "Satış Geliri",
                  align: "right",
                  isMoney: true,
                },
              ]}
            />
          )}

          {/* SERIES TAB */}
          {activeTab === "series" && (
            <DataGridCard
              title="Seri Raporu"
              data={reports.series}
              filename="seri_raporu"
              onDownload={downloadCSV}
              columns={[
                {
                  key: "name",
                  label: "Seri",
                  isBold: true,
                  color: "text-gray-900",
                },
                { key: "skuCount", label: "Bğl. SKU", align: "center" },
                {
                  key: "soldQty",
                  label: "Satılan Adet",
                  align: "right",
                  isBold: true,
                  color: "text-emerald-600",
                },
                {
                  key: "currentStock",
                  label: "Toplam Stok",
                  align: "right",
                  isBold: true,
                },
                {
                  key: "revenue",
                  label: "Satış Geliri",
                  align: "right",
                  isMoney: true,
                },
              ]}
            />
          )}

          {/* MODEL TAB */}
          {activeTab === "model" && (
            <DataGridCard
              title="Model Raporu"
              data={reports.model}
              filename="model_raporu"
              onDownload={downloadCSV}
              columns={[
                {
                  key: "name",
                  label: "Model Adı",
                  isBold: true,
                  color: "text-gray-900",
                },
                { key: "skuCount", label: "Bğl. SKU", align: "center" },
                {
                  key: "soldQty",
                  label: "Satılan Adet",
                  align: "right",
                  isBold: true,
                  color: "text-emerald-600",
                },
                {
                  key: "currentStock",
                  label: "Toplam Stok",
                  align: "right",
                  isBold: true,
                },
                {
                  key: "revenue",
                  label: "Satış Geliri",
                  align: "right",
                  isMoney: true,
                },
              ]}
            />
          )}

          {/* SIZE TAB */}
          {activeTab === "size" && (
            <DataGridCard
              title="Ölçü Raporu"
              data={reports.size}
              filename="olcu_raporu"
              onDownload={downloadCSV}
              columns={[
                {
                  key: "name",
                  label: "Ölçü Adı",
                  isBold: true,
                  isMono: true,
                  color: "text-gray-800",
                },
                { key: "skuCount", label: "Bğl. SKU", align: "center" },
                {
                  key: "soldQty",
                  label: "Satılan Adet",
                  align: "right",
                  isBold: true,
                  color: "text-emerald-600",
                },
                {
                  key: "currentStock",
                  label: "Toplam Stok",
                  align: "right",
                  isBold: true,
                },
                {
                  key: "revenue",
                  label: "Satış Geliri",
                  align: "right",
                  isMoney: true,
                },
              ]}
            />
          )}

          {/* REORDER TAB */}
          {activeTab === "reorder" && (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 overflow-hidden flex flex-col">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-black text-gray-900 flex items-center gap-2">
                  <ShoppingCart className="w-5 h-5 text-indigo-500" /> Akıllı
                  Sipariş Önerileri
                </h2>
                <button
                  onClick={() => downloadCSV(suggestions, "siparis_onerileri")}
                  className="text-sm font-bold text-gray-600 flex items-center gap-2 hover:text-primary"
                >
                  <Download className="w-4 h-4" /> CSV İndir
                </button>
              </div>
              {suggestions.length > 0 ? (
                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-100">
                        <th className="py-3">Ürün Grubu</th>
                        <th className="py-3">SKU</th>
                        <th className="py-3 text-right">Satış (Dönem)</th>
                        <th className="py-3 text-right">Mevcut Stok</th>
                        <th className="py-3 text-center">Günlük Ort.</th>
                        <th className="py-3 text-center">Durum</th>
                        <th className="py-3">Aksiyon</th>
                      </tr>
                    </thead>
                    <tbody>
                      {suggestions.slice(0, 100).map((s: any, idx: number) => (
                        <tr
                          key={s.id + idx}
                          className="border-b border-gray-50 hover:bg-slate-50 transition-colors"
                        >
                          <td className="py-3">
                            <p
                              className="font-bold text-gray-900 truncate max-w-[200px]"
                              title={s.name}
                            >
                              {s.name || "İsimsiz"}
                            </p>
                            <p className="text-xs text-gray-500">
                              {s.material} | {s.model}
                            </p>
                          </td>
                          <td className="py-3 font-mono text-xs text-gray-500">
                            {s.sku}
                          </td>
                          <td className="py-3 text-right font-black text-emerald-600">
                            {s.soldQty}
                          </td>
                          <td
                            className={`py-3 text-right font-bold ${s.currentStock === 0 ? "text-red-500" : "text-gray-700"}`}
                          >
                            {s.currentStock}
                          </td>
                          <td className="py-3 text-center font-mono text-xs">
                            {s.dailyAvg}
                          </td>
                          <td className="py-3 text-center">
                            <span
                              className={`inline-block px-2 py-1 rounded-md text-[10px] font-black tracking-widest uppercase ${
                                s.priority === "Kritik"
                                  ? "bg-red-100 text-red-700"
                                  : s.priority === "Düşük Stok"
                                    ? "bg-orange-100 text-orange-700"
                                    : s.priority === "Fazla Stok"
                                      ? "bg-blue-100 text-blue-700"
                                      : s.priority === "Ölü Stok"
                                        ? "bg-gray-200 text-gray-700"
                                        : "bg-emerald-100 text-emerald-700"
                              }`}
                            >
                              {s.priority}
                            </span>
                          </td>
                          <td className="py-3">
                            <span className="font-bold text-gray-800 text-xs">
                              {s.action}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {suggestions.length > 100 && (
                    <p className="text-center text-xs text-gray-400 font-bold py-4">
                      Sadece ilk 100 kayıt listeleniyor. Tamamı için CSV
                      indiriniz.
                    </p>
                  )}
                </div>
              ) : (
                <EmptyState msg="Öneri üretilecek veri bulunamadı" />
              )}
            </div>
          )}

          {/* SLOW MOVERS TAB */}
          {activeTab === "slow" && (
            <DataGridCard
              title="Yavaş Dönenler (Sıfır Satış, Stoklu)"
              data={slowMovers}
              filename="yavas_donenler"
              onDownload={downloadCSV}
              columns={[
                {
                  key: "name",
                  label: "Ürün Adı",
                  isBold: true,
                  color: "text-gray-900",
                },
                { key: "sku", label: "SKU", isMono: true },
                { key: "material", label: "Materyal" },
                { key: "model", label: "Model" },
                { key: "size", label: "Ölçü", isMono: true },
                {
                  key: "currentStock",
                  label: "Tutsak Stok",
                  align: "right",
                  isBold: true,
                  color: "text-red-600",
                },
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Subcomponents

const TabBtn = ({ active, onClick, icon, label }: any) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold transition-all whitespace-nowrap ${
      active
        ? "bg-blue-50 text-blue-700 shadow-sm"
        : "text-gray-500 hover:text-gray-900 hover:bg-gray-50"
    }`}
  >
    <div
      className={`[&>svg]:w-4 [&>svg]:h-4 ${active ? "text-blue-500" : "text-gray-400"}`}
    >
      {icon}
    </div>
    {label}
  </button>
);

const KPICard = ({ title, value, sub, icon, color }: any) => {
  const colors: any = {
    blue: "bg-blue-50 text-blue-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    indigo: "bg-indigo-50 text-indigo-600",
  };
  return (
    <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-sm flex items-start gap-4">
      <div
        className={`w-12 h-12 shrink-0 rounded-xl flex items-center justify-center ${colors[color]}`}
      >
        <div className="[&>svg]:w-6 [&>svg]:h-6">{icon}</div>
      </div>
      <div>
        <h3 className="text-gray-500 text-[11px] uppercase tracking-widest font-black mb-1">
          {title}
        </h3>
        <p className="text-2xl font-black text-gray-900">
          {typeof value === "number" ? value.toLocaleString("tr-TR") : value}
        </p>
        {sub && <p className="text-xs font-bold text-gray-400 mt-1">{sub}</p>}
      </div>
    </div>
  );
};

const StatusCard = ({ title, value, icon, bg }: any) => (
  <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm flex justify-between items-center">
    <div>
      <h3 className="text-gray-400 text-[10px] uppercase tracking-widest font-black mb-1.5">
        {title}
      </h3>
      <p
        className="text-sm font-black text-gray-900 truncate max-w-[200px]"
        title={value}
      >
        {value}
      </p>
    </div>
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center ${bg}`}
    >
      <div className="[&>svg]:w-4 [&>svg]:h-4">{icon}</div>
    </div>
  </div>
);

const ChartCard = ({ title, children }: any) => (
  <div className="bg-white p-6 justify-center flex flex-col rounded-2xl border border-gray-100 shadow-sm h-[400px]">
    <h3 className="text-sm font-black text-gray-800 mb-6 uppercase tracking-widest text-center">
      {title}
    </h3>
    <div className="flex-1 w-full h-full min-h-[250px]">{children}</div>
  </div>
);

const DataGridCard = ({ title, data, columns, filename, onDownload }: any) => {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 overflow-hidden">
      <div className="flex justify-between items-center mb-6 border-b border-gray-100 pb-4">
        <h2 className="text-lg font-black text-gray-900 flex items-center gap-2">
          <Layers className="w-5 h-5 text-blue-500" /> {title}
        </h2>
        <button
          onClick={() => onDownload && onDownload(data, filename)}
          className="text-sm font-bold text-gray-600 flex items-center gap-2 hover:text-primary"
        >
          <Download className="w-4 h-4" /> CSV İndir
        </button>
      </div>
      {data?.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-gray-400 border-b border-gray-100 text-[11px] uppercase tracking-wider bg-gray-50/50">
                {columns.map((col: any, idx: number) => (
                  <th
                    key={idx}
                    className={`py-3 px-2 ${col.align === "center" ? "text-center" : col.align === "right" ? "text-right" : ""}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row: any, idx: number) => (
                <tr
                  key={idx}
                  className="border-b border-gray-50 hover:bg-blue-50/30 transition-colors"
                >
                  {columns.map((col: any, cidx: number) => {
                    const val = row[col.key];
                    return (
                      <td
                        key={cidx}
                        className={`py-3 px-2 ${col.align === "center" ? "text-center" : col.align === "right" ? "text-right" : ""} ${col.isBold ? "font-bold" : ""} ${col.isMono ? "font-mono text-xs" : ""} ${col.color ? col.color : "text-gray-600"}`}
                      >
                        {col.isMoney
                          ? `₺${(val || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2 })}`
                          : val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState msg="Veri bulunamadı" />
      )}
    </div>
  );
};

const EmptyState = ({ msg = "Bu kırılım için yeterli veri yok" }: any) => (
  <div className="flex flex-col items-center justify-center p-8 text-center h-full opacity-60">
    <AlertTriangle className="w-10 h-10 text-gray-300 mb-3" />
    <p className="font-bold text-gray-400 text-sm">{msg}</p>
  </div>
);

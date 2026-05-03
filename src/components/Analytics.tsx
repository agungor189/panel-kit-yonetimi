import { useState, useEffect, useMemo } from 'react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { 
  TrendingUp, 
  TrendingDown, 
  DollarSign, 
  Target, 
  ShoppingBag,
  ArrowUpRight,
  AlertTriangle,
  Package,
  Activity,
  Layers,
  Banknote,
  Search,
  Network,
  Filter
} from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { Transaction, Product, Settings } from '../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F43F5E'];

type TabView = 'financial' | 'products' | 'platform' | 'cashflow' | 'risk';

const getCentralProductStock = (product: Product) => Number(product.central_stock ?? product.total_stock ?? 0) || 0;

export default function Analytics({ settings, initialTab }: { settings: Settings | null, initialTab?: string }) {
  const { FormatAmount, activeRate } = useCurrency();
  const [activeTab, setActiveTab] = useState<string>(initialTab || 'financial');
  const [period, setPeriod] = useState<string>('this_month');
  
  const [matrixFilterMaterial, setMatrixFilterMaterial] = useState('Hepsi');
  const [matrixFilterModel, setMatrixFilterModel] = useState('Hepsi');
  const [matrixFilterSize, setMatrixFilterSize] = useState('Hepsi');
  
  const [sales, setSales] = useState<any[]>([]);
  const [saleItems, setSaleItems] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [cashTxs, setCashTxs] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Load static data
  useEffect(() => {
    const loadStatic = async () => {
      try {
        const [prodData, cxData, caData] = await Promise.all([
          api.get('/products'),
          api.get('/cash-transactions'),
          api.get('/cash-accounts')
        ]);
        setProducts(prodData);
        setCashTxs(cxData);
        setCashAccounts(caData);
      } catch (err) {
        console.error(err);
      }
    };
    loadStatic();
  }, []);

  // Load analytics data
  useEffect(() => {
    const loadAnalytics = async () => {
      setLoading(true);
      try {
        const data = await api.get(`/analytics?period=${period}`);
        setSales(data.sales || []);
        setSaleItems(data.saleItems || []);
        setTransactions(data.expenses || []);
        setMetrics(data.metrics || null);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    loadAnalytics();
  }, [period]);

  // --- FINANSAL ANALIZ (Financial Analysis) ---
  const financialMonthly = useMemo(() => {
    const groups: Record<string, { month: string, income: number, expense: number }> = {};
    sales.forEach(s => {
      const date = new Date(s.created_at);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
      if (!groups[key]) groups[key] = { month: key, income: 0, expense: 0 };
      groups[key].income += s.total_amount || 0;
    });

    transactions.filter(t => t.type === 'Expense').forEach(t => {
      const date = new Date(t.date);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
      if (!groups[key]) groups[key] = { month: key, income: 0, expense: 0 };
      groups[key].expense += t.amount || 0;
    });

    return Object.values(groups).sort((a, b) => a.month.localeCompare(b.month)).map(d => ({
      ...d,
      net: d.income - d.expense,
      margin: d.income > 0 ? ((d.income - d.expense) / d.income * 100).toFixed(1) : 0
    }));
  }, [sales, transactions]);

  // --- ÜRÜN ANALİZİ (Product Analysis) ---
  const missingCostCount = useMemo(() => {
     return saleItems.filter((si: any) => !si.purchase_cost || si.purchase_cost <= 0).length;
  }, [saleItems]);

  const productStats = useMemo(() => {
     return products.map(p => {
        const pItems = saleItems.filter((si: any) => si.product_id === p.id);
        const soldCount = pItems.reduce((sum: number, si: any) => sum + si.quantity, 0);
        const pRevenue = pItems.reduce((sum: number, si: any) => sum + (si.unit_price * si.quantity), 0);
        const pProfit = pItems.reduce((sum: number, si: any) => sum + (si.net_profit || 0), 0);
        
        return {
           ...p,
           soldQty: soldCount,
           revenue: pRevenue,
           profit: pProfit,
           margin: pRevenue > 0 ? (pProfit / pRevenue) * 100 : 0
        };
     }).sort((a, b) => b.revenue - a.revenue);
  }, [products, saleItems]);

  const modelStats = useMemo(() => {
     const groups: Record<string, { model: string, revenue: number, profit: number, soldQty: number }> = {};
     productStats.forEach(p => {
        if (!p.model) return;
        if (!groups[p.model]) groups[p.model] = { model: p.model, revenue: 0, profit: 0, soldQty: 0 };
        groups[p.model].revenue += p.revenue;
        groups[p.model].profit += p.profit;
        groups[p.model].soldQty += p.soldQty;
     });
     return Object.values(groups).map(g => ({ ...g, margin: g.revenue > 0 ? (g.profit / g.revenue) * 100 : 0 })).sort((a, b) => b.revenue - a.revenue);
  }, [productStats]);

  const materialStats = useMemo(() => {
     const groups: Record<string, { material: string, revenue: number, profit: number, soldQty: number }> = {};
     productStats.forEach(p => {
        const mat = p.material || 'Belirtilmedi';
        if (!groups[mat]) groups[mat] = { material: mat, revenue: 0, profit: 0, soldQty: 0 };
        groups[mat].revenue += p.revenue;
        groups[mat].profit += p.profit;
        groups[mat].soldQty += p.soldQty;
     });
     return Object.values(groups).map(g => ({ ...g, margin: g.revenue > 0 ? (g.profit / g.revenue) * 100 : 0 })).sort((a, b) => b.revenue - a.revenue);
  }, [productStats]);

  // --- İLERİ DÜZEY MATRİS (Advanced Matrix) ---
  const advancedAnalysis = useMemo(() => {
    const combos: Record<string, { material: string, model: string, size: string, soldQty: number, revenue: number, profit: number, stock: number, key: string }> = {};
    const sizeTrends: Record<string, { size: string, soldQty: number, revenue: number, stock: number }> = {};
    const materialModelTrends: Record<string, { material: string, model: string, soldQty: number, revenue: number, stock: number }> = {};
    const materialSizeTrends: Record<string, { material: string, size: string, soldQty: number, revenue: number, stock: number }> = {};

    const filteredProductStats = productStats.filter(p => {
       const mat = p.material || 'Belirtilmedi';
       const mod = p.model || 'Belirtilmedi';
       const sz = p.size || 'Belirtilmedi';
       
       if (matrixFilterMaterial !== 'Hepsi' && mat !== matrixFilterMaterial) return false;
       if (matrixFilterModel !== 'Hepsi' && mod !== matrixFilterModel) return false;
       if (matrixFilterSize !== 'Hepsi' && sz !== matrixFilterSize) return false;
       
       return true;
    });

    const uniqueMaterials = ['Hepsi', ...new Set(productStats.map(p => p.material || 'Belirtilmedi'))].filter(Boolean);
    const uniqueModels = ['Hepsi', ...new Set(productStats.map(p => p.model || 'Belirtilmedi'))].filter(Boolean);
    const uniqueSizes = ['Hepsi', ...new Set(productStats.map(p => p.size || 'Belirtilmedi'))].filter(Boolean);

    filteredProductStats.forEach(p => {
       const mat = p.material || 'Belirtilmedi';
       const mod = p.model || 'Belirtilmedi';
       const sz = p.size || 'Belirtilmedi';
       const stock = getCentralProductStock(p);

       const comboKey = `${mat}---${mod}---${sz}`;
       if (!combos[comboKey]) combos[comboKey] = { key: comboKey, material: mat, model: mod, size: sz, soldQty: 0, revenue: 0, profit: 0, stock: 0 };
       combos[comboKey].soldQty += p.soldQty;
       combos[comboKey].revenue += p.revenue;
       combos[comboKey].profit += p.profit;
       combos[comboKey].stock += stock;

       if (!sizeTrends[sz]) sizeTrends[sz] = { size: sz, soldQty: 0, revenue: 0, stock: 0 };
       sizeTrends[sz].soldQty += p.soldQty;
       sizeTrends[sz].revenue += p.revenue;
       sizeTrends[sz].stock += stock;

       const matModKey = `${mat}---${mod}`;
       if (!materialModelTrends[matModKey]) materialModelTrends[matModKey] = { material: mat, model: mod, soldQty: 0, revenue: 0, stock: 0 };
       materialModelTrends[matModKey].soldQty += p.soldQty;
       materialModelTrends[matModKey].revenue += p.revenue;
       materialModelTrends[matModKey].stock += stock;

       const matSzKey = `${mat}---${sz}`;
       if (!materialSizeTrends[matSzKey]) materialSizeTrends[matSzKey] = { material: mat, size: sz, soldQty: 0, revenue: 0, stock: 0 };
       materialSizeTrends[matSzKey].soldQty += p.soldQty;
       materialSizeTrends[matSzKey].revenue += p.revenue;
       materialSizeTrends[matSzKey].stock += stock;
    });

    const comboList = Object.values(combos).sort((a,b) => b.soldQty - a.soldQty);
    const sizeList = Object.values(sizeTrends).sort((a,b) => b.soldQty - a.soldQty);
    const matModList = Object.values(materialModelTrends).sort((a,b) => b.soldQty - a.soldQty);
    const matSzList = Object.values(materialSizeTrends).sort((a,b) => b.soldQty - a.soldQty);

    const lowDemand = comboList.filter(c => c.stock > 0).sort((a,b) => {
        const aRatio = a.soldQty / a.stock;
        const bRatio = b.soldQty / b.stock;
        if (aRatio === bRatio) return b.stock - a.stock;
        return aRatio - bRatio;
    });

    return { comboList, sizeList, matModList, matSzList, lowDemand, uniqueMaterials, uniqueModels, uniqueSizes };
  }, [productStats, matrixFilterMaterial, matrixFilterModel, matrixFilterSize]);

  // --- RİSK ANALİZİ (Risk Analysis) ---
  const riskStats = useMemo(() => {
     const threshold = parseInt(settings?.low_stock_threshold?.toString() || '5');
     const deadThresholdMillis = 30 * 24 * 60 * 60 * 1000; // 30 days
     const now = new Date().getTime();

     return productStats.map(p => {
        const pSales = sales.filter(s => saleItems.some(si => si.sale_id === s.id && si.product_id === p.id));
        const lastSale = pSales.length > 0 ? new Date(Math.max(...pSales.map(t => new Date(t.created_at).getTime()))) : null;
        const totalStock = getCentralProductStock(p);
        
        const isCritical = totalStock <= (p.min_stock_level || threshold) && p.status === 'Active';
        const isDead = p.status === 'Active' && totalStock > 0 && (!lastSale || (now - lastSale.getTime() > deadThresholdMillis));
        const isLosingMoney = p.soldQty > 0 && p.margin < 0;
        
        return {
           ...p,
           totalStock,
           lastSale,
           isCritical,
           isDead,
           isLosingMoney
        };
     });
  }, [productStats, sales, saleItems, settings]);

  // --- NAKİT AKIŞI ANALİZİ (Cashflow Analysis) ---
  const cashFlowMonthly = useMemo(() => {
    const groups: Record<string, { month: string, in: number, out: number }> = {};
    cashTxs.forEach(ctx => {
      const date = new Date(ctx.created_at);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
      if (!groups[key]) groups[key] = { month: key, in: 0, out: 0 };
      if (ctx.type === 'IN') groups[key].in += ctx.amount;
      if (ctx.type === 'OUT') groups[key].out += ctx.amount;
    });

    return Object.values(groups).sort((a, b) => a.month.localeCompare(b.month)).map(d => ({
      ...d,
      net: d.in - d.out
    }));
  }, [cashTxs]);

  // --- KUR ETKİSİ ANALİZİ (FX Impact) ---
  const fxImpact = useMemo(() => {
     let originalStockCost = 0;
     let currentStockCost = 0;

     products.forEach(p => {
        const totalStock = getCentralProductStock(p);
        if (totalStock > 0 && p.purchase_price_usd > 0) {
           originalStockCost += (totalStock * p.purchase_cost);
           currentStockCost += (totalStock * (p.purchase_price_usd * activeRate));
        }
     });

     return {
        originalStockCost,
        currentStockCost,
        diff: currentStockCost - originalStockCost
     };
  }, [products, activeRate]);
  const platformStats = useMemo(() => {
      const stats: Record<string, { revenue: number, profit: number, count: number, commission: number }> = {};
      sales.forEach(s => {
         if (!stats[s.platform]) stats[s.platform] = { revenue: 0, profit: 0, count: 0, commission: 0 };
         stats[s.platform].revenue += s.total_amount;
         stats[s.platform].profit += s.net_profit;
         stats[s.platform].count += 1;
         
         const cRate = settings?.commission_rates?.[s.platform] || 0;
         stats[s.platform].commission += (s.total_amount * cRate) / 100;
      });
      return Object.entries(stats).map(([platform, data]) => ({
         platform, ...data, margin: data.revenue > 0 ? (data.profit / data.revenue) * 100 : 0
      })).sort((a,b) => b.revenue - a.revenue);
  }, [sales, settings]);


  if (loading) return <div className="p-8 text-center text-gray-500 font-medium">Analizler hazırlanıyor...</div>;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
           <h1 className="text-2xl font-black text-gray-900 tracking-tight">Akıllı Analizler</h1>
           <p className="text-sm font-medium text-gray-500 mt-1">Verilerinizi kazanca dönüştüren derinlemesine içgörüler</p>
        </div>
        <div className="flex items-center gap-3">
           <div className="relative">
              <select 
                 value={period}
                 onChange={(e) => setPeriod(e.target.value)}
                 className="appearance-none bg-white border border-gray-300 text-gray-700 font-bold text-sm rounded-xl pl-4 pr-10 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 hover:bg-gray-50 transition-colors shadow-sm"
              >
                 <option value="today">Bugün</option>
                 <option value="this_week">Bu Hafta</option>
                 <option value="this_month">Bu Ay</option>
                 <option value="last_3_months">Son 3 Ay</option>
                 <option value="last_6_months">Son 6 Ay</option>
                 <option value="this_year">Bu Yıl</option>
                 <option value="all_time">Tüm Zamanlar</option>
              </select>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-gray-500">
                 <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z"/></svg>
              </div>
           </div>
        </div>
      </div>

      {missingCostCount > 0 && (
         <div className="bg-orange-50 border border-orange-200 p-4 rounded-xl flex items-start gap-4">
            <div className="bg-orange-100 p-2 rounded-lg">
               <AlertTriangle className="w-5 h-5 text-orange-600" />
            </div>
            <div>
               <h3 className="font-bold text-orange-900">Maliyeti Girilmemiş Satışlar Var</h3>
               <p className="text-sm text-orange-800 mt-1">Seçili dönemde maliyet bilgisi olmayan <span className="font-black">{missingCostCount}</span> adet satış kalemi tespit edildi. Bu durum kârlılık analizlerinizi yanıltabilir. Ayarlar'dan "Bakım ve Onarım &gt;&gt; Fiyatları Geçmişe Uygula" aracını kullanabilirsiniz.</p>
            </div>
         </div>
      )}

      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
         {[
           { id: 'financial', label: 'Finansal Analiz', icon: TrendingUp },
           { id: 'products', label: 'Ürün Analizi', icon: Package },
           { id: 'models', label: 'Model Analizi', icon: Layers },
           { id: 'materials', label: 'Materyal Analizi', icon: Layers },
           { id: 'matrix', label: 'Matris & Sipariş Analizi', icon: Network },
           { id: 'platform', label: 'Platform Analizi', icon: Layers },
           { id: 'cashflow', label: 'Nakit Akışı', icon: Banknote },
           { id: 'risk', label: 'Risk Analizi', icon: AlertTriangle }
         ].map(tab => (
           <button
             key={tab.id}
             onClick={() => setActiveTab(tab.id)}
             className={cn(
               "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all whitespace-nowrap",
               activeTab === tab.id 
                 ? "bg-gray-900 text-white shadow-md" 
                 : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900"
             )}
           >
             <tab.icon className="w-4 h-4" />
             {tab.label}
           </button>
         ))}
      </div>

      {activeTab === 'financial' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 card p-6">
                <h3 className="font-bold text-lg text-gray-900 mb-6">Aylık Gelir ve Gider Trendi</h3>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={financialMonthly}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                      <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                      <Legend />
                      <Bar dataKey="income" name="Ciro" fill="#10B981" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="expense" name="Gider" fill="#EF4444" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="net" name="Net Kar" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="space-y-6 flex flex-col">
                  <div className="card p-6 flex-1">
                     <h3 className="font-bold text-lg text-gray-900 mb-6">Kar Marjı Trendi (%)</h3>
                     <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={financialMonthly}>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                          <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                          <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                          <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0' }} />
                          <Line type="monotone" name="Marj (%)" dataKey="margin" stroke="#3B82F6" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="card p-6">
                     <div className="flex items-center gap-3 mb-4">
                        <TrendingUp className={cn("w-6 h-6", fxImpact.diff >= 0 ? "text-green-500" : "text-red-500")} />
                        <h3 className="font-bold text-lg text-gray-900">Stok Kur Etkisi</h3>
                     </div>
                     <p className="text-sm text-gray-600 mb-4">Mevcut stoklarınızın alım kuru ile güncel kur arasındaki TL farkı.</p>
                     
                     <div className="space-y-3">
                        <div className="flex justify-between items-center text-sm">
                           <span className="text-gray-500">Orijinal Alım Maliyeti:</span>
                           <span className="font-semibold"><FormatAmount amount={fxImpact.originalStockCost} /></span>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                           <span className="text-gray-500">Güncel Kur Maliyeti:</span>
                           <span className="font-semibold"><FormatAmount amount={fxImpact.currentStockCost} /></span>
                        </div>
                        <div className="border-t border-gray-100 pt-3 flex justify-between items-center">
                           <span className="font-bold text-gray-900">Net Etki:</span>
                           <span className={cn("font-black text-lg", fxImpact.diff >= 0 ? "text-green-600" : "text-red-600")}>
                             {fxImpact.diff > 0 ? "+" : ""}<FormatAmount amount={fxImpact.diff} />
                           </span>
                        </div>
                     </div>
                  </div>
              </div>
           </div>
        </div>
      )}

      {activeTab === 'products' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="card p-6 overflow-hidden">
             <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-lg text-gray-900">Ürün Performans Sıralaması</h3>
                <span className="text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">{products.length} Ürün Listelendi</span>
             </div>
             <div className="overflow-x-auto">
               <table className="w-full text-left border-collapse whitespace-nowrap min-w-[800px]">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="py-4 font-bold text-sm text-gray-500">Ürün</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Satış</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Ciro</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">T. Net Kar</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Marj</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {productStats.map(p => (
                      <tr key={p.id} className="hover:bg-gray-50 transition-colors group">
                        <td className="py-4 font-medium text-gray-900 flex items-center gap-3">
                          <div className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center text-gray-400">
                            <Package className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="text-sm font-bold">{p.title}</div>
                            <div className="text-xs text-gray-500">{p.sku}</div>
                          </div>
                        </td>
                        <td className="py-4 text-right text-sm">{p.soldQty} Adet</td>
                        <td className="py-4 text-right text-sm font-semibold text-gray-900"><FormatAmount align="right" amount={p.revenue} /></td>
                        <td className="py-4 text-right text-sm font-bold text-green-600"><FormatAmount align="right" amount={p.profit} /></td>
                        <td className="py-4 text-right text-sm font-semibold">
                          <span className={cn("px-2 py-0.5 rounded-full text-xs", p.margin >= 20 ? "bg-green-100 text-green-800" : p.margin > 0 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800")}>
                            %{p.margin.toFixed(1)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
               </table>
             </div>
           </div>
        </div>
      )}

      {activeTab === 'models' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="card p-6 overflow-hidden">
             <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-lg text-gray-900">Model Performans Sıralaması</h3>
                <span className="text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">{modelStats.length} Model Listelendi</span>
             </div>
             <div className="overflow-x-auto">
               <table className="w-full text-left border-collapse whitespace-nowrap min-w-[800px]">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="py-4 font-bold text-sm text-gray-500">Model Adı</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Satış</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Ciro</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">T. Net Kar</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Marj</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {modelStats.map(m => (
                      <tr key={m.model} className="hover:bg-gray-50 transition-colors group">
                        <td className="py-4 font-bold text-gray-900">{m.model}</td>
                        <td className="py-4 text-right text-sm">{m.soldQty} Adet</td>
                        <td className="py-4 text-right text-sm font-semibold text-gray-900"><FormatAmount align="right" amount={m.revenue} /></td>
                        <td className="py-4 text-right text-sm font-bold text-green-600"><FormatAmount align="right" amount={m.profit} /></td>
                        <td className="py-4 text-right text-sm font-semibold">
                          <span className={cn("px-2 py-0.5 rounded-full text-xs", m.margin >= 20 ? "bg-green-100 text-green-800" : m.margin > 0 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800")}>
                            %{m.margin.toFixed(1)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
               </table>
             </div>
           </div>
        </div>
      )}

      {activeTab === 'materials' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="card p-6 overflow-hidden">
             <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-lg text-gray-900">Materyal Performans Sıralaması</h3>
                <span className="text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1 rounded-full">{materialStats.length} Materyal Listelendi</span>
             </div>
             <div className="overflow-x-auto">
               <table className="w-full text-left border-collapse whitespace-nowrap min-w-[800px]">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="py-4 font-bold text-sm text-gray-500">Materyal Türü</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Satış</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Tahmini Ciro</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">T. Net Kar</th>
                      <th className="py-4 font-bold text-sm text-gray-500 text-right">Marj</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {materialStats.map(m => (
                      <tr key={m.material} className="hover:bg-gray-50 transition-colors group">
                        <td className="py-4 font-bold text-gray-900">{m.material}</td>
                        <td className="py-4 text-right text-sm">{m.soldQty} Adet</td>
                        <td className="py-4 text-right text-sm font-semibold text-gray-900"><FormatAmount align="right" amount={m.revenue} /></td>
                        <td className="py-4 text-right text-sm font-bold text-green-600"><FormatAmount align="right" amount={m.profit} /></td>
                        <td className="py-4 text-right text-sm font-semibold">
                          <span className={cn("px-2 py-0.5 rounded-full text-xs", m.margin >= 20 ? "bg-green-100 text-green-800" : m.margin > 0 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800")}>
                            %{m.margin.toFixed(1)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
               </table>
             </div>
           </div>
        </div>
      )}

      {activeTab === 'matrix' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="card p-6 border-blue-200 border-2 bg-blue-50/20">
             <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-lg text-blue-900 flex items-center gap-2"><Network className="w-5 h-5 text-blue-600" /> Katalog Çapraz Analizi & Yeni Sipariş Önerileri</h3>
                <span className="text-xs font-bold text-blue-700 bg-blue-100 px-3 py-1 rounded-full">{advancedAnalysis.comboList.length} Kombinasyon Algılandı</span>
             </div>
             <p className="text-sm text-blue-800 mb-6 font-medium">Bu matrix, materyal, model ve ölçü bazlı en çok talep gören ve en düşük stok devir hızına sahip olan özellikleri çaprazlayarak sonraki döküm ve ithalat siparişlerinizde karar vermenize yardımcı olur.</p>
             
             <div className="flex flex-wrap gap-4 mb-6 p-4 bg-white rounded-xl border border-blue-100 shadow-sm">
                <div className="flex-1 min-w-[200px]">
                   <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Materyal</label>
                   <select value={matrixFilterMaterial} onChange={e => setMatrixFilterMaterial(e.target.value)} className="w-full text-sm font-bold bg-gray-50 border-gray-200 rounded-lg px-3 py-2">
                      {advancedAnalysis.uniqueMaterials.map(m => <option key={m} value={m}>{m}</option>)}
                   </select>
                </div>
                <div className="flex-1 min-w-[200px]">
                   <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Model</label>
                   <select value={matrixFilterModel} onChange={e => setMatrixFilterModel(e.target.value)} className="w-full text-sm font-bold bg-gray-50 border-gray-200 rounded-lg px-3 py-2">
                      {advancedAnalysis.uniqueModels.map(m => <option key={m} value={m}>{m}</option>)}
                   </select>
                </div>
                <div className="flex-1 min-w-[200px]">
                   <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Ölçü</label>
                   <select value={matrixFilterSize} onChange={e => setMatrixFilterSize(e.target.value)} className="w-full text-sm font-bold bg-gray-50 border-gray-200 rounded-lg px-3 py-2">
                      {advancedAnalysis.uniqueSizes.map(s => <option key={s} value={s}>{s}</option>)}
                   </select>
                </div>
             </div>

             <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                 {/* Top Combinations */}
                 <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                    <h4 className="font-black text-gray-900 mb-4 flex items-center gap-2">🔥 En Çok Satan Kombinasyonlar</h4>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-100">
                                   <th className="py-2">Materyal</th>
                                   <th className="py-2">Model</th>
                                   <th className="py-2">Ölçü</th>
                                   <th className="py-2 text-right">Satış (Adet)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {advancedAnalysis.comboList.slice(0, 10).map(c => (
                                    <tr key={c.key} className="hover:bg-gray-50">
                                        <td className="py-2.5 font-bold text-gray-800">{c.material}</td>
                                        <td className="py-2.5 text-gray-600">{c.model}</td>
                                        <td className="py-2.5 font-mono text-xs text-gray-500">{c.size}</td>
                                        <td className="py-2.5 text-right font-black text-primary">{c.soldQty}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                 </div>

                 {/* Dead/Low Demand Stock */}
                 <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                    <h4 className="font-black text-gray-900 mb-4 flex items-center gap-2">⚠️ Yavaş Giden veya Talep Görmeyenler</h4>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-100">
                                   <th className="py-2">Materyal / Model</th>
                                   <th className="py-2 text-center">Ölçü</th>
                                   <th className="py-2 text-right">Mevcut Stok</th>
                                   <th className="py-2 text-right">Satış (Adet)</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {advancedAnalysis.lowDemand.slice(0, 10).map(c => (
                                    <tr key={c.key} className="hover:bg-gray-50">
                                        <td className="py-2.5 font-bold text-gray-800">{c.material} <span className="font-normal text-gray-500">- {c.model}</span></td>
                                        <td className="py-2.5 font-mono text-center text-xs text-gray-500">{c.size}</td>
                                        <td className="py-2.5 text-right font-black text-red-500">{c.stock}</td>
                                        <td className="py-2.5 text-right font-black text-gray-600">{c.soldQty}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                 </div>
                 
                 {/* Cross Matrix - Material x Model */}
                 <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 xl:col-span-2">
                     <h4 className="font-black text-gray-900 mb-4 flex items-center gap-2"><Filter className="w-4 h-4 text-gray-500" /> Materyal × Model Performansı</h4>
                     <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-100">
                                   <th className="py-2">Materyal</th>
                                   <th className="py-2">Model</th>
                                   <th className="py-2 text-right">Satış (Adet)</th>
                                   <th className="py-2 text-right">Mevcut Stok</th>
                                   <th className="py-2 text-right">Stok Erim Hızı</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {advancedAnalysis.matModList.map((m, idx) => {
                                   const velocity = m.stock > 0 ? ((m.soldQty / m.stock) * 100).toFixed(1) : (m.soldQty > 0 ? '>100' : '0');
                                   return (
                                     <tr key={`${m.material}-${m.model}-${idx}`} className="hover:bg-gray-50">
                                         <td className="py-3 font-bold text-gray-900">{m.material}</td>
                                         <td className="py-3 font-medium text-gray-700">{m.model}</td>
                                         <td className="py-3 text-right font-black text-primary">{m.soldQty}</td>
                                         <td className="py-3 text-right font-black text-gray-600">{m.stock}</td>
                                         <td className="py-3 text-right">
                                            <span className={cn("px-2 py-1 rounded-lg text-xs font-bold", 
                                               m.soldQty > m.stock ? "bg-red-100 text-red-700" :
                                               (parseFloat(velocity) > 50 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700")
                                            )}>
                                               {m.soldQty > m.stock ? "Yetersiz Stok!" : `%${velocity}`}
                                            </span>
                                         </td>
                                     </tr>
                                   );
                                })}
                            </tbody>
                        </table>
                     </div>
                 </div>

                 {/* Cross Matrix - Material x Size */}
                 <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 xl:col-span-2">
                     <h4 className="font-black text-gray-900 mb-4 flex items-center gap-2"><Filter className="w-4 h-4 text-gray-500" /> Materyal × Ölçü Talebi (Hangi ölçü hangi materyalde daha çok isteniyor?)</h4>
                     <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-100">
                                   <th className="py-2">Materyal</th>
                                   <th className="py-2">Ölçü</th>
                                   <th className="py-2 text-right">Satış (Adet)</th>
                                   <th className="py-2 text-right">Mevcut Stok</th>
                                   <th className="py-2 text-right">Talep / Stok Oranı</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {advancedAnalysis.matSzList.map((m, idx) => {
                                   const velocity = m.stock > 0 ? ((m.soldQty / m.stock) * 100).toFixed(1) : (m.soldQty > 0 ? '>100' : '0');
                                   return (
                                     <tr key={`${m.material}-${m.size}-${idx}`} className="hover:bg-gray-50">
                                         <td className="py-3 font-bold text-gray-900">{m.material}</td>
                                         <td className="py-3 font-mono text-gray-600">{m.size}</td>
                                         <td className="py-3 text-right font-black text-blue-600">{m.soldQty}</td>
                                         <td className="py-3 text-right font-black text-gray-600">{m.stock}</td>
                                         <td className="py-3 text-right">
                                            <span className={cn("px-2 py-1 rounded-lg text-xs font-bold", 
                                               m.soldQty > m.stock ? "bg-red-100 text-red-700" :
                                               (parseFloat(velocity) > 50 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700")
                                            )}>
                                               {m.soldQty > m.stock ? "Yetersiz Stok!" : `%${velocity}`}
                                            </span>
                                         </td>
                                     </tr>
                                   );
                                })}
                            </tbody>
                        </table>
                     </div>
                 </div>
                 
                 {/* Top Sizes Regardless of Material */}
                 <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 xl:col-span-2">
                     <h4 className="font-black text-gray-900 mb-4 flex items-center gap-2"><Filter className="w-4 h-4 text-gray-500" /> Genel Ölçü Trendleri (Materyal Bağımsız)</h4>
                     <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-100">
                                   <th className="py-2">Ölçü</th>
                                   <th className="py-2 text-right">Satış (Adet)</th>
                                   <th className="py-2 text-right">Mevcut Stok</th>
                                   <th className="py-2 text-right">Ciro</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                                {advancedAnalysis.sizeList.map((s, idx) => (
                                     <tr key={`${s.size}-${idx}`} className="hover:bg-gray-50">
                                         <td className="py-3 font-mono text-gray-900">{s.size}</td>
                                         <td className="py-3 text-right font-black text-gray-800">{s.soldQty}</td>
                                         <td className="py-3 text-right font-bold text-gray-500">{s.stock}</td>
                                         <td className="py-3 text-right font-bold text-green-600"><FormatAmount amount={s.revenue} /></td>
                                     </tr>
                                ))}
                            </tbody>
                        </table>
                     </div>
                 </div>
             </div>
           </div>
        </div>
      )}

      {activeTab === 'platform' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="card p-6">
                 <h3 className="font-bold text-lg text-gray-900 mb-6">Platform Ciro Dağılımı</h3>
                 <div className="h-[300px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={platformStats}
                          innerRadius={70}
                          outerRadius={90}
                          paddingAngle={5}
                          dataKey="revenue"
                          nameKey="platform"
                          label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}
                        >
                          {platformStats.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                 </div>
              </div>
              <div className="card p-6">
                 <h3 className="font-bold text-lg text-gray-900 mb-6">Platform Karlılık Tablosu</h3>
                 <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse whitespace-nowrap min-w-[800px]">
                       <thead>
                         <tr className="border-b border-gray-100">
                           <th className="py-3 font-bold text-sm text-gray-500">Platform</th>
                           <th className="py-3 font-bold text-sm text-gray-500 text-right">Sipariş</th>
                           <th className="py-3 font-bold text-sm text-gray-500 text-right">Ciro</th>
                           <th className="py-3 font-bold text-sm text-gray-500 text-right">Tahmini Komisyon</th>
                           <th className="py-3 font-bold text-sm text-gray-500 text-right">Kar Marjı</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-gray-50">
                         {platformStats.map((p, i) => (
                           <tr key={p.platform} className="hover:bg-gray-50">
                              <td className="py-4 font-bold text-gray-900 flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }}></div>
                                {p.platform}
                              </td>
                              <td className="py-4 text-right text-sm">{p.count}</td>
                              <td className="py-4 text-right text-sm font-semibold"><FormatAmount align="right" amount={p.revenue} /></td>
                              <td className="py-4 text-right text-sm text-gray-500"><FormatAmount align="right" amount={p.commission} /></td>
                              <td className="py-4 text-right text-sm">
                                <span className={cn("px-2 py-1 rounded-md font-bold text-xs", p.margin >= 15 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
                                  %{p.margin.toFixed(1)}
                                </span>
                              </td>
                           </tr>
                         ))}
                       </tbody>
                    </table>
                 </div>
              </div>
           </div>
        </div>
      )}

      {activeTab === 'cashflow' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 card p-6">
                <h3 className="font-bold text-lg text-gray-900 mb-6">Aylık Nakit Akışı Kapsamı</h3>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={cashFlowMonthly}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748B' }} />
                      <Tooltip cursor={{ fill: '#f8fafc' }} contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                      <Legend />
                      <Bar dataKey="in" name="Nakit Giriş" fill="#4B5563" radius={[4, 4, 0, 0]} stackId="a" />
                      <Bar dataKey="out" name="Nakit Çıkış" fill="#FCA5A5" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="card p-6">
                 <h3 className="font-bold text-lg text-gray-900 mb-6">Kasa ve Bekleyen Analizi</h3>
                 <div className="space-y-6">
                    <div>
                       <h4 className="text-sm font-bold text-gray-400 mb-3 uppercase tracking-wider">Nakit ve Banka</h4>
                       <div className="space-y-3">
                          {cashAccounts.filter(c => c.type !== 'platform').map(c => {
                             const balance = c.opening_balance + c.total_in - c.total_out;
                             return (
                               <div key={c.id} className="p-3 rounded-xl border border-gray-100 bg-gray-50 flex justify-between items-center">
                                  <span className="text-sm font-bold text-gray-700">{c.name}</span>
                                  <span className="text-base font-black text-gray-900">
                                     {c.currency === 'TRY' ? <FormatAmount amount={balance} /> : `${balance.toFixed(2)} ${c.currency}`}
                                  </span>
                               </div>
                             );
                          })}
                       </div>
                    </div>
                    <div>
                       <h4 className="text-sm font-bold text-gray-400 mb-3 uppercase tracking-wider">Platformdaki Bekleyenler</h4>
                       <div className="space-y-3">
                          {cashAccounts.filter(c => c.type === 'platform').map(c => {
                             const balance = c.opening_balance + c.total_in - c.total_out;
                             return (
                               <div key={c.id} className="p-3 rounded-xl border border-orange-100 bg-orange-50 flex justify-between items-center">
                                  <span className="text-sm font-bold text-orange-800">{c.name}</span>
                                  <span className="text-base font-black text-orange-900">
                                     {c.currency === 'TRY' ? <FormatAmount amount={balance} /> : `${balance.toFixed(2)} ${c.currency}`}
                                  </span>
                               </div>
                             );
                          })}
                       </div>
                    </div>
                 </div>
              </div>
           </div>
        </div>
      )}

      {activeTab === 'risk' && (
        <div className="space-y-6 animate-in slide-in-from-bottom-2">
           <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="card border-l-4 border-l-orange-500 p-6">
                 <div className="flex items-center gap-3 mb-4">
                    <AlertTriangle className="w-6 h-6 text-orange-500" />
                    <h3 className="font-bold text-lg text-gray-900">Kritik Stok Uyarısı</h3>
                 </div>
                 <p className="text-sm text-gray-600 mb-4">Stok seviyesi belirlenen kritik limitin altına düşen ürünler.</p>
                 <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                    {riskStats.filter(p => p.isCritical).map(p => (
                       <div key={p.id} className="flex justify-between items-center p-3 bg-orange-50 rounded-lg">
                          <div>
                            <p className="text-sm font-bold text-gray-900">{p.title}</p>
                            <p className="text-xs text-orange-600 font-medium">Stok: {p.totalStock} Adet</p>
                          </div>
                       </div>
                    ))}
                    {riskStats.filter(p => p.isCritical).length === 0 && (
                      <p className="text-xs text-gray-500">Tüm ürünlerin stoku yeterli seviyede.</p>
                    )}
                 </div>
              </div>
              
              <div className="card border-l-4 border-l-red-500 p-6">
                 <div className="flex items-center gap-3 mb-4">
                    <TrendingDown className="w-6 h-6 text-red-500" />
                    <h3 className="font-bold text-lg text-gray-900">Hareketsiz Ürünler</h3>
                 </div>
                 <p className="text-sm text-gray-600 mb-4">Son 30 gündür satışı gerçekleşmeyen stoklu ürünler.</p>
                 <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                    {riskStats.filter(p => p.isDead).map(p => (
                       <div key={p.id} className="flex justify-between items-center p-3 bg-red-50 rounded-lg">
                          <div>
                            <p className="text-sm font-bold text-gray-900">{p.title}</p>
                            <p className="text-xs text-red-600 font-medium">Son Satış: {p.lastSale ? p.lastSale.toLocaleDateString('tr-TR') : 'Hiç satılmadı'}</p>
                          </div>
                       </div>
                    ))}
                    {riskStats.filter(p => p.isDead).length === 0 && (
                      <p className="text-xs text-gray-500">Hareketsiz ürün bulunmuyor.</p>
                    )}
                 </div>
              </div>

              <div className="card border-l-4 border-l-purple-500 p-6">
                 <div className="flex items-center gap-3 mb-4">
                    <Activity className="w-6 h-6 text-purple-500" />
                    <h3 className="font-bold text-lg text-gray-900">Zararına Satışlar</h3>
                 </div>
                 <p className="text-sm text-gray-600 mb-4">Birim maliyet + komisyon yükü, satış fiyatını aşan ürünler.</p>
                 <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                    {riskStats.filter(p => p.isLosingMoney).map(p => (
                       <div key={p.id} className="flex justify-between items-center p-3 bg-purple-50 rounded-lg">
                          <div>
                            <p className="text-sm font-bold text-gray-900">{p.title}</p>
                            <p className="text-xs text-purple-600 font-medium whitespace-nowrap">Marj: %{p.margin.toFixed(1)} <br/>(<FormatAmount amount={p.profit} />)</p>
                          </div>
                       </div>
                    ))}
                    {riskStats.filter(p => p.isLosingMoney).length === 0 && (
                      <p className="text-xs text-gray-500">Zararına satan ürün tespit edilmedi.</p>
                    )}
                 </div>
              </div>
           </div>
        </div>
      )}

    </div>
  );
}

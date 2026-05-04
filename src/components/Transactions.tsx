import { useState, useEffect } from 'react';
import { 
  TrendingUp, 
  Search, 
  Package,
} from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { Settings } from '../types';

export default function Transactions({ initialType, settings }: { initialType?: 'Income' | 'Expense', settings?: Settings | null }) {
  const { FormatAmount } = useCurrency();
  const [sales, setSales] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const finalStatuses = new Set(['İptal Edildi', 'İade Edildi']);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await api.get('/sales');
      setSales(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const activeSales = sales.filter((sale) => !finalStatuses.has(sale.status));
  const totalIncome = activeSales.reduce((sum, s) => sum + (s.net_total || s.total_amount || 0), 0);

  const filteredSales = activeSales.filter(s =>
    s.customer_name?.toLowerCase().includes(filterQuery.toLowerCase()) || 
    s.platform?.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-[#0F172A] tracking-tight">
            Gelir Raporu
          </h2>
          <p className="text-xs lg:text-sm text-[#64748B]">
            Satışlardan elde edilen gelirleri listeleyin. Manuel gelir girişi kapatılmıştır.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl p-6 border border-[#E2E8F0] flex items-center justify-between shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          <div>
            <div className="text-xs lg:text-sm font-bold text-[#64748B] mb-1">Toplam Net Ciro</div>
            <div className="text-2xl lg:text-3xl font-black text-[#10B981]"><FormatAmount amount={totalIncome} /></div>
            <div className="mt-1 text-[11px] font-bold text-gray-400">İptal ve iade satışlar hariç</div>
          </div>
          <div className="w-12 h-12 rounded-2xl bg-green-50 flex items-center justify-center">
            <TrendingUp className="w-6 h-6 text-[#10B981]" />
          </div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-[#E2E8F0] flex items-center justify-between shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
           <div>
            <div className="text-xs lg:text-sm font-bold text-[#64748B] mb-1">Toplam Satış Adedi</div>
            <div className="text-2xl lg:text-3xl font-black text-primary">{activeSales.length}</div>
          </div>
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Package className="w-6 h-6 text-primary" />
          </div>
        </div>
      </div>

      {/* FILTER */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="p-4 border-b border-gray-100 flex items-center gap-4 bg-gray-50/50">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input 
              type="text"
              placeholder="Müşteri veya Platform Ara..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[800px]">
            <thead className="bg-[#F8FAFC] text-[#64748B] font-bold text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Satış Tarihi</th>
                <th className="px-6 py-4">Müşteri</th>
                <th className="px-6 py-4">Platform</th>
                <th className="px-6 py-4 text-center">Toplam Adet</th>
                <th className="px-6 py-4 text-right">Tutar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] bg-white">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">Yükleniyor...</td>
                </tr>
              ) : filteredSales.map(sale => (
                <tr key={sale.id} className="hover:bg-gray-50/50">
                   <td className="px-6 py-4 font-mono text-xs text-gray-500">
                     {new Date(sale.created_at).toLocaleString('tr-TR')}
                   </td>
                   <td className="px-6 py-4 font-semibold text-gray-800">
                     {sale.customer_name}
                   </td>
                   <td className="px-6 py-4 text-gray-600 font-medium">
                     {sale.platform || 'Satış Sistemi'}
                   </td>
                   <td className="px-6 py-4 text-center font-bold text-gray-600">
                     {sale.total_quantity}
                   </td>
                   <td className="px-6 py-4 text-right font-black text-[#10B981]">
                     <FormatAmount align="right" amount={sale.net_total || sale.total_amount} exchangeRateAtTransaction={sale.exchange_rate_at_transaction} />
                   </td>
                </tr>
              ))}
              {!loading && filteredSales.length === 0 && (
                <tr>
                   <td colSpan={5} className="px-6 py-8 text-center text-gray-500">Gelir kaydı bulunamadı.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

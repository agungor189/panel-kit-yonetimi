import React, { useMemo, useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { CalendarDays, Search, Truck, User } from 'lucide-react';
import { useCurrency } from '../../CurrencyContext';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const finalStatuses = ['İptal Edildi', 'İade Edildi'];
type PeriodFilter = 'all' | 'this_month' | 'last_month' | 'last_3_months';

const periodOptions: { key: PeriodFilter; label: string }[] = [
  { key: 'all', label: 'Tümü' },
  { key: 'this_month', label: 'Bu Ay' },
  { key: 'last_month', label: 'Geçen Ay' },
  { key: 'last_3_months', label: 'Son 3 Ay' },
];

const getPeriodRange = (period: PeriodFilter) => {
  const now = new Date();
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  if (period === 'this_month') {
    return { start: startOfThisMonth, end: null as Date | null };
  }

  if (period === 'last_month') {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: startOfThisMonth,
    };
  }

  if (period === 'last_3_months') {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 3);
    start.setHours(0, 0, 0, 0);
    return { start, end: null as Date | null };
  }

  return { start: null as Date | null, end: null as Date | null };
};

const matchesPeriod = (sale: any, period: PeriodFilter) => {
  const { start, end } = getPeriodRange(period);
  if (!start && !end) return true;
  const saleDate = new Date(sale.created_at || sale.date || 0);
  if (Number.isNaN(saleDate.getTime())) return false;
  if (start && saleDate < start) return false;
  if (end && saleDate >= end) return false;
  return true;
};

const normalizeSearchText = (value: unknown) => String(value || '').toLocaleLowerCase('tr-TR');

const getSaleStatusClass = (status?: string) => {
  switch (status) {
    case 'Hazırlanıyor':
      return 'border border-amber-200 bg-amber-100 text-amber-700';
    case 'Gönderildi':
      return 'border border-blue-200 bg-blue-100 text-blue-700';
    case 'Tamamlandı':
      return 'border border-emerald-200 bg-emerald-100 text-emerald-700';
    case 'İptal Edildi':
      return 'border border-slate-300 bg-slate-200 text-slate-700';
    case 'İade Edildi':
      return 'border border-red-200 bg-red-100 text-red-700';
    default:
      return 'border border-gray-200 bg-gray-100 text-gray-700';
  }
};

export default function SalesList({ refreshKey = 0, onSaleClick }: { refreshKey?: number; onSaleClick?: (sale: any) => void }) {
  const { FormatAmount } = useCurrency();
  const [sales, setSales] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('this_month');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadSales();
  }, [refreshKey]);

  const loadSales = async () => {
    try {
      const data = await api.get('/sales');
      setSales(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filteredSales = useMemo(() => {
    const query = normalizeSearchText(searchQuery.trim());
    return sales.filter((sale) => {
      if (!matchesPeriod(sale, periodFilter)) return false;
      if (!query) return true;

      const searchable = [
        sale.order_code,
        sale.external_order_id,
        sale.id,
        sale.customer_name,
        sale.customer_phone,
        sale.tracking_number,
        sale.platform,
      ].map(normalizeSearchText).join(' ');

      return searchable.includes(query);
    });
  }, [periodFilter, sales, searchQuery]);

  if (loading) {
    return <div className="p-8 text-center text-text-muted font-semibold">Yükleniyor...</div>;
  }

  return (
    <div className="bg-white rounded-3xl shadow-lg border border-border-color overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-border-color bg-bg-main/40 px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Sipariş kodu veya platform sipariş no ara..."
            className="w-full rounded-2xl border border-gray-200 bg-white py-3 pl-10 pr-4 text-sm font-semibold text-text-main outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-1 hidden items-center gap-2 text-xs font-black uppercase tracking-wider text-text-muted sm:flex">
            <CalendarDays className="h-4 w-4" />
            Dönem
          </div>
          {periodOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setPeriodFilter(option.key)}
              className={cn(
                "rounded-xl px-3 py-2 text-xs font-black transition-colors",
                periodFilter === option.key
                  ? "bg-primary text-white shadow-sm"
                  : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left min-w-[1120px]">
          <thead className="bg-bg-main/50 text-text-muted font-bold text-[11px] uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4">Sipariş Kodu</th>
              <th className="px-6 py-4">Müşteri</th>
              <th className="px-6 py-4">Kargo Firması</th>
              <th className="px-6 py-4 text-center">Platform</th>
              <th className="px-6 py-4 text-center">Net Kar</th>
              <th className="px-6 py-4 text-center">Toplam Adet</th>
              <th className="px-6 py-4 text-center">Ağırlık</th>
              <th className="px-6 py-4 text-center">Toplam Tutar</th>
              <th className="px-6 py-4">Tarih</th>
              <th className="px-6 py-4">Durum</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-color">
            {filteredSales.map((sale) => {
              const isFinal = finalStatuses.includes(sale.status);
              return (
                <tr
                  key={sale.id}
                  onClick={() => onSaleClick && onSaleClick(sale)}
                  className="hover:bg-bg-main/50 transition-colors cursor-pointer"
                >
                  <td className="px-6 py-4">
                    <span className="inline-flex rounded-xl bg-slate-900 px-3 py-1.5 font-mono text-xs font-black tracking-wide text-white shadow-sm">
                      {sale.order_code || sale.id?.slice(0, 8)?.toUpperCase()}
                    </span>
                    {sale.external_order_id && (
                      <div className="mt-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
                        Platform: {sale.external_order_id}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-bold text-text-main flex items-center gap-2">
                      <User className="w-4 h-4 text-primary" /> {sale.customer_name}
                    </div>
                    <div className="text-xs text-text-muted mt-1">{sale.customer_phone}</div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-semibold text-text-main flex items-center gap-2">
                      <Truck className="w-4 h-4 text-gray-400" /> {sale.shipping_company || '-'}
                    </div>
                    {sale.tracking_number && <div className="text-xs text-primary mt-1">{sale.tracking_number}</div>}
                  </td>
                  <td className="px-6 py-4 text-center font-bold text-gray-800">
                    {sale.platform || 'Satış Sistemi'}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className={cn(
                      "font-bold px-3 py-1 rounded-lg",
                      isFinal || sale.net_profit < 0 ? "bg-red-100 text-red-700" : sale.net_profit > 0 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                    )}>
                      {sale.net_profit ? <FormatAmount amount={sale.net_profit} exchangeRateAtTransaction={sale.exchange_rate_at_transaction} /> : '0,00 ₺'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-center font-bold text-gray-800">
                    {sale.total_quantity}
                  </td>
                  <td className="px-6 py-4 text-center text-xs text-text-muted font-bold">
                    {sale.total_weight ? `${sale.total_weight.toFixed(2)} kg` : '-'}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className="font-bold text-primary bg-primary/10 px-3 py-1 rounded-lg">
                      {sale.total_amount ? <FormatAmount amount={sale.total_amount} exchangeRateAtTransaction={sale.exchange_rate_at_transaction} /> : '0,00 ₺'}
                    </span>
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-text-muted">
                    {new Date(sale.created_at).toLocaleString('tr-TR')}
                  </td>
                  <td className="px-6 py-4">
                    <span className={cn(
                      "inline-flex items-center justify-center rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-wider",
                      getSaleStatusClass(sale.status)
                    )}>
                      {sale.status || 'Hazırlanıyor'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {filteredSales.length === 0 && (
              <tr>
                <td colSpan={10} className="px-6 py-8 text-center text-text-muted font-medium">
                  {sales.length === 0 ? 'Henüz satış kaydı bulunmamaktadır.' : 'Bu filtrelere uygun sipariş bulunamadı.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

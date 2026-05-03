import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { Package, Truck, User } from 'lucide-react';
import { useCurrency } from '../../CurrencyContext';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const finalStatuses = ['İptal Edildi', 'İade Edildi'];

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

  if (loading) {
    return <div className="p-8 text-center text-text-muted font-semibold">Yükleniyor...</div>;
  }

  return (
    <div className="bg-white rounded-3xl shadow-lg border border-border-color overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left min-w-[1000px]">
          <thead className="bg-bg-main/50 text-text-muted font-bold text-[11px] uppercase tracking-wider">
            <tr>
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
            {sales.map((sale) => {
              const isFinal = finalStatuses.includes(sale.status);
              return (
                <tr
                  key={sale.id}
                  onClick={() => onSaleClick && onSaleClick(sale)}
                  className="hover:bg-bg-main/50 transition-colors cursor-pointer"
                >
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
            {sales.length === 0 && (
              <tr>
                <td colSpan={9} className="px-6 py-8 text-center text-text-muted font-medium">
                  Henüz satış kaydı bulunmamaktadır.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

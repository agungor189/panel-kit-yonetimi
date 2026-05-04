import React, { useEffect, useState } from 'react';
import { dashboardApi } from '../dashboardApi';
import { useCurrency } from '../../../CurrencyContext';

export function PaymentSummaryWidget({ widgetKey, refreshKey, periodParams }: any) {
  const { FormatAmount } = useCurrency();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [refreshKey, widgetKey, periodParams?.dateFrom, periodParams?.dateTo]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await dashboardApi.getPaymentSummary(periodParams);
      setData(res);
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="animate-pulse bg-gray-100 rounded-lg h-16 w-full"></div>;
  if (!data) return <div className="text-gray-400 text-sm">Bulunamadı</div>;

  let val: React.ReactNode = 0;
  if (widgetKey === 'payment_month_pending_count') val = <div className="text-3xl font-black text-gray-900">{data.pending_count || 0} <span className="text-sm font-medium text-gray-500">adet</span></div>;
  if (widgetKey === 'payment_month_pending_amount') val = <div className="text-3xl font-black text-amber-600"><FormatAmount amount={data.pending_amount || 0} /></div>;
  if (widgetKey === 'payment_auto_process_count') val = <div className="text-3xl font-black text-blue-600">{data.auto_process_count || 0} <span className="text-sm font-medium text-gray-500">adet</span></div>;
  if (widgetKey === 'payment_overdue_count') val = <div className="text-3xl font-black text-red-600">{data.overdue_count || 0} <span className="text-sm font-medium text-gray-500">adet</span></div>;
  if (widgetKey === 'payment_processed_count') val = <div className="text-3xl font-black text-emerald-600">{data.processed_count || 0} <span className="text-sm font-medium text-gray-500">adet</span></div>;

  return (
    <div className="flex flex-col justify-center h-full pt-2">
      {val}
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { dashboardApi } from '../dashboardApi';
import { useCurrency } from '../../../CurrencyContext';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#64748b'];

export function ProductAnalysisChartWidget({ widgetKey, refreshKey, type, periodParams }: any) {
  const { FormatAmount } = useCurrency();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [refreshKey, widgetKey, periodParams?.dateFrom, periodParams?.dateTo]);

  const loadData = async () => {
    setLoading(true);
    try {
      if (widgetKey === 'product_total_sold' || widgetKey === 'product_total_revenue') {
        const res = await dashboardApi.getProductSummary(periodParams);
        setData(res);
      } else if (widgetKey === 'product_top_material' || widgetKey === 'product_material_pie') {
        const res = await dashboardApi.getProductMaterialShare({ ...periodParams, limit: 10 });
        setData(res);
      } else if (widgetKey === 'product_top_model' || widgetKey === 'product_model_pie') {
        const res = await dashboardApi.getProductModelShare({ ...periodParams, limit: 10 });
        setData(res);
      } else if (widgetKey === 'product_reorder_summary') {
        const res = await dashboardApi.getProductReorderSummary();
        setData(res);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="animate-pulse bg-gray-100 rounded-lg h-16 w-full"></div>;
  if (!data) return <div className="text-gray-400 text-sm">Bulunamadı</div>;

  if (type === 'kpi') {
    let val: React.ReactNode = 0;
    if (widgetKey === 'product_total_sold') {
      val = <div className="text-3xl font-black text-gray-900">{data.total_sold || 0} <span className="text-sm font-medium text-gray-500">adet</span></div>;
    } else if (widgetKey === 'product_total_revenue') {
      val = <div className="text-3xl font-black text-emerald-600"><FormatAmount amount={data.total_revenue || 0} /></div>;
    } else if (widgetKey === 'product_top_material') {
      const best = Array.isArray(data) && data.length > 0 ? data[0] : null;
      val = best ? (
        <div>
          <div className="text-2xl font-black text-gray-900 truncate" title={best.name}>{best.name}</div>
          <div className="text-sm font-bold text-gray-500">{best.value} adet satıldı</div>
        </div>
      ) : <div className="text-sm">Veri Yok</div>;
    } else if (widgetKey === 'product_top_model') {
       const best = Array.isArray(data) && data.length > 0 ? data[0] : null;
       val = best ? (
         <div>
           <div className="text-2xl font-black text-gray-900 truncate" title={best.name}>{best.name}</div>
           <div className="text-sm font-bold text-gray-500">{best.value} adet satıldı</div>
         </div>
       ) : <div className="text-sm">Veri Yok</div>;
    } else if (widgetKey === 'product_reorder_summary') {
       val = (
         <div className="grid grid-cols-2 gap-4 mt-2">
            <div>
               <div className="text-xs font-bold text-gray-500 mb-1 leading-none uppercase tracking-wider">Kritik Ürün</div>
               <div className="text-2xl font-black text-red-600 leading-none">{data.critical_count || 0}</div>
            </div>
            <div>
               <div className="text-xs font-bold text-gray-500 mb-1 leading-none uppercase tracking-wider">Sipariş Önerisi</div>
               <div className="text-2xl font-black text-amber-500 leading-none">{data.suggested_order_qty || 0}</div>
            </div>
         </div>
       );
    }
    return <div className="flex flex-col justify-center h-full pt-1">{val}</div>;
  }

  if (type === 'pie') {
     if (!Array.isArray(data) || data.length === 0) return <div className="text-sm text-gray-400 p-4">Satış verisi yok.</div>;
     return (
       <div className="h-48 w-full mt-2">
         <ResponsiveContainer width="100%" height="100%">
           <PieChart>
             <Pie
               data={data}
               cx="50%"
               cy="50%"
               innerRadius={40}
               outerRadius={70}
               paddingAngle={2}
               dataKey="value"
               nameKey="name"
             >
               {data.map((entry: any, index: number) => (
                 <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
               ))}
             </Pie>
             <Tooltip 
               formatter={(value: any) => [`${value} adet`, 'Satış']}
               contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' }}
             />
             <Legend layout="horizontal" verticalAlign="bottom" align="center" wrapperStyle={{ fontSize: '10px', fontWeight: 600, paddingTop: '10px' }} />
           </PieChart>
         </ResponsiveContainer>
       </div>
     );
  }

  return null;
}

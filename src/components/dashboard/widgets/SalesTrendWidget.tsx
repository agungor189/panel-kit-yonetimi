import React, { useEffect, useState } from 'react';
import { dashboardApi } from '../dashboardApi';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

export function SalesTrendWidget({ refreshKey, periodParams }: any) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [refreshKey, periodParams?.dateFrom, periodParams?.dateTo]);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await dashboardApi.getProductSalesTrend(periodParams);
      
      // format dates
      const formatted = (res||[]).map((d: any) => ({
         name: new Date(d.name).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }),
         value: d.value
      }));
      setData(formatted);
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="space-y-3 pt-2">
    <div className="animate-pulse bg-gray-100 rounded-lg h-32 w-full"></div>
  </div>;

  if (data.length === 0) return <div className="text-gray-400 text-sm py-4 text-center">Satış verisi bulunmuyor.</div>;

  return (
    <div className="h-48 w-full mt-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
          <XAxis 
            dataKey="name" 
            axisLine={false} 
            tickLine={false} 
            tick={{ fontSize: 10, fill: '#6B7280' }} 
            dy={10} 
          />
          <YAxis 
            axisLine={false} 
            tickLine={false} 
            tick={{ fontSize: 10, fill: '#6B7280' }} 
            dx={-10}
          />
          <Tooltip
            contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)' }}
            labelStyle={{ fontWeight: 'bold', color: '#111827', marginBottom: '4px' }}
            formatter={(value: number) => [`${value} Adet`, 'Satış']}
          />
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke="#3b82f6" 
            strokeWidth={3} 
            dot={false}
            activeDot={{ r: 6, fill: '#3b82f6', stroke: '#fff', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

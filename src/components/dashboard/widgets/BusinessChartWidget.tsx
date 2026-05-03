import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useCurrency } from '../../../CurrencyContext';

type Summary = {
  charts?: {
    monthlyData?: any[];
    platformRevenue?: any[];
  };
};

export function BusinessChartWidget({ widgetKey, summary }: { widgetKey: string; summary: Summary | null }) {
  const { FormatAmount } = useCurrency();

  if (widgetKey === 'dashboard_monthly_profit_chart') {
    const data = summary?.charts?.monthlyData || [];
    if (data.length === 0) return <div className="py-10 text-center text-sm font-bold text-slate-400">Trend verisi yok.</div>;

    return (
      <div className="h-full min-h-[250px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 12, left: -10, bottom: 4 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#64748b', fontWeight: 700 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#64748b', fontWeight: 700 }} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(value: any, name: string) => [
                <FormatAmount amount={Number(value) || 0} />,
                name === 'income' ? 'Gelir' : name === 'expense' ? 'Gider' : 'Kâr',
              ]}
              contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)' }}
            />
            <Legend wrapperStyle={{ fontSize: 11, fontWeight: 800 }} />
            <Line type="monotone" dataKey="income" name="Gelir" stroke="#10b981" strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey="expense" name="Gider" stroke="#ef4444" strokeWidth={3} dot={false} />
            <Line type="monotone" dataKey="profit" name="Kâr" stroke="#2563eb" strokeWidth={3} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (widgetKey === 'dashboard_platform_revenue_chart') {
    const data = (summary?.charts?.platformRevenue || []).filter((item: any) => item.platform && Number(item.total) > 0);
    if (data.length === 0) return <div className="py-10 text-center text-sm font-bold text-slate-400">Platform cirosu yok.</div>;

    return (
      <div className="h-full min-h-[250px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 12, left: -10, bottom: 4 }}>
            <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" vertical={false} />
            <XAxis dataKey="platform" tick={{ fontSize: 11, fill: '#64748b', fontWeight: 700 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11, fill: '#64748b', fontWeight: 700 }} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(value: any) => [<FormatAmount amount={Number(value) || 0} />, 'Ciro']}
              contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.12)' }}
            />
            <Bar dataKey="total" fill="#2563eb" radius={[8, 8, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return <div className="text-sm text-slate-400">Grafik bulunamadı.</div>;
}

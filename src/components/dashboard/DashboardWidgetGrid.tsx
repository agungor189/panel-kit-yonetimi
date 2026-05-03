import React, { useState, useEffect } from 'react';
import { dashboardApi } from './dashboardApi';
import { WidgetSettingsModal } from './WidgetSettingsModal';
import { Settings, RefreshCw } from 'lucide-react';
import { PaymentSummaryWidget } from './widgets/PaymentSummaryWidget';
import { ProductAnalysisChartWidget } from './widgets/ProductAnalysisChartWidget';
import { SalesTrendWidget } from './widgets/SalesTrendWidget';
import { UpcomingPaymentsWidget } from './widgets/UpcomingPaymentsWidget';
import { useAuth } from '../../App';

export function DashboardWidgetGrid() {
  const { isReadOnly } = useAuth();
  const [widgets, setWidgets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    loadWidgets();
  }, []);

  const loadWidgets = async () => {
    setLoading(true);
    try {
      const data = await dashboardApi.getWidgets();
      setWidgets(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSettings = async (newWidgets: any[]) => {
    if (isReadOnly) return;
    // Determine which are totally new
    const toCreate = newWidgets.filter(w => w.id && w.id.startsWith('new_'));
    const toUpdate = newWidgets.filter(w => w.id && !w.id.startsWith('new_'));

    setShowSettings(false);
    setLoading(true);

    try {
      // Create new ones
      for (const w of toCreate) {
        await dashboardApi.updateWidgets([{...w, id: undefined}]);
      }
      
      // Update existing ones
      if (toUpdate.length > 0) {
        await dashboardApi.updateWidgets(toUpdate);
      }
      
      await loadWidgets();
      setRefreshKey(k => k + 1);
    } catch(e) {
      console.error(e);
      setLoading(false);
    }
  };

  const renderWidget = (w: any) => {
    const sizeClasses = {
      'small': 'col-span-1',
      'medium': 'col-span-1 md:col-span-2 lg:col-span-2',
      'large': 'col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4',
      'full': 'col-span-1 md:col-span-3 lg:col-span-4 xl:col-span-6' // Depends on the grid grid-cols
    };
    const colClass = sizeClasses[w.size as keyof typeof sizeClasses] || 'col-span-1';

    return (
      <div key={w.id} className={`${colClass} bg-white rounded-2xl shadow-sm border border-gray-100 p-4 transition-all hover:shadow-md flex flex-col`}>
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-gray-900 leading-tight">{w.title}</h3>
        </div>
        <div className="flex-1 min-h-[100px] relative">
          {w.widget_key.startsWith('payment_month_pending') && <PaymentSummaryWidget widgetKey={w.widget_key} refreshKey={refreshKey} />}
          {w.widget_key.startsWith('payment_auto_') && <PaymentSummaryWidget widgetKey={w.widget_key} refreshKey={refreshKey} />}
          {w.widget_key.startsWith('payment_overdue') && <PaymentSummaryWidget widgetKey={w.widget_key} refreshKey={refreshKey} />}
          {w.widget_key.startsWith('payment_processed') && <PaymentSummaryWidget widgetKey={w.widget_key} refreshKey={refreshKey} />}
          
          {w.widget_key === 'payment_upcoming_list' && <UpcomingPaymentsWidget refreshKey={refreshKey} />}
          
          {w.widget_key.startsWith('product_total') && <ProductAnalysisChartWidget widgetKey={w.widget_key} refreshKey={refreshKey} type="kpi" />}
          {w.widget_key.startsWith('product_top') && <ProductAnalysisChartWidget widgetKey={w.widget_key} refreshKey={refreshKey} type="kpi" />}
          {w.widget_key.startsWith('product_reorder') && <ProductAnalysisChartWidget widgetKey={w.widget_key} refreshKey={refreshKey} type="kpi" />}
          
          {w.widget_key === 'product_material_pie' && <ProductAnalysisChartWidget widgetKey={w.widget_key} refreshKey={refreshKey} type="pie" />}
          {w.widget_key === 'product_model_pie' && <ProductAnalysisChartWidget widgetKey={w.widget_key} refreshKey={refreshKey} type="pie" />}
          {w.widget_key === 'sales_revenue_trend' && <SalesTrendWidget refreshKey={refreshKey} />}
          
          {/* Missing implementations fallback */}
          {['payment_status_share', 'payment_category_share', 'payment_monthly_amounts'].includes(w.widget_key) && (
             <div className="text-gray-400 text-sm flex items-center justify-center p-8 bg-gray-50 rounded-xl">Grafik hazırlanıyor...</div>
          )}
        </div>
      </div>
    );
  };

  if (loading && widgets.length === 0) {
    return <div className="p-8 text-center text-gray-500 font-medium">Yükleniyor...</div>;
  }

  const activeWidgets = widgets.filter(w => w.is_visible).sort((a,b) => a.position - b.position);

  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-black text-gray-900">Dashboard</h2>
        <div className="flex gap-2">
          <button onClick={() => setRefreshKey(k=>k+1)} className="p-2.5 text-gray-500 hover:text-gray-800 bg-white border border-gray-200 shadow-sm rounded-xl transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
          {!isReadOnly && (
          <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-gray-700 bg-white border border-gray-200 shadow-sm rounded-xl hover:bg-gray-50 transition-colors">
            <Settings className="w-4 h-4" /> Widget Ayarları
          </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5 auto-rows-min">
        {activeWidgets.map(renderWidget)}
      </div>
      
      {activeWidgets.length === 0 && (
         <div className="text-center py-20 bg-gray-50 rounded-2xl border-2 border-dashed border-gray-200">
           <h3 className="text-lg font-bold text-gray-500 mb-2">Gösterilecek Veri Yok</h3>
           <p className="text-sm text-gray-400">Widget Ayarları'ndan görüntülemek istediğiniz verileri seçebilirsiniz.</p>
           {!isReadOnly && (
             <button onClick={() => setShowSettings(true)} className="mt-4 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-semibold shadow-sm text-gray-700">Seçim Yap</button>
           )}
         </div>
      )}

      {!isReadOnly && showSettings && (
        <WidgetSettingsModal 
           onClose={() => setShowSettings(false)} 
           activeWidgets={widgets} 
           onSave={handleSaveSettings} 
        />
      )}
    </div>
  );
}

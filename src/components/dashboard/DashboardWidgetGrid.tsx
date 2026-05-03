import React, { useEffect, useMemo, useState } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout/legacy';
import { dashboardApi } from './dashboardApi';
import { WidgetSettingsModal } from './WidgetSettingsModal';
import { Check, GripVertical, LayoutGrid, RefreshCw, RotateCcw, Settings } from 'lucide-react';
import { PaymentSummaryWidget } from './widgets/PaymentSummaryWidget';
import { ProductAnalysisChartWidget } from './widgets/ProductAnalysisChartWidget';
import { SalesTrendWidget } from './widgets/SalesTrendWidget';
import { UpcomingPaymentsWidget } from './widgets/UpcomingPaymentsWidget';
import { BusinessMetricWidget } from './widgets/BusinessMetricWidget';
import { BusinessChartWidget } from './widgets/BusinessChartWidget';
import { useAuth } from '../../App';
import { getDashboardWidgetDefinition } from './dashboardCatalog';

type GridItem = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number };
type Widget = {
  id: string;
  widget_key: string;
  title: string;
  description?: string;
  widget_type: string;
  source_module: string;
  size: 'small' | 'medium' | 'large' | 'full';
  position: number;
  is_visible: number | boolean;
  settings_json?: Record<string, any>;
};

const ResponsiveGridLayout = WidthProvider(Responsive);

const GRID_COLS = { lg: 12, md: 8, sm: 4, xs: 1, xxs: 1 };
const GRID_SIZE: Record<string, { w: number; h: number }> = {
  small: { w: 4, h: 3 },
  medium: { w: 6, h: 4 },
  large: { w: 8, h: 5 },
  full: { w: 12, h: 5 },
};

function widgetDims(widget: Widget) {
  const saved = widget.settings_json?.grid;
  if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
    return {
      w: Math.max(1, Math.min(12, Number(saved.w))),
      h: Math.max(2, Math.min(9, Number(saved.h))),
    };
  }
  return GRID_SIZE[widget.size] || GRID_SIZE.small;
}

function gridToSize(width: number): Widget['size'] {
  if (width >= 11) return 'full';
  if (width >= 7) return 'large';
  if (width >= 5) return 'medium';
  return 'small';
}

function buildLayout(widgets: Widget[], cols: number): GridItem[] {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  return widgets.map((widget) => {
    const saved = widget.settings_json?.grid;
    const dims = widgetDims(widget);
    const w = cols === 1 ? 1 : Math.min(cols, dims.w);
    const h = dims.h;

    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return {
        i: widget.id,
        x: Math.min(Math.max(0, Number(saved.x)), Math.max(0, cols - w)),
        y: Math.max(0, Number(saved.y)),
        w,
        h,
        minW: cols === 1 ? 1 : 3,
        minH: 2,
      };
    }

    if (cursorX + w > cols) {
      cursorX = 0;
      cursorY += rowHeight || h;
      rowHeight = 0;
    }

    const item = { i: widget.id, x: cursorX, y: cursorY, w, h, minW: cols === 1 ? 1 : 3, minH: 2 };
    cursorX += w;
    rowHeight = Math.max(rowHeight, h);
    return item;
  });
}

function cloneWidgets(widgets: Widget[]) {
  return widgets.map((widget) => ({
    ...widget,
    settings_json: { ...(widget.settings_json || {}) },
  }));
}

function isDashboardMetric(key: string) {
  return key.startsWith('dashboard_') && !key.endsWith('_chart');
}

function isDashboardChart(key: string) {
  return key === 'dashboard_monthly_profit_chart' || key === 'dashboard_platform_revenue_chart';
}

export function DashboardWidgetGrid() {
  const { isReadOnly } = useAuth();
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [widgetSnapshot, setWidgetSnapshot] = useState<Widget[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    loadDashboard();
  }, []);

  useEffect(() => {
    loadSummary();
  }, [refreshKey]);

  const loadSummary = async () => {
    try {
      const data = await dashboardApi.getSummary();
      setSummary(data || null);
    } catch (err) {
      console.error(err);
    }
  };

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const [widgetData, summaryData] = await Promise.all([
        dashboardApi.getWidgets(),
        dashboardApi.getSummary(),
      ]);
      setWidgets((widgetData || []).map((widget: Widget) => ({
        ...widget,
        settings_json: widget.settings_json || {},
      })));
      setSummary(summaryData || null);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const activeWidgets = useMemo(
    () => widgets
      .filter((widget) => widget.is_visible)
      .sort((a, b) => {
        const gridA = a.settings_json?.grid;
        const gridB = b.settings_json?.grid;
        if (gridA && !gridB) return -1;
        if (!gridA && gridB) return 1;
        if (gridA && gridB && gridA.y !== gridB.y) return gridA.y - gridB.y;
        if (gridA && gridB && gridA.x !== gridB.x) return gridA.x - gridB.x;
        return (a.position || 0) - (b.position || 0);
      }),
    [widgets],
  );

  const layouts = useMemo(() => ({
    lg: buildLayout(activeWidgets, GRID_COLS.lg),
    md: buildLayout(activeWidgets, GRID_COLS.md),
    sm: buildLayout(activeWidgets, GRID_COLS.sm),
    xs: buildLayout(activeWidgets, GRID_COLS.xs),
    xxs: buildLayout(activeWidgets, GRID_COLS.xxs),
  }), [activeWidgets]);

  const handleSaveSettings = async (newWidgets: Widget[]) => {
    if (isReadOnly) return;

    const toCreate = newWidgets.filter((widget) => widget.id?.startsWith('new_') && widget.is_visible);
    const toUpdate = newWidgets.filter((widget) => widget.id && !widget.id.startsWith('new_'));

    setShowSettings(false);
    setLoading(true);

    try {
      for (const widget of toCreate) {
        const definition = getDashboardWidgetDefinition(widget.widget_key);
        await dashboardApi.createWidget({
          widget_key: widget.widget_key,
          title: widget.title || definition?.title || widget.widget_key,
          description: widget.description || definition?.description || '',
          widget_type: widget.widget_type || definition?.type || 'kpi',
          source_module: widget.source_module || definition?.module || 'overview',
          size: widget.size || definition?.size || 'small',
          position: widget.position || 0,
          is_visible: widget.is_visible ? 1 : 0,
          settings_json: widget.settings_json || {},
        });
      }

      if (toUpdate.length > 0) {
        await dashboardApi.updateWidgets(toUpdate);
      }

      await loadDashboard();
      setRefreshKey((key) => key + 1);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  };

  const handleLayoutChange = (layout: GridItem[]) => {
    if (!editMode) return;
    setWidgets((prev) => prev.map((widget) => {
      const item = layout.find((entry) => entry.i === widget.id);
      if (!item) return widget;
      return {
        ...widget,
        size: gridToSize(item.w),
        position: item.y * 100 + item.x,
        settings_json: {
          ...(widget.settings_json || {}),
          grid: { x: item.x, y: item.y, w: item.w, h: item.h },
        },
      };
    }));
  };

  const startEdit = () => {
    setWidgetSnapshot(cloneWidgets(widgets));
    setEditMode(true);
  };

  const cancelEdit = () => {
    setWidgets(widgetSnapshot);
    setEditMode(false);
  };

  const saveEdit = async () => {
    const existingWidgets = widgets.filter((widget) => widget.id && !widget.id.startsWith('new_'));
    setLoading(true);
    try {
      await dashboardApi.updateWidgets(existingWidgets);
      await loadDashboard();
      setEditMode(false);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const renderWidgetContent = (widget: Widget) => {
    if (isDashboardMetric(widget.widget_key)) {
      return <BusinessMetricWidget widgetKey={widget.widget_key} title={widget.title} summary={summary} />;
    }
    if (isDashboardChart(widget.widget_key)) {
      return <BusinessChartWidget widgetKey={widget.widget_key} summary={summary} />;
    }

    return (
      <>
        {widget.widget_key.startsWith('payment_month_pending') && <PaymentSummaryWidget widgetKey={widget.widget_key} refreshKey={refreshKey} />}
        {widget.widget_key.startsWith('payment_auto_') && <PaymentSummaryWidget widgetKey={widget.widget_key} refreshKey={refreshKey} />}
        {widget.widget_key.startsWith('payment_overdue') && <PaymentSummaryWidget widgetKey={widget.widget_key} refreshKey={refreshKey} />}
        {widget.widget_key.startsWith('payment_processed') && <PaymentSummaryWidget widgetKey={widget.widget_key} refreshKey={refreshKey} />}
        {widget.widget_key === 'payment_upcoming_list' && <UpcomingPaymentsWidget refreshKey={refreshKey} />}
        {widget.widget_key.startsWith('product_total') && <ProductAnalysisChartWidget widgetKey={widget.widget_key} refreshKey={refreshKey} type="kpi" />}
        {widget.widget_key.startsWith('product_top') && <ProductAnalysisChartWidget widgetKey={widget.widget_key} refreshKey={refreshKey} type="kpi" />}
        {widget.widget_key.startsWith('product_reorder') && <ProductAnalysisChartWidget widgetKey={widget.widget_key} refreshKey={refreshKey} type="kpi" />}
        {widget.widget_key === 'product_material_pie' && <ProductAnalysisChartWidget widgetKey={widget.widget_key} refreshKey={refreshKey} type="pie" />}
        {widget.widget_key === 'product_model_pie' && <ProductAnalysisChartWidget widgetKey={widget.widget_key} refreshKey={refreshKey} type="pie" />}
        {widget.widget_key === 'sales_revenue_trend' && <SalesTrendWidget refreshKey={refreshKey} />}
        {['payment_status_share', 'payment_category_share', 'payment_monthly_amounts'].includes(widget.widget_key) && (
          <div className="flex items-center justify-center rounded-xl bg-slate-50 p-8 text-sm font-bold text-slate-400">Grafik hazırlanıyor...</div>
        )}
      </>
    );
  };

  const renderWidget = (widget: Widget) => {
    const isInternalTitle = isDashboardMetric(widget.widget_key);
    return (
      <div key={widget.id} className="h-full">
        <div className={`dashboard-widget-card relative flex h-full flex-col rounded-2xl border bg-white p-6 shadow-sm transition-all ${editMode ? 'border-primary/40 ring-2 ring-primary/10' : 'border-slate-200 hover:shadow-md'}`}>
          {editMode && (
            <div className="dashboard-drag-handle absolute right-4 top-4 z-10 flex cursor-move items-center gap-1 rounded-lg bg-slate-900/80 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-white">
              <GripVertical className="h-3 w-3" />
              Taşı
            </div>
          )}
          {!isInternalTitle && (
            <div className="mb-4 pr-16">
              <h3 className="text-sm font-black uppercase tracking-wider text-slate-700">{widget.title}</h3>
              {widget.description && <p className="mt-1 text-xs font-semibold text-slate-400">{widget.description}</p>}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {renderWidgetContent(widget)}
          </div>
        </div>
      </div>
    );
  };

  if (loading && widgets.length === 0) {
    return <div className="p-8 text-center font-medium text-slate-500">Yükleniyor...</div>;
  }

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-2xl font-black tracking-tight text-slate-900">Dashboard</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">Ciro, kâr, stok ve finans göstergeleri tek ekranda.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setRefreshKey((key) => key + 1)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" />
            Yenile
          </button>
          {!isReadOnly && !editMode && (
            <>
              <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
                <Settings className="h-4 w-4" />
                Widget Ekle/Sil
              </button>
              <button onClick={startEdit} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-primary-hover">
                <LayoutGrid className="h-4 w-4" />
                Düzenle
              </button>
            </>
          )}
          {!isReadOnly && editMode && (
            <>
              <button onClick={cancelEdit} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700 shadow-sm transition-colors hover:bg-slate-50">
                <RotateCcw className="h-4 w-4" />
                Vazgeç
              </button>
              <button onClick={saveEdit} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-700">
                <Check className="h-4 w-4" />
                Yerleşimi Kaydet
              </button>
            </>
          )}
        </div>
      </div>

      {editMode && (
        <div className="mb-4 rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm font-bold text-primary">
          Kartları sürükleyerek taşıyabilir, sağ alt köşeden büyütüp küçültebilirsiniz. Kaydetmeden çıkarsanız yerleşim korunmaz.
        </div>
      )}

      {activeWidgets.length > 0 ? (
        <ResponsiveGridLayout
          className="layout dashboard-grid"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
          cols={GRID_COLS}
          rowHeight={64}
          margin={[20, 20]}
          containerPadding={[0, 0]}
          isDraggable={!isReadOnly && editMode}
          isResizable={!isReadOnly && editMode}
          draggableHandle=".dashboard-drag-handle"
          resizeHandles={['se']}
          onLayoutChange={(layout) => handleLayoutChange(layout as GridItem[])}
        >
          {activeWidgets.map(renderWidget)}
        </ResponsiveGridLayout>
      ) : (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 py-20 text-center">
          <h3 className="mb-2 text-lg font-bold text-slate-500">Gösterilecek Veri Yok</h3>
          <p className="text-sm text-slate-400">Widget Ekle/Sil ekranından görüntülemek istediğiniz verileri seçebilirsiniz.</p>
          {!isReadOnly && (
            <button onClick={() => setShowSettings(true)} className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm">Seçim Yap</button>
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

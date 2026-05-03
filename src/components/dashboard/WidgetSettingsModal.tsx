import React from 'react';
import { Check, X } from 'lucide-react';
import { DASHBOARD_WIDGET_CATALOG } from './dashboardCatalog';

const moduleLabels: Record<string, string> = {
  overview: 'İşletme Özeti',
  payments: 'Ödemeler',
  products: 'Ürün Analizi',
  finance: 'Finans',
};

export function WidgetSettingsModal({ onClose, activeWidgets, onSave }: any) {
  const [widgets, setWidgets] = React.useState<any[]>([]);

  React.useEffect(() => {
    // Merge active with catalog
    let merged = [...activeWidgets];

    DASHBOARD_WIDGET_CATALOG.forEach(catWidget => {
      if (!merged.find(w => w.widget_key === catWidget.key)) {
        merged.push({
          id: `new_${catWidget.key}`,
          is_visible: 0,
          widget_key: catWidget.key,
          title: catWidget.title,
          description: catWidget.description,
          widget_type: catWidget.type,
          source_module: catWidget.module,
          size: catWidget.size,
          position: merged.length,
          settings_json: {}
        });
      }
    });

    merged.sort((a, b) => a.position - b.position);
    setWidgets(merged);
  }, [activeWidgets]);

  const toggleVisibility = (idx: number) => {
    const next = [...widgets];
    next[idx].is_visible = next[idx].is_visible ? 0 : 1;
    setWidgets(next);
  };

  const changeSize = (idx: number, sz: string) => {
    const next = [...widgets];
    next[idx].size = sz;
    setWidgets(next);
  };

  const moveUp = (idx: number) => {
    if (idx === 0) return;
    const next = [...widgets];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    next.forEach((w, i) => w.position = i);
    setWidgets(next);
  };

  const moveDown = (idx: number) => {
    if (idx === widgets.length - 1) return;
    const next = [...widgets];
    [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
    next.forEach((w, i) => w.position = i);
    setWidgets(next);
  };

  const handleSave = () => {
    onSave(widgets.filter(w => w.is_visible || !w.id.startsWith('new_')));
  };

  const showAll = () => {
    setWidgets(widgets.map(w => ({ ...w, is_visible: 1 })));
  };

  const hideAll = () => {
    setWidgets(widgets.map(w => ({ ...w, is_visible: 0 })));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col max-h-[90vh] overflow-hidden">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-white text-gray-900 sticky top-0">
          <h2 className="text-xl font-bold">Dashboard Widget Ayarları</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto bg-gray-50/50">
          <div className="flex gap-2 mb-4">
            <button onClick={showAll} className="px-3 py-1.5 text-xs font-semibold bg-gray-200 hover:bg-gray-300 rounded-md transition-colors">Tümünü Göster</button>
            <button onClick={hideAll} className="px-3 py-1.5 text-xs font-semibold bg-gray-200 hover:bg-gray-300 rounded-md transition-colors">Tümünü Gizle</button>
          </div>

          <div className="space-y-3">
            {widgets.map((w, idx) => (
              <div key={w.id || w.widget_key} className={`flex items-center gap-4 bg-white p-4 rounded-xl border transition-colors ${w.is_visible ? 'border-primary/30 ring-1 ring-primary/10 shadow-sm' : 'border-gray-200 opacity-60 hover:opacity-100'}`}>
                <div className="flex flex-col gap-1 items-center px-1">
                  <button onClick={() => moveUp(idx)} disabled={idx === 0} className="text-gray-400 hover:text-gray-800 disabled:opacity-30">▲</button>
                  <button onClick={() => moveDown(idx)} disabled={idx === widgets.length - 1} className="text-gray-400 hover:text-gray-800 disabled:opacity-30">▼</button>
                </div>
                
                <label className="flex items-center cursor-pointer">
                  <input type="checkbox" checked={!!w.is_visible} onChange={() => toggleVisibility(idx)} className="rounded text-primary focus:ring-primary h-5 w-5 border-gray-300" />
                </label>

                <div className="flex-1">
                  <h4 className="font-bold text-gray-900 text-sm">{w.title}</h4>
                  <p className="text-xs text-gray-500 font-medium">
                    {moduleLabels[w.source_module] || w.source_module || 'Dashboard'} • {w.widget_type}
                  </p>
                  {w.description && <p className="text-[11px] text-gray-400 font-medium mt-1">{w.description}</p>}
                </div>

                <div className="flex items-center gap-2">
                  <select value={w.size} onChange={(e) => changeSize(idx, e.target.value)} className="text-xs bg-gray-50 border-gray-200 rounded-lg p-2 font-medium">
                    <option value="small">Küçük (1 Kolon)</option>
                    <option value="medium">Orta (2 Kolon)</option>
                    <option value="large">Geniş (3-4 Kolon)</option>
                    <option value="full">Tam (Genişlik)</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
        
        <div className="p-6 border-t border-gray-100 flex items-center justify-end gap-3 bg-white sticky bottom-0">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">
            İptal
          </button>
          <button onClick={handleSave} className="px-5 py-2.5 text-sm font-bold text-white bg-primary hover:bg-primary-hover rounded-xl shadow-lg transition-colors flex items-center gap-2">
            <Check className="w-5 h-5" /> Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}

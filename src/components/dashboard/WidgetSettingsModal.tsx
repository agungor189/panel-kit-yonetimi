import React from 'react';
import { Check } from 'lucide-react';
import { DASHBOARD_WIDGET_CATALOG } from './dashboardCatalog';
import { Button, Card, Modal, Select } from '../ui';

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
    <Modal
      open
      onClose={onClose}
      title="Dashboard Widget Ayarları"
      size="xl"
      className="max-w-4xl"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} className="rounded-xl bg-gray-100 font-bold text-gray-600 hover:bg-gray-200">İptal</Button>
          <Button onClick={handleSave} className="rounded-xl font-bold shadow-lg">
            <Check className="h-5 w-5" /> Kaydet
          </Button>
        </>
      )}
    >
        <div className="-m-5 flex-1 overflow-y-auto bg-gray-50/50 p-4">
          <div className="flex gap-2 mb-4">
            <Button size="sm" variant="secondary" onClick={showAll} className="bg-gray-200 font-semibold hover:bg-gray-300">Tümünü Göster</Button>
            <Button size="sm" variant="secondary" onClick={hideAll} className="bg-gray-200 font-semibold hover:bg-gray-300">Tümünü Gizle</Button>
          </div>

          <div className="space-y-3">
            {widgets.map((w, idx) => (
              <Card key={w.id || w.widget_key} padding="sm" className={`flex items-center gap-4 rounded-xl transition-colors ${w.is_visible ? 'border-primary/30 ring-1 ring-primary/10 shadow-sm' : 'border-gray-200 opacity-60 hover:opacity-100'}`}>
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
                  <Select value={w.size} onChange={(e) => changeSize(idx, e.target.value)} className="rounded-lg border-gray-200 bg-gray-50 p-2 text-xs font-medium">
                    <option value="small">Küçük (1 Kolon)</option>
                    <option value="medium">Orta (2 Kolon)</option>
                    <option value="large">Geniş (3-4 Kolon)</option>
                    <option value="full">Tam (Genişlik)</option>
                  </Select>
                </div>
              </Card>
            ))}
          </div>
        </div>
    </Modal>
  );
}

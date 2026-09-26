import { useEffect, useState } from 'react';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import { useAuth } from '../App';
import { api } from '../lib/api';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH,
  NOTIFICATION_TEMPLATE_PREVIEW_VALUES,
  NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH,
  NOTIFICATION_TEMPLATE_VARIABLES,
  renderNotificationTemplate,
  validateNotificationTemplate,
  type NotificationCategory,
} from '../../shared/notificationTemplates';

type ManagedTemplate = {
  category: NotificationCategory;
  title: string;
  message: string;
  is_default: boolean;
};

const categoryLabels: Record<NotificationCategory, string> = {
  new_order: 'Yeni sipariş',
  order_cancel_return: 'Sipariş iptal / iade',
  shipping_exception: 'Sevkiyat hatası',
  stock_exception: 'Stok uyarısı',
  goods_receipt_exception: 'Mal kabul farkı',
  reconciliation_exception: 'Sistem uyuşmazlığı',
  integration_exception: 'Entegrasyon hatası',
  backup_exception: 'Backup / DR hatası',
};

const responseData = <T,>(response: T | { data: T }): T => (
  response && typeof response === 'object' && 'data' in response
    ? (response as { data: T }).data
    : response as T
);

export default function NotificationTemplateSettings() {
  const { role, permissions } = useAuth();
  const canManage = role === 'admin' || permissions['settings:admin'] === true;
  const [templates, setTemplates] = useState<ManagedTemplate[]>([]);
  const [loading, setLoading] = useState(canManage);
  const [saving, setSaving] = useState<NotificationCategory | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canManage) return;
    void api.get('/push/templates')
      .then((response) => setTemplates(responseData<ManagedTemplate[]>(response)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Bildirim şablonları alınamadı.'))
      .finally(() => setLoading(false));
  }, [canManage]);

  if (!canManage) return null;

  const updateLocal = (category: NotificationCategory, field: 'title' | 'message', value: string) => {
    setTemplates((current) => current.map((template) => (
      template.category === category ? { ...template, [field]: value } : template
    )));
  };

  const save = async (template: ManagedTemplate) => {
    setSaving(template.category);
    setMessage('');
    setError('');
    try {
      validateNotificationTemplate(template.category, template);
      const response = await api.put(`/push/templates/${template.category}`, {
        title: template.title,
        message: template.message,
      });
      const saved = responseData<ManagedTemplate>(response);
      setTemplates((current) => current.map((item) => item.category === saved.category ? saved : item));
      setMessage(`${categoryLabels[template.category]} şablonu kaydedildi.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim şablonu kaydedilemedi.');
    } finally {
      setSaving(null);
    }
  };

  const reset = async (category: NotificationCategory) => {
    setSaving(category);
    setMessage('');
    setError('');
    try {
      const response = await api.post(`/push/templates/${category}/reset`, {});
      const restored = responseData<ManagedTemplate>(response);
      setTemplates((current) => current.map((item) => item.category === category ? restored : item));
      setMessage(`${categoryLabels[category]} şablonu varsayılana döndürüldü.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim şablonu sıfırlanamadı.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="card overflow-hidden">
      <div className="space-y-5 p-6 lg:p-8">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-widest text-text-muted">Bildirim Şablonları</h3>
          <p className="mt-2 text-xs text-text-muted">
            Global push başlıklarını ve mesajlarını yönetin. Yalnız listelenen değişkenler kullanılabilir.
          </p>
        </div>

        {loading && <p className="flex items-center text-xs text-text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Şablonlar yükleniyor…</p>}
        {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">{error}</p>}
        {message && <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700">{message}</p>}

        <div className="space-y-4">
          {NOTIFICATION_CATEGORIES.map((category) => {
            const template = templates.find((item) => item.category === category);
            if (!template) return null;
            let validationError = '';
            try {
              validateNotificationTemplate(category, template);
            } catch (err) {
              validationError = err instanceof Error ? err.message : 'Şablon geçersiz.';
            }
            const preview = renderNotificationTemplate(category, NOTIFICATION_TEMPLATE_PREVIEW_VALUES[category], template);
            const isSaving = saving === category;
            return (
              <div key={category} className="space-y-4 rounded-2xl border border-border-color bg-bg-main p-4 lg:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-black text-text-main">{categoryLabels[category]}</h4>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-bold text-text-muted">
                    {template.is_default ? 'Varsayılan' : 'Özelleştirilmiş'}
                  </span>
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                  <label className="space-y-2 text-xs font-bold text-text-muted">
                    <span>Başlık</span>
                    <input
                      value={template.title}
                      maxLength={NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH}
                      onChange={(event) => updateLocal(category, 'title', event.target.value)}
                      className="h-11 w-full rounded-xl border border-border-color bg-white px-3 text-sm font-medium text-text-main outline-none focus:border-primary"
                    />
                  </label>
                  <label className="space-y-2 text-xs font-bold text-text-muted">
                    <span>Mesaj</span>
                    <textarea
                      value={template.message}
                      maxLength={NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH}
                      onChange={(event) => updateLocal(category, 'message', event.target.value)}
                      rows={2}
                      className="w-full resize-y rounded-xl border border-border-color bg-white px-3 py-2 text-sm font-medium text-text-main outline-none focus:border-primary"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {NOTIFICATION_TEMPLATE_VARIABLES[category].map((variable) => (
                    <code key={variable} className="rounded-md border border-border-color bg-white px-2 py-1 text-[10px] text-text-muted">{'{{'}{variable}{'}}'}</code>
                  ))}
                </div>
                <div className="rounded-xl border border-dashed border-border-color bg-white p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-text-muted">Preview</p>
                  <p className="mt-2 text-sm font-black text-text-main">{preview.title}</p>
                  <p className="mt-1 text-xs text-text-muted">{preview.message}</p>
                  {validationError && <p className="mt-2 text-[11px] font-semibold text-red-600">{validationError} Preview güvenli varsayılanı gösteriyor.</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void save(template)}
                    disabled={isSaving || Boolean(validationError)}
                    className="inline-flex h-10 items-center rounded-xl bg-primary px-4 text-xs font-black text-white disabled:opacity-50"
                  >
                    {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Kaydet
                  </button>
                  <button
                    type="button"
                    onClick={() => void reset(category)}
                    disabled={isSaving}
                    className="inline-flex h-10 items-center rounded-xl border border-border-color bg-white px-4 text-xs font-black text-text-main disabled:opacity-50"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />Varsayılana Döndür
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

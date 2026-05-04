import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Database, Link2, Play, RefreshCw, Save, ShoppingBag } from 'lucide-react';
import { api } from '../../lib/api';
import type { TrendyolConfig, TrendyolMarketplaceOrder, TrendyolStatus } from '../../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const defaultConfig: TrendyolConfig = {
  enabled: false,
  environment: 'stage',
  api_key_id: '',
  sync_window_days: 14,
  store_front_code: '',
};

const formatDateTime = (value?: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('tr-TR');
};

const formatAmount = (value?: number, currency = 'TRY') => {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: currency === 'TRY' ? 'TRY' : 'USD',
  }).format(Number(value || 0));
};

const statusClass = (status?: string) => cn(
  'inline-flex rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-wider',
  status === 'Tamamlandı'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : status === 'Gönderildi'
      ? 'border-blue-200 bg-blue-50 text-blue-700'
      : status === 'İptal Edildi' || status === 'İade Edildi'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-amber-200 bg-amber-50 text-amber-700'
);

export default function TrendyolIntegration() {
  const [status, setStatus] = useState<TrendyolStatus | null>(null);
  const [config, setConfig] = useState<TrendyolConfig>(defaultConfig);
  const [orders, setOrders] = useState<TrendyolMarketplaceOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    loadStatus();
  }, []);

  useEffect(() => {
    loadOrders(config.environment);
  }, [config.environment]);

  const loadStatus = async () => {
    try {
      setLoading(true);
      const data = await api.get('/integrations/trendyol/status');
      setStatus(data);
      setConfig({ ...defaultConfig, ...(data.config || {}) });
      await loadOrders(data.config?.environment || 'stage');
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Trendyol durumu yüklenemedi.' });
    } finally {
      setLoading(false);
    }
  };

  const loadOrders = async (environment = config.environment) => {
    try {
      const data = await api.get(`/integrations/trendyol/orders?environment=${environment}&limit=100`);
      setOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  };

  const saveConfig = async () => {
    try {
      setWorking(true);
      const res = await api.put('/integrations/trendyol/config', config);
      setConfig(res.config || config);
      setMessage({ type: 'success', text: 'Trendyol ayarları kaydedildi.' });
      await loadStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Ayarlar kaydedilemedi.' });
    } finally {
      setWorking(false);
    }
  };

  const testConnection = async () => {
    try {
      setWorking(true);
      const res = await api.post('/integrations/trendyol/test', config);
      setMessage({ type: 'success', text: res.message || 'Trendyol bağlantısı başarılı.' });
      await loadStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Trendyol bağlantı testi başarısız.' });
    } finally {
      setWorking(false);
    }
  };

  const syncOrders = async () => {
    try {
      setWorking(true);
      const res = await api.post('/integrations/trendyol/sync', config);
      const summary = res.summary;
      setMessage({
        type: 'success',
        text: `Senkron tamamlandı. Paket: ${summary.fetched}, satır: ${summary.lines || 0}, eşleşen: ${summary.matched_lines || 0}, eşleşmeyen: ${summary.unmatched_lines || 0}.`,
      });
      await loadStatus();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Trendyol sipariş senkronu başarısız.' });
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-2xl border border-border-color bg-white p-10 text-center text-text-muted">
        <RefreshCw className="mx-auto mb-3 h-6 w-6 animate-spin text-primary" />
        <div className="font-black">Trendyol entegrasyonu yükleniyor...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 rounded-3xl border border-border-color bg-white p-6 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
            <ShoppingBag className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight text-text-main">Trendyol Entegrasyonu</h2>
            <p className="mt-1 max-w-2xl text-sm font-semibold text-text-muted">
              Önce test ortamında bağlantıyı doğrulayın, sonra Trendyol paketlerini güvenli ara tabloya senkron edin.
              Panel satışına aktarma, barkod eşleşmesi onaylandıktan sonra açılmalıdır.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={saveConfig} disabled={working} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-black text-white transition hover:bg-slate-800 disabled:opacity-50">
            <Save className="h-4 w-4" />
            Ayarları Kaydet
          </button>
          <button onClick={testConnection} disabled={working || !config.api_key_id} className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-black text-blue-700 transition hover:bg-blue-100 disabled:opacity-50">
            <Play className="h-4 w-4" />
            Bağlantıyı Test Et
          </button>
          <button onClick={syncOrders} disabled={working || !config.api_key_id} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-black text-white transition hover:bg-primary/90 disabled:opacity-50">
            <RefreshCw className={cn('h-4 w-4', working && 'animate-spin')} />
            Siparişleri Senkronla
          </button>
        </div>
      </div>

      {message && (
        <div className={cn(
          'flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold',
          message.type === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : message.type === 'error'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-blue-200 bg-blue-50 text-blue-800',
        )}>
          {message.type === 'success' ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-border-color bg-white p-5 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-text-muted">Ortam</div>
          <div className="mt-2 text-2xl font-black text-text-main">{config.environment === 'prod' ? 'Canlı' : 'Test'}</div>
          <div className="mt-1 text-xs font-bold text-text-muted">Stage IP yetkisi gerektirebilir.</div>
        </div>
        <div className="rounded-2xl border border-border-color bg-white p-5 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-text-muted">Toplam Paket</div>
          <div className="mt-2 text-2xl font-black text-text-main">{Number(status?.stats?.total || 0)}</div>
          <div className="mt-1 text-xs font-bold text-text-muted">{Number(status?.stats?.line_count || 0)} satır kaydı.</div>
        </div>
        <div className="rounded-2xl border border-border-color bg-white p-5 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-text-muted">Ürün Eşleşmesi</div>
          <div className="mt-2 text-2xl font-black text-text-main">
            {Number(status?.stats?.matched_line_count || 0)} / {Number(status?.stats?.line_count || 0)}
          </div>
          <div className="mt-1 text-xs font-bold text-text-muted">{Number(status?.stats?.unmatched_line_count || 0)} satır eşleşme bekliyor.</div>
        </div>
        <div className="rounded-2xl border border-border-color bg-white p-5 shadow-sm">
          <div className="text-xs font-black uppercase tracking-wider text-text-muted">Son Sync</div>
          <div className="mt-2 text-sm font-black text-text-main">{formatDateTime(status?.last_sync_at)}</div>
          <div className="mt-1 text-xs font-bold text-text-muted">Son paket: {formatDateTime(status?.stats?.last_package_at)}</div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <div className="rounded-3xl border border-border-color bg-white p-6 shadow-sm">
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wider text-text-muted">
            <Link2 className="h-4 w-4 text-primary" />
            Bağlantı Ayarları
          </h3>
          <div className="mt-5 space-y-4">
            <label className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <div className="text-sm font-black text-slate-900">Senkron Açık</div>
                <div className="text-xs font-semibold text-slate-500">Otomasyon eklenince bu ayara bakılacak.</div>
              </div>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(event) => setConfig((prev) => ({ ...prev, enabled: event.target.checked }))}
                className="h-5 w-5 rounded border-slate-300 text-primary focus:ring-primary"
              />
            </label>

            <div>
              <label className="mb-1 block text-xs font-black uppercase tracking-wider text-text-muted">Ortam</label>
              <select
                value={config.environment}
                onChange={(event) => setConfig((prev) => ({ ...prev, environment: event.target.value as TrendyolConfig['environment'] }))}
                className="form-input font-bold"
              >
                <option value="stage">Test / Stage</option>
                <option value="prod">Canlı / Production</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-black uppercase tracking-wider text-text-muted">Trendyol API Anahtarı</label>
              <select
                value={config.api_key_id}
                onChange={(event) => setConfig((prev) => ({ ...prev, api_key_id: event.target.value }))}
                className="form-input font-bold"
              >
                <option value="">Anahtar seçin</option>
                {(status?.keys || []).map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.display_name} {key.status !== 'active' ? '(pasif)' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs font-semibold text-text-muted">
                Anahtar yoksa API Anahtarları bölümünde servis olarak Trendyol seçip API Key, API Secret ve Seller ID ekleyin.
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-black uppercase tracking-wider text-text-muted">Senkron Penceresi</label>
              <input
                type="number"
                min={1}
                max={14}
                value={config.sync_window_days}
                onChange={(event) => setConfig((prev) => ({ ...prev, sync_window_days: Number(event.target.value) }))}
                className="form-input font-bold"
              />
              <p className="mt-2 text-xs font-semibold text-text-muted">Trendyol stream endpoint için tek aralık maksimum 14 gündür.</p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-black uppercase tracking-wider text-text-muted">Store Front Code</label>
              <input
                value={config.store_front_code || ''}
                onChange={(event) => setConfig((prev) => ({ ...prev, store_front_code: event.target.value }))}
                placeholder="TR ortamı için genelde boş kalabilir"
                className="form-input font-bold"
              />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-3xl border border-border-color bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-border-color p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-lg font-black text-text-main">
                <Database className="h-5 w-5 text-primary" />
                Senkronlanan Trendyol Paketleri
              </h3>
              <p className="mt-1 text-sm font-semibold text-text-muted">Bu liste satışa otomatik yazmaz; önce Trendyol raw paketi güvenle saklar.</p>
            </div>
            <button onClick={() => loadOrders(config.environment)} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" />
              Yenile
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-5 py-4">Sipariş / Paket</th>
                  <th className="px-5 py-4">Müşteri</th>
                  <th className="px-5 py-4">Ürün Satırları</th>
                  <th className="px-5 py-4">Eşleşme</th>
                  <th className="px-5 py-4">Tutar</th>
                  <th className="px-5 py-4">Durum</th>
                  <th className="px-5 py-4">Tarih</th>
                  <th className="px-5 py-4">Aktarım</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {orders.map((order) => (
                  <tr key={order.id} className="hover:bg-slate-50">
                    <td className="px-5 py-4">
                      <div className="font-mono text-sm font-black text-slate-900">{order.external_order_id}</div>
                      <div className="mt-1 text-xs font-semibold text-slate-500">Paket: {order.shipment_package_id}</div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="font-black text-slate-900">{order.customer_name || '-'}</div>
                      <div className="mt-1 text-xs font-semibold text-slate-500">{order.customer_phone || '-'}</div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="space-y-2">
                        {(order.lines || []).slice(0, 2).map((line) => (
                          <div key={line.id} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
                            <div className="line-clamp-1 text-xs font-black text-slate-900" title={line.product_name}>
                              {line.product_name || 'Ürün adı yok'}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-bold text-slate-500">
                              <span>{line.quantity || 0} adet</span>
                              {line.barcode && <span>Barkod: {line.barcode}</span>}
                              {line.stock_code && <span>Stok: {line.stock_code}</span>}
                            </div>
                          </div>
                        ))}
                        {(order.lines?.length || 0) > 2 && (
                          <div className="text-xs font-black text-primary">+{(order.lines?.length || 0) - 2} satır daha</div>
                        )}
                        {(order.lines?.length || 0) === 0 && <span className="text-xs font-bold text-slate-400">Satır yok</span>}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="text-sm font-black text-slate-900">
                        {Number(order.matched_line_count || 0)} / {Number(order.line_count || 0)}
                      </div>
                      {Number(order.unmatched_line_count || 0) > 0 ? (
                        <span className="mt-2 inline-flex rounded-full bg-amber-50 px-3 py-1 text-[11px] font-black text-amber-700">Eşleşme Bekliyor</span>
                      ) : Number(order.line_count || 0) > 0 ? (
                        <span className="mt-2 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-black text-emerald-700">Hazır</span>
                      ) : (
                        <span className="mt-2 inline-flex rounded-full bg-slate-100 px-3 py-1 text-[11px] font-black text-slate-600">Satır Yok</span>
                      )}
                    </td>
                    <td className="px-5 py-4 font-black text-slate-900">{formatAmount(order.total_amount, order.currency)}</td>
                    <td className="px-5 py-4">
                      <span className={statusClass(order.panel_status)}>{order.panel_status || order.status || '-'}</span>
                      <div className="mt-1 text-xs font-semibold text-slate-500">TY: {order.status || '-'}</div>
                    </td>
                    <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                      <div className="flex items-center gap-1.5">
                        <Clock3 className="h-3.5 w-3.5" />
                        {formatDateTime(order.package_last_modified_at || order.package_created_at)}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      {order.sale_id ? (
                        <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-black text-emerald-700">Satışa Aktarıldı</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-[11px] font-black text-slate-600">Bekliyor</span>
                      )}
                    </td>
                  </tr>
                ))}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-5 py-16 text-center text-text-muted">
                      <ShoppingBag className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                      <div className="font-black">Henüz Trendyol paketi senkronlanmadı.</div>
                      <div className="mt-1 text-sm font-semibold">Bağlantıyı test edip “Siparişleri Senkronla” ile başlayın.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

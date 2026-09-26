import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellOff, BellRing, CheckCircle2, Loader2, Send } from 'lucide-react';
import { ApiError, api } from '../lib/api';
import {
  enableBrowserPush,
  getExistingPushSubscription,
  getPushSupport,
  pushEndpointHash,
} from '../lib/pushNotifications';

type ServerPushStatus = {
  available: boolean;
  reason: string | null;
  publicKey: string | null;
  subscriptionCount: number;
  subscribed: boolean;
};

type NotificationPreferences = {
  new_order: boolean;
  shipping_exception: boolean;
  critical_stock: boolean;
  system_exception: boolean;
};

const preferenceOptions: Array<{ key: keyof NotificationPreferences; label: string; description: string }> = [
  { key: 'new_order', label: 'Yeni siparişler', description: 'Yeni sipariş bildirimlerini al.' },
  { key: 'shipping_exception', label: 'Kargo istisnaları', description: 'Gönderim sürecindeki istisnaları bildir.' },
  { key: 'critical_stock', label: 'Kritik stok', description: 'Kritik stok seviyelerini bildir.' },
  { key: 'system_exception', label: 'Sistem istisnaları', description: 'Önemli sistem sorunlarını bildir.' },
];

const OWNERSHIP_CONFIRMATION = 'Bu cihazın bildirimleri başka bir DSDST hesabına bağlı. Bu hesaba taşımak ister misiniz?';

const responseData = <T,>(response: T | { data: T }): T => {
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as { data: T }).data;
  }
  return response as T;
};

export default function PushNotificationSettings() {
  const support = getPushSupport();
  const [serverStatus, setServerStatus] = useState<ServerPushStatus | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const subscription = support.supported ? await getExistingPushSubscription() : null;
      const endpointHash = subscription ? await pushEndpointHash(subscription.endpoint) : '';
      const query = endpointHash ? `?endpoint_hash=${endpointHash}` : '';
      const [statusResponse, preferencesResponse] = await Promise.all([
        api.get(`/push/status${query}`),
        api.get('/push/preferences'),
      ]);
      const status = responseData<ServerPushStatus>(statusResponse);
      setServerStatus(status);
      setPreferences(responseData<NotificationPreferences>(preferencesResponse));
      setEnabled(Boolean(subscription && status.subscribed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim durumu alınamadı.');
    } finally {
      setLoading(false);
    }
  }, [support.supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    if (!serverStatus?.available || !serverStatus.publicKey) return;
    setLoading(true);
    setError('');
    setMessage('');
    let createdSubscription: PushSubscription | null = null;
    let registered = false;
    try {
      const browserResult = await enableBrowserPush(serverStatus.publicKey);
      if (browserResult.created) createdSubscription = browserResult.subscription;
      const subscriptionJson = browserResult.subscription.toJSON();
      if (!subscriptionJson.keys?.p256dh || !subscriptionJson.keys?.auth) {
        throw new Error('Tarayıcı geçerli push anahtarları üretmedi.');
      }
      try {
        await api.post('/push/subscribe', subscriptionJson);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'PUSH_ENDPOINT_OWNERSHIP_CONFLICT') throw err;
        if (!window.confirm(OWNERSHIP_CONFIRMATION)) {
          setMessage('Cihaz sahipliği değişikliği iptal edildi.');
          return;
        }
        await api.post('/push/rebind', subscriptionJson);
      }
      registered = true;
      setEnabled(true);
      setMessage('Bu cihaz için bildirimler açıldı.');
      await refresh();
    } catch (err) {
      if (createdSubscription && !registered) await createdSubscription.unsubscribe().catch(() => false);
      setError(err instanceof Error ? err.message : 'Bildirimler açılamadı.');
    } finally {
      setLoading(false);
    }
  };

  const disable = async () => {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const subscription = await getExistingPushSubscription();
      if (subscription) {
        const response = await api.post('/push/unsubscribe', { endpoint: subscription.endpoint });
        const result = responseData<{ removed: boolean }>(response);
        if (!result.removed) {
          throw new Error('Bu cihaz subscription’ı giriş yapan kullanıcıya ait değil.');
        }
        await subscription.unsubscribe();
      }
      setEnabled(false);
      setMessage('Bu cihaz için bildirimler kapatıldı.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirimler kapatılamadı.');
    } finally {
      setLoading(false);
    }
  };

  const updatePreference = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!preferences) return;
    const next = { ...preferences, [key]: value };
    setPreferenceSaving(true);
    setError('');
    setMessage('');
    try {
      const response = await api.put('/push/preferences', next);
      setPreferences(responseData<NotificationPreferences>(response));
      setMessage('Bildirim tercihleri kaydedildi.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bildirim tercihleri kaydedilemedi.');
    } finally {
      setPreferenceSaving(false);
    }
  };

  const sendTest = async () => {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const subscription = await getExistingPushSubscription();
      if (!subscription) throw new Error('Bu cihazda aktif push subscription bulunamadı.');
      const response = await api.post('/push/test', { endpoint: subscription.endpoint });
      const result = responseData<{ sent: number; expired: number; failed: number }>(response);
      if (result.sent < 1) {
        if (result.expired > 0) {
          await subscription.unsubscribe().catch(() => false);
          setEnabled(false);
        }
        await refresh();
        throw new Error(result.expired > 0 ? 'Subscription süresi dolmuş; bildirimleri yeniden açın.' : 'Test bildirimi gönderilemedi.');
      }
      setMessage('Test bildirimi gönderildi.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test bildirimi gönderilemedi.');
    } finally {
      setLoading(false);
    }
  };

  const unavailableMessage = 'message' in support
    ? support.message
    : serverStatus && !serverStatus.available
      ? 'Sunucuda VAPID ayarları tamamlanmadığı için Web Push şu anda kullanılamıyor.'
      : '';

  return (
    <div className="card overflow-hidden">
      <div className="p-6 lg:p-8 space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
              <BellRing className="w-4 h-4 mr-3 text-primary" />
              Cihaz Bildirimleri
            </h3>
            <p className="text-xs text-text-muted mt-2">
              Bu tarayıcıyı hesabınıza bağlayın. Oturum kapalı veya süresi dolmuş olsa da cihaz subscription’ı siz kapatana kadar korunur.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={enabled ? disable : enable}
              disabled={loading || (!enabled && Boolean(unavailableMessage))}
              className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-4 text-xs font-black text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : enabled ? <BellOff className="mr-2 h-4 w-4" /> : <BellRing className="mr-2 h-4 w-4" />}
              {enabled ? 'Bildirimleri Kapat' : 'Bildirimleri Aç'}
            </button>
            <button
              type="button"
              onClick={sendTest}
              disabled={loading || !enabled || !serverStatus?.available}
              className="inline-flex h-10 items-center justify-center rounded-xl border border-border-color bg-white px-4 text-xs font-black text-text-main transition-colors hover:bg-bg-main disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="mr-2 h-4 w-4" />
              Test Bildirimi
            </button>
          </div>
        </div>

        {preferences && (
          <fieldset className="grid gap-3 border-t border-border-color pt-5 sm:grid-cols-2" disabled={preferenceSaving}>
            <legend className="sr-only">Bildirim tercihleri</legend>
            {preferenceOptions.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-border-color bg-bg-main p-4 transition-colors hover:border-primary/30"
              >
                <input
                  type="checkbox"
                  checked={preferences[option.key]}
                  onChange={(event) => void updatePreference(option.key, event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-border-color text-primary focus:ring-primary"
                />
                <span>
                  <span className="block text-xs font-black text-text-main">{option.label}</span>
                  <span className="mt-1 block text-[11px] font-medium text-text-muted">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {loading && !serverStatus && support.supported && (
          <p className="flex items-center text-xs text-text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />Bildirim durumu kontrol ediliyor…</p>
        )}
        {unavailableMessage && (
          <p className="flex items-start rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800">
            <AlertTriangle className="mr-2 h-4 w-4 shrink-0" />{unavailableMessage}
          </p>
        )}
        {error && (
          <p className="flex items-start rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">
            <AlertTriangle className="mr-2 h-4 w-4 shrink-0" />{error}
          </p>
        )}
        {message && (
          <p className="flex items-start rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs font-semibold text-emerald-700">
            <CheckCircle2 className="mr-2 h-4 w-4 shrink-0" />{message}
          </p>
        )}
      </div>
    </div>
  );
}

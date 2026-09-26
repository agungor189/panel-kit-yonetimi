export type PushSupport = { supported: true } | { supported: false; message: string };

export function getPushSupport(): PushSupport {
  if (!window.isSecureContext) {
    return { supported: false, message: 'Bildirimler yalnız HTTPS bağlantısında kullanılabilir.' };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return {
      supported: false,
      message: 'Bu tarayıcı Web Push desteklemiyor. iPhone/iPad’de paneli Safari’den Ana Ekran’a ekleyip kurulu uygulamadan açın.',
    };
  }
  return { supported: true };
}

export async function registerPanelServiceWorker() {
  const support = getPushSupport();
  if ('message' in support) throw new Error(support.message);
  return navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
}

export async function getExistingPushSubscription() {
  const support = getPushSupport();
  if (!support.supported) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushEndpointHash(endpoint: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function applicationServerKey(publicKey: string) {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = `${publicKey}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = window.atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function enableBrowserPush(publicKey: string) {
  const support = getPushSupport();
  if ('message' in support) throw new Error(support.message);

  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission;
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Bildirim izni engellenmiş. Tarayıcı site ayarlarından izin verin.'
        : 'Bildirim izni verilmedi.',
    );
  }

  const registration = await registerPanelServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (existing) return { subscription: existing, created: false };

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey),
  });
  return { subscription, created: true };
}

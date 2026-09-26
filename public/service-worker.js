const DEFAULT_NOTIFICATION = {
  title: 'DSDST Panel',
  body: 'Yeni bir bildiriminiz var.',
  url: '/',
  tag: 'dsdst-panel-notification',
};

function safeText(value, fallback, maxLength) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function safePanelUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href;
  } catch {
    return new URL('/', self.location.origin).href;
  }
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};

  const title = safeText(payload.title, DEFAULT_NOTIFICATION.title, 80);
  const options = {
    body: safeText(payload.body, DEFAULT_NOTIFICATION.body, 180),
    icon: '/pwa-192x192.png',
    badge: '/favicon-32x32.png',
    tag: safeText(payload.tag, DEFAULT_NOTIFICATION.tag, 80),
    data: { url: safePanelUrl(payload.url || DEFAULT_NOTIFICATION.url) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = safePanelUrl(event.notification.data?.url);

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) await client.navigate(targetUrl);
      return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});

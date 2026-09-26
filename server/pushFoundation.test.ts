import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

test('service worker handles push, notification display and safe click navigation', async () => {
  const source = await readFile(new URL('public/service-worker.js', `file://${repoRoot}/`), 'utf8');
  const listeners = new Map<string, (event: any) => void>();
  const notifications: Array<{ title: string; options: any }> = [];
  const openedUrls: string[] = [];
  const self = {
    location: { origin: 'https://panel.example.test' },
    registration: {
      async showNotification(title: string, options: any) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() { return []; },
      async openWindow(url: string) { openedUrls.push(url); },
    },
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(source, { self, URL });

  let pushWork: Promise<unknown> | undefined;
  listeners.get('push')?.({
    data: { json() { throw new Error('invalid payload'); } },
    waitUntil(work: Promise<unknown>) { pushWork = work; },
  });
  await pushWork;
  assert.deepEqual(JSON.parse(JSON.stringify(notifications)), [{
    title: 'DSDST Panel',
    options: {
      body: 'Yeni bir bildiriminiz var.',
      icon: '/pwa-192x192.png',
      badge: '/favicon-32x32.png',
      tag: 'dsdst-panel-notification',
      data: { url: 'https://panel.example.test/' },
    },
  }]);

  let clickWork: Promise<unknown> | undefined;
  listeners.get('notificationclick')?.({
    notification: { data: { url: 'https://attacker.example/' }, close() {} },
    waitUntil(work: Promise<unknown>) { clickWork = work; },
  });
  await clickWork;
  assert.deepEqual(openedUrls, ['https://panel.example.test/']);
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { NOTIFICATION_PREFERENCES_SCHEMA_V89 } from '../db/notificationPreferencesSchema.js';
import { NOTIFICATION_TEMPLATES_SCHEMA_V90 } from '../db/notificationTemplatesSchema.js';
import { PUSH_SUBSCRIPTIONS_SCHEMA_V88 } from '../db/pushSubscriptionsSchema.js';
import { createPushNotificationService } from '../modules/notifications/pushNotificationService.js';
import { createPushNotificationRouter } from './pushNotificationRoutes.js';

const allDisabled = {
  new_order: false,
  order_cancel_return: false,
  shipping_exception: false,
  stock_exception: false,
  goods_receipt_exception: false,
  reconciliation_exception: false,
  integration_exception: false,
  backup_exception: false,
};

async function createHarness(audit?: (...args: any[]) => void) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES (\'user-1\'), (\'user-2\');');
  db.exec(PUSH_SUBSCRIPTIONS_SCHEMA_V88);
  db.exec(NOTIFICATION_PREFERENCES_SCHEMA_V89);
  db.exec(NOTIFICATION_TEMPLATES_SCHEMA_V90);
  const service = createPushNotificationService({
    db,
    env: {
      VAPID_PUBLIC_KEY: 'public-key',
      VAPID_PRIVATE_KEY: 'private-key',
      VAPID_SUBJECT: 'mailto:ops@example.test',
    },
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = String(req.headers['x-test-user'] || '');
    const role = String(req.headers['x-test-role'] || 'user');
    req.user = { id, username: id, role, permissions: { 'panel:read': true }, must_change_password: false, session_epoch: 0 };
    next();
  });
  const requireTemplateAdmin: express.RequestHandler = (req, res, next) => {
    if (req.user?.role === 'admin' || req.user?.permissions?.['settings:admin'] === true) return next();
    return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Yetki gerekli.' } });
  };
  app.use('/api/push', createPushNotificationRouter(service, audit, requireTemplateAdmin));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { db, service, server, baseUrl: `http://127.0.0.1:${address.port}/api/push` };
}

test('preference routes always scope reads and writes to the authenticated user', async (t) => {
  const harness = await createHarness();
  t.after(() => { harness.server.close(); harness.db.close(); });

  const updateResponse = await fetch(`${harness.baseUrl}/preferences`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-user': 'user-1' },
    body: JSON.stringify({ ...allDisabled, user_id: 'user-2' }),
  });
  assert.equal(updateResponse.status, 200);

  const userOne = await fetch(`${harness.baseUrl}/preferences`, { headers: { 'x-test-user': 'user-1' } }).then((res) => res.json());
  const userTwo = await fetch(`${harness.baseUrl}/preferences`, { headers: { 'x-test-user': 'user-2' } }).then((res) => res.json());
  assert.deepEqual(userOne.data, allDisabled);
  assert.deepEqual(userTwo.data, {
    new_order: true,
    order_cancel_return: true,
    shipping_exception: true,
    stock_exception: true,
    goods_receipt_exception: true,
    reconciliation_exception: true,
    integration_exception: true,
    backup_exception: true,
  });
});

test('admin can update and reset global notification templates', async (t) => {
  const harness = await createHarness();
  t.after(() => { harness.server.close(); harness.db.close(); });
  const headers = { 'content-type': 'application/json', 'x-test-user': 'admin-user', 'x-test-role': 'admin' };

  harness.db.prepare('INSERT INTO users (id) VALUES (?)').run('admin-user');
  const update = await fetch(`${harness.baseUrl}/templates/new_order`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ title: '{{platform}} siparişi', message: '#{{order_number}} toplam {{total}} TL' }),
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.is_default, false);

  const templates = await fetch(`${harness.baseUrl}/templates`, { headers: { 'x-test-user': 'admin-user', 'x-test-role': 'admin' } }).then((res) => res.json());
  assert.equal(templates.data.find((item: any) => item.category === 'new_order').title, '{{platform}} siparişi');

  const reset = await fetch(`${harness.baseUrl}/templates/new_order/reset`, { method: 'POST', headers });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).data.is_default, true);
});

test('unauthorized users cannot update global notification templates', async (t) => {
  const harness = await createHarness();
  t.after(() => { harness.server.close(); harness.db.close(); });
  const response = await fetch(`${harness.baseUrl}/templates/new_order`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-test-user': 'user-1', 'x-test-role': 'user' },
    body: JSON.stringify({ title: 'Changed', message: '#{{order_number}}' }),
  });
  assert.equal(response.status, 403);
  assert.equal((harness.db.prepare('SELECT COUNT(*) AS count FROM notification_templates').get() as { count: number }).count, 0);
});

test('explicit rebind route transfers ownership and emits an audit event', async (t) => {
  const auditEvents: any[][] = [];
  const harness = await createHarness((...args) => auditEvents.push(args));
  t.after(() => { harness.server.close(); harness.db.close(); });
  const subscription = {
    endpoint: 'https://push.example.test/device-1',
    expirationTime: null,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
  };
  harness.service.subscribe('user-1', subscription);

  const response = await fetch(`${harness.baseUrl}/rebind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': 'user-2' },
    body: JSON.stringify(subscription),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { created: false, subscribed: true, rebound: true });
  assert.equal(
    (harness.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint) as { user_id: string }).user_id,
    'user-2',
  );
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0][0], 'PUSH_SUBSCRIPTION_REBOUND');
  assert.deepEqual(auditEvents[0][3], { previous_user_id: 'user-1', new_user_id: 'user-2', rebound: true });
});

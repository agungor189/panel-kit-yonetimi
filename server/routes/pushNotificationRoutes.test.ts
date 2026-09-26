import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import { NOTIFICATION_PREFERENCES_SCHEMA_V89 } from '../db/notificationPreferencesSchema.js';
import { PUSH_SUBSCRIPTIONS_SCHEMA_V88 } from '../db/pushSubscriptionsSchema.js';
import { createPushNotificationService } from '../modules/notifications/pushNotificationService.js';
import { createPushNotificationRouter } from './pushNotificationRoutes.js';

const allDisabled = {
  new_order: false,
  shipping_exception: false,
  critical_stock: false,
  system_exception: false,
};

async function createHarness(audit?: (...args: any[]) => void) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES (\'user-1\'), (\'user-2\');');
  db.exec(PUSH_SUBSCRIPTIONS_SCHEMA_V88);
  db.exec(NOTIFICATION_PREFERENCES_SCHEMA_V89);
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
    req.user = { id, username: id, role: 'user', permissions: { 'panel:read': true }, must_change_password: false, session_epoch: 0 };
    next();
  });
  app.use('/api/push', createPushNotificationRouter(service, audit));
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
    shipping_exception: true,
    critical_stock: true,
    system_exception: true,
  });
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

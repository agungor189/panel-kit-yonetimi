import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { NOTIFICATION_PREFERENCES_SCHEMA_V89 } from '../../db/notificationPreferencesSchema.js';
import { NOTIFICATION_TEMPLATES_SCHEMA_V90 } from '../../db/notificationTemplatesSchema.js';
import { PUSH_SUBSCRIPTIONS_SCHEMA_V88 } from '../../db/pushSubscriptionsSchema.js';
import { PushOwnershipError, PushUnavailableError, createPushNotificationService } from './pushNotificationService.js';

const subscription = (endpoint = 'https://push.example.test/device-1') => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
});

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users (id) VALUES (\'user-1\'), (\'user-2\');');
  db.exec(PUSH_SUBSCRIPTIONS_SCHEMA_V88);
  db.exec(NOTIFICATION_PREFERENCES_SCHEMA_V89);
  db.exec(NOTIFICATION_TEMPLATES_SCHEMA_V90);
  return db;
}

function configuredEnv() {
  return {
    VAPID_PUBLIC_KEY: 'public-key',
    VAPID_PRIVATE_KEY: 'private-key',
    VAPID_SUBJECT: 'mailto:ops@example.test',
  };
}

const disabledPreferences = {
  new_order: false,
  order_cancel_return: false,
  shipping_exception: false,
  stock_exception: false,
  goods_receipt_exception: false,
  reconciliation_exception: false,
  integration_exception: false,
  backup_exception: false,
};

test('notification preferences read defaults and persist updates for the authenticated user', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  assert.deepEqual(service.getPreferences('user-1'), {
    new_order: true,
    order_cancel_return: true,
    shipping_exception: true,
    stock_exception: true,
    goods_receipt_exception: true,
    reconciliation_exception: true,
    integration_exception: true,
    backup_exception: true,
  });
  assert.deepEqual(service.updatePreferences('user-1', disabledPreferences), disabledPreferences);
  assert.deepEqual(service.getPreferences('user-1'), disabledPreferences);
  db.close();
});

test('notification preferences remain isolated between users', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  service.updatePreferences('user-1', disabledPreferences);
  assert.deepEqual(service.getPreferences('user-2'), {
    new_order: true,
    order_cancel_return: true,
    shipping_exception: true,
    stock_exception: true,
    goods_receipt_exception: true,
    reconciliation_exception: true,
    integration_exception: true,
    backup_exception: true,
  });
  db.close();
});

test('device endpoint ownership conflict does not silently transfer ownership', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  service.subscribe('user-1', subscription());
  assert.throws(() => service.subscribe('user-2', subscription()), PushOwnershipError);
  assert.equal(
    (db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(subscription().endpoint) as { user_id: string }).user_id,
    'user-1',
  );
  db.close();
});

test('explicit device rebind transfers the endpoint to the authenticated user', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  service.subscribe('user-1', subscription());
  const result = service.rebind('user-2', subscription());
  assert.equal(result.rebound, true);
  assert.equal(result.previousOwnerId, 'user-1');
  assert.equal(
    (db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(subscription().endpoint) as { user_id: string }).user_id,
    'user-2',
  );
  db.close();
});

test('previous user no longer owns an endpoint after explicit rebind', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  service.subscribe('user-1', subscription());
  service.rebind('user-2', subscription());
  const endpointHash = createHash('sha256').update(subscription().endpoint).digest('hex');
  assert.equal(service.status('user-1', endpointHash).subscribed, false);
  assert.equal(service.status('user-2', endpointHash).subscribed, true);
  db.close();
});

test('subscription create is idempotent per user and endpoint', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });

  assert.equal(service.subscribe('user-1', subscription()).created, true);
  assert.equal(service.subscribe('user-1', {
    ...subscription(),
    keys: { p256dh: 'updated-p256dh', auth: 'updated-auth' },
  }).created, false);

  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count, 1);
  assert.deepEqual(
    db.prepare('SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions').get(),
    {
      user_id: 'user-1',
      endpoint: 'https://push.example.test/device-1',
      p256dh: 'updated-p256dh',
      auth: 'updated-auth',
    },
  );
  assert.equal(
    service.status('user-1', createHash('sha256').update(subscription().endpoint).digest('hex')).subscribed,
    true,
  );
  db.close();
});

test('unsubscribe cannot remove another user subscription', () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: { setVapidDetails() {}, async sendNotification() {} },
  });
  service.subscribe('user-1', subscription());

  assert.equal(service.unsubscribe('user-2', subscription().endpoint).removed, false);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count, 1);
  assert.equal(service.unsubscribe('user-1', subscription().endpoint).removed, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count, 0);
  db.close();
});

test('missing VAPID config reports unavailable without crashing', async () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: {},
    transport: { setVapidDetails() { throw new Error('must not configure'); }, async sendNotification() {} },
  });

  assert.deepEqual(service.status('user-1'), {
    available: false,
    reason: 'VAPID_NOT_CONFIGURED',
    publicKey: null,
    subscriptionCount: 0,
    subscribed: false,
  });
  await assert.rejects(() => service.sendTest('user-1'), PushUnavailableError);
  db.close();
});

test('expired subscriptions are removed after a 410 response', async () => {
  const db = createDb();
  const service = createPushNotificationService({
    db,
    env: configuredEnv(),
    transport: {
      setVapidDetails() {},
      async sendNotification() {
        throw Object.assign(new Error('expired'), { statusCode: 410 });
      },
    },
  });
  service.subscribe('user-1', subscription());

  assert.deepEqual(await service.sendTest('user-1', subscription().endpoint), {
    sent: 0,
    expired: 1,
    failed: 0,
  });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get() as { count: number }).count, 0);
  db.close();
});

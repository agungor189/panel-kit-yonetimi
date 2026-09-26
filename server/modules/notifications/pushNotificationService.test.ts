import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { PUSH_SUBSCRIPTIONS_SCHEMA_V88 } from '../../db/pushSubscriptionsSchema.js';
import { PushUnavailableError, createPushNotificationService } from './pushNotificationService.js';

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
  return db;
}

function configuredEnv() {
  return {
    VAPID_PUBLIC_KEY: 'public-key',
    VAPID_PRIVATE_KEY: 'private-key',
    VAPID_SUBJECT: 'mailto:ops@example.test',
  };
}

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

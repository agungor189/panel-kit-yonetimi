import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type PushTransport = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
    options?: { TTL?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string },
  ): Promise<unknown>;
};

type PushServiceDependencies = {
  db: Database.Database;
  transport: PushTransport;
  env?: Record<string, string | undefined>;
  idFactory?: () => string;
};

type SubscriptionRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export class PushValidationError extends Error {}
export class PushOwnershipError extends Error {}
export class PushUnavailableError extends Error {}
export class PushSubscriptionNotFoundError extends Error {}

function validateSubscription(input: PushSubscriptionInput): PushSubscriptionInput {
  const endpoint = String(input?.endpoint || '').trim();
  const p256dh = String(input?.keys?.p256dh || '').trim();
  const auth = String(input?.keys?.auth || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new PushValidationError('Geçerli push endpoint zorunludur.');
  }
  if (parsed.protocol !== 'https:' || endpoint.length > 2048) {
    throw new PushValidationError('Push endpoint HTTPS olmalıdır.');
  }
  if (!p256dh || !auth || p256dh.length > 1024 || auth.length > 1024) {
    throw new PushValidationError('Push subscription anahtarları geçersiz.');
  }
  const expirationTime = input.expirationTime == null ? null : Number(input.expirationTime);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime < 0)) {
    throw new PushValidationError('Push subscription sona erme zamanı geçersiz.');
  }
  return { endpoint, expirationTime, keys: { p256dh, auth } };
}

export function createPushNotificationService({
  db,
  transport,
  env = process.env,
  idFactory = randomUUID,
}: PushServiceDependencies) {
  const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  let unavailableReason: 'VAPID_NOT_CONFIGURED' | 'VAPID_CONFIGURATION_INVALID' | null = null;

  if (!publicKey || !privateKey || !subject) {
    unavailableReason = 'VAPID_NOT_CONFIGURED';
  } else {
    try {
      transport.setVapidDetails(subject, publicKey, privateKey);
    } catch {
      unavailableReason = 'VAPID_CONFIGURATION_INVALID';
    }
  }

  const status = (userId: string, endpointHash?: string) => {
    const endpoints = db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as Array<{ endpoint: string }>;
    const subscribed = Boolean(endpointHash && /^[a-f0-9]{64}$/.test(endpointHash) && endpoints.some(({ endpoint }) => (
      createHash('sha256').update(endpoint).digest('hex') === endpointHash
    )));
    return {
      available: unavailableReason === null,
      reason: unavailableReason,
      publicKey: unavailableReason === null ? publicKey : null,
      subscriptionCount: endpoints.length,
      subscribed,
    };
  };

  const subscribe = (userId: string, rawSubscription: PushSubscriptionInput) => {
    if (unavailableReason) throw new PushUnavailableError('Web Push sunucu yapılandırması hazır değil.');
    const subscription = validateSubscription(rawSubscription);
    const endpointOwner = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?')
      .get(subscription.endpoint) as { user_id: string } | undefined;
    if (endpointOwner && endpointOwner.user_id !== userId) {
      throw new PushOwnershipError('Bu cihaz endpoint’i başka bir kullanıcıya kayıtlı.');
    }
    const existing = Boolean(db.prepare(
      'SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
    ).get(userId, subscription.endpoint));
    db.prepare(`
      INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, expiration_time)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        expiration_time = excluded.expiration_time,
        failure_count = 0,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      idFactory(),
      userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.expirationTime ?? null,
    );
    return { created: !existing, subscribed: true };
  };

  const unsubscribe = (userId: string, endpoint: string) => {
    const normalizedEndpoint = String(endpoint || '').trim();
    if (!normalizedEndpoint) throw new PushValidationError('Push endpoint zorunludur.');
    const result = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
      .run(userId, normalizedEndpoint);
    return { removed: result.changes === 1 };
  };

  const sendTest = async (userId: string, endpoint?: string) => {
    if (unavailableReason) throw new PushUnavailableError('Web Push sunucu yapılandırması hazır değil.');
    const rows = (endpoint
      ? db.prepare(`
          SELECT id, user_id, endpoint, p256dh, auth
          FROM push_subscriptions WHERE user_id = ? AND endpoint = ?
        `).all(userId, endpoint)
      : db.prepare(`
          SELECT id, user_id, endpoint, p256dh, auth
          FROM push_subscriptions WHERE user_id = ?
        `).all(userId)) as SubscriptionRow[];
    if (rows.length === 0) throw new PushSubscriptionNotFoundError('Bu kullanıcıya ait aktif push subscription bulunamadı.');

    const payload = JSON.stringify({
      title: 'DSDST Panel',
      body: 'Test bildirimi başarıyla gönderildi.',
      url: '/settings',
      tag: 'dsdst-test-notification',
    });
    const result = { sent: 0, expired: 0, failed: 0 };

    for (const row of rows) {
      try {
        await transport.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { TTL: 60, urgency: 'normal', topic: 'dsdst-test' },
        );
        db.prepare(`
          UPDATE push_subscriptions
          SET last_success_at = CURRENT_TIMESTAMP, failure_count = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ?
        `).run(row.id, userId);
        result.sent += 1;
      } catch (error) {
        const statusCode = Number((error as { statusCode?: number })?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(row.id, userId);
          result.expired += 1;
        } else {
          db.prepare(`
            UPDATE push_subscriptions
            SET failure_count = failure_count + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ?
          `).run(row.id, userId);
          result.failed += 1;
        }
      }
    }
    return result;
  };

  return { status, subscribe, unsubscribe, sendTest };
}

export type PushNotificationService = ReturnType<typeof createPushNotificationService>;

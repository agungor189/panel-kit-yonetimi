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

export type NotificationPreferences = {
  new_order: boolean;
  shipping_exception: boolean;
  critical_stock: boolean;
  system_exception: boolean;
};

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  new_order: true,
  shipping_exception: true,
  critical_stock: true,
  system_exception: true,
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

type NotificationPreferencesRow = {
  new_order: number;
  shipping_exception: number;
  critical_stock: number;
  system_exception: number;
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

function validatePreferences(input: NotificationPreferences): NotificationPreferences {
  const keys: Array<keyof NotificationPreferences> = [
    'new_order',
    'shipping_exception',
    'critical_stock',
    'system_exception',
  ];
  if (!input || typeof input !== 'object' || keys.some((key) => typeof input[key] !== 'boolean')) {
    throw new PushValidationError('Bildirim tercihleri geçersiz.');
  }
  return Object.fromEntries(keys.map((key) => [key, input[key]])) as NotificationPreferences;
}

const hashEndpoint = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

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

  const saveOwnedSubscription = (userId: string, subscription: PushSubscriptionInput) => {
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

  const transferSubscription = db.transaction((userId: string, subscription: PushSubscriptionInput) => {
    const owner = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?')
      .get(subscription.endpoint) as { user_id: string } | undefined;
    if (!owner || owner.user_id === userId) {
      return {
        ...saveOwnedSubscription(userId, subscription),
        rebound: false,
        previousOwnerId: owner?.user_id ?? null,
        endpointHash: hashEndpoint(subscription.endpoint),
      };
    }

    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
    saveOwnedSubscription(userId, subscription);
    return {
      created: false,
      subscribed: true,
      rebound: true,
      previousOwnerId: owner.user_id,
      endpointHash: hashEndpoint(subscription.endpoint),
    };
  });

  const status = (userId: string, endpointHash?: string) => {
    const endpoints = db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?')
      .all(userId) as Array<{ endpoint: string }>;
    const subscribed = Boolean(endpointHash && /^[a-f0-9]{64}$/.test(endpointHash) && endpoints.some(({ endpoint }) => (
      hashEndpoint(endpoint) === endpointHash
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
    return saveOwnedSubscription(userId, subscription);
  };

  const rebind = (userId: string, rawSubscription: PushSubscriptionInput) => {
    if (unavailableReason) throw new PushUnavailableError('Web Push sunucu yapılandırması hazır değil.');
    return transferSubscription(userId, validateSubscription(rawSubscription));
  };

  const getPreferences = (userId: string): NotificationPreferences => {
    const row = db.prepare(`
      SELECT new_order, shipping_exception, critical_stock, system_exception
      FROM user_notification_preferences WHERE user_id = ?
    `).get(userId) as NotificationPreferencesRow | undefined;
    if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return {
      new_order: row.new_order === 1,
      shipping_exception: row.shipping_exception === 1,
      critical_stock: row.critical_stock === 1,
      system_exception: row.system_exception === 1,
    };
  };

  const updatePreferences = (userId: string, rawPreferences: NotificationPreferences) => {
    const preferences = validatePreferences(rawPreferences);
    db.prepare(`
      INSERT INTO user_notification_preferences (
        user_id, new_order, shipping_exception, critical_stock, system_exception
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        new_order = excluded.new_order,
        shipping_exception = excluded.shipping_exception,
        critical_stock = excluded.critical_stock,
        system_exception = excluded.system_exception,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      Number(preferences.new_order),
      Number(preferences.shipping_exception),
      Number(preferences.critical_stock),
      Number(preferences.system_exception),
    );
    return preferences;
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

  return { status, subscribe, rebind, unsubscribe, getPreferences, updatePreferences, sendTest };
}

export type PushNotificationService = ReturnType<typeof createPushNotificationService>;

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  NOTIFICATION_CATEGORIES,
  isNotificationCategory,
  renderNotificationTemplate,
  resolveNotificationTemplate,
  validateNotificationTemplate,
  type NotificationCategory,
  type NotificationTemplateInput,
} from '../../../shared/notificationTemplates.js';

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type NotificationPreferences = Record<NotificationCategory, boolean>;

const DEFAULT_NOTIFICATION_PREFERENCES = Object.fromEntries(
  NOTIFICATION_CATEGORIES.map((category) => [category, true]),
) as NotificationPreferences;

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
  order_cancel_return: number;
  shipping_exception: number;
  stock_exception: number;
  goods_receipt_exception: number;
  reconciliation_exception: number;
  integration_exception: number;
  backup_exception: number;
};

type NotificationTemplateRow = {
  category: string;
  title_template: string;
  message_template: string;
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
  if (!input || typeof input !== 'object' || NOTIFICATION_CATEGORIES.some((key) => typeof input[key] !== 'boolean')) {
    throw new PushValidationError('Bildirim tercihleri geçersiz.');
  }
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((key) => [key, input[key]])) as NotificationPreferences;
}

function validateCategory(value: unknown): NotificationCategory {
  if (!isNotificationCategory(value)) throw new PushValidationError('Bildirim kategorisi geçersiz.');
  return value;
}

function validateTemplate(category: NotificationCategory, input: NotificationTemplateInput) {
  try {
    return validateNotificationTemplate(category, input);
  } catch (error) {
    throw new PushValidationError(error instanceof Error ? error.message : 'Bildirim şablonu geçersiz.');
  }
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
      SELECT new_order, order_cancel_return, shipping_exception, stock_exception,
             goods_receipt_exception, reconciliation_exception, integration_exception, backup_exception
      FROM user_notification_preferences WHERE user_id = ?
    `).get(userId) as NotificationPreferencesRow | undefined;
    if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return Object.fromEntries(
      NOTIFICATION_CATEGORIES.map((category) => [category, row[category] === 1]),
    ) as NotificationPreferences;
  };

  const updatePreferences = (userId: string, rawPreferences: NotificationPreferences) => {
    const preferences = validatePreferences(rawPreferences);
    db.prepare(`
      INSERT INTO user_notification_preferences (
        user_id, new_order, order_cancel_return, shipping_exception, stock_exception,
        goods_receipt_exception, reconciliation_exception, integration_exception, backup_exception
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        new_order = excluded.new_order,
        order_cancel_return = excluded.order_cancel_return,
        shipping_exception = excluded.shipping_exception,
        stock_exception = excluded.stock_exception,
        goods_receipt_exception = excluded.goods_receipt_exception,
        reconciliation_exception = excluded.reconciliation_exception,
        integration_exception = excluded.integration_exception,
        backup_exception = excluded.backup_exception,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      Number(preferences.new_order),
      Number(preferences.order_cancel_return),
      Number(preferences.shipping_exception),
      Number(preferences.stock_exception),
      Number(preferences.goods_receipt_exception),
      Number(preferences.reconciliation_exception),
      Number(preferences.integration_exception),
      Number(preferences.backup_exception),
    );
    return preferences;
  };

  const getTemplates = () => {
    const rows = db.prepare(`
      SELECT category, title_template, message_template FROM notification_templates
    `).all() as NotificationTemplateRow[];
    const overrides = new Map(rows.map((row) => [row.category, row]));
    return NOTIFICATION_CATEGORIES.map((category) => {
      const row = overrides.get(category);
      const resolved = resolveNotificationTemplate(category, row
        ? { title: row.title_template, message: row.message_template }
        : null);
      const isValidOverride = Boolean(row)
        && resolved.title === row!.title_template.trim()
        && resolved.message === row!.message_template.trim();
      return { category, ...resolved, is_default: !isValidOverride };
    });
  };

  const updateTemplate = (categoryValue: unknown, rawTemplate: NotificationTemplateInput, userId: string) => {
    const category = validateCategory(categoryValue);
    const template = validateTemplate(category, rawTemplate);
    db.prepare(`
      INSERT INTO notification_templates (category, title_template, message_template, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(category) DO UPDATE SET
        title_template = excluded.title_template,
        message_template = excluded.message_template,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(category, template.title, template.message, userId);
    return { category, ...template, is_default: false };
  };

  const resetTemplate = (categoryValue: unknown) => {
    const category = validateCategory(categoryValue);
    db.prepare('DELETE FROM notification_templates WHERE category = ?').run(category);
    return { category, ...DEFAULT_NOTIFICATION_TEMPLATES[category], is_default: true };
  };

  const renderTemplate = (categoryValue: unknown, variables: Record<string, unknown>) => {
    const category = validateCategory(categoryValue);
    const row = db.prepare(`
      SELECT title_template, message_template FROM notification_templates WHERE category = ?
    `).get(category) as Omit<NotificationTemplateRow, 'category'> | undefined;
    return renderNotificationTemplate(
      category,
      variables,
      row ? { title: row.title_template, message: row.message_template } : null,
    );
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

  return {
    status,
    subscribe,
    rebind,
    unsubscribe,
    getPreferences,
    updatePreferences,
    getTemplates,
    updateTemplate,
    resetTemplate,
    renderTemplate,
    sendTest,
  };
}

export type PushNotificationService = ReturnType<typeof createPushNotificationService>;

export const NOTIFICATION_CATEGORIES = [
  'new_order',
  'order_cancel_return',
  'shipping_exception',
  'stock_exception',
  'goods_receipt_exception',
  'reconciliation_exception',
  'integration_exception',
  'backup_exception',
] as const;

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number];
export type NotificationTemplateInput = { title: string; message: string };

export const NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH = 120;
export const NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH = 300;

export const DEFAULT_NOTIFICATION_TEMPLATES: Record<NotificationCategory, NotificationTemplateInput> = {
  new_order: { title: 'Yeni {{platform}} Siparişi', message: '#{{order_number}} — {{total}} TL' },
  order_cancel_return: { title: 'Sipariş İptal / İade', message: '#{{order_number}} için {{action}} talebi oluştu' },
  shipping_exception: { title: 'Sevkiyat Hatası', message: '#{{order_number}} gönderimi tamamlanamadı' },
  stock_exception: { title: 'Stok Uyarısı', message: '{{sku}} — {{message}}' },
  goods_receipt_exception: { title: 'Mal Kabul Farkı', message: '{{reference}} — {{message}}' },
  reconciliation_exception: { title: 'Sistem Uyuşmazlığı', message: '{{message}}' },
  integration_exception: { title: 'Entegrasyon Hatası', message: '{{integration}} — {{message}}' },
  backup_exception: { title: 'Backup / DR Hatası', message: '{{message}}' },
};

export const NOTIFICATION_TEMPLATE_VARIABLES: Record<NotificationCategory, readonly string[]> = {
  new_order: ['platform', 'order_number', 'total'],
  order_cancel_return: ['order_number', 'action'],
  shipping_exception: ['order_number'],
  stock_exception: ['sku', 'message'],
  goods_receipt_exception: ['reference', 'message'],
  reconciliation_exception: ['message'],
  integration_exception: ['integration', 'message'],
  backup_exception: ['message'],
};

export const NOTIFICATION_TEMPLATE_PREVIEW_VALUES: Record<NotificationCategory, Record<string, string>> = {
  new_order: { platform: 'Trendyol', order_number: '12345', total: '1.250,00' },
  order_cancel_return: { order_number: '12345', action: 'iade' },
  shipping_exception: { order_number: '12345' },
  stock_exception: { sku: 'SKU-42', message: 'Stok kritik seviyede' },
  goods_receipt_exception: { reference: 'MK-1024', message: 'Miktar farkı tespit edildi' },
  reconciliation_exception: { message: 'Sipariş ve finans kayıtları uyuşmuyor' },
  integration_exception: { integration: 'Shopify', message: 'Bağlantı kurulamadı' },
  backup_exception: { message: 'Yedekleme tamamlanamadı' },
};

const VARIABLE_PATTERN = /{{\s*([a-z_][a-z0-9_]*)\s*}}/g;

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function validateNotificationTemplate(
  category: NotificationCategory,
  input: NotificationTemplateInput,
): NotificationTemplateInput {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (!title || !message) throw new Error('Bildirim başlığı ve mesajı boş bırakılamaz.');
  if (title.length > NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH) {
    throw new Error(`Bildirim başlığı en fazla ${NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH} karakter olabilir.`);
  }
  if (message.length > NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH) {
    throw new Error(`Bildirim mesajı en fazla ${NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH} karakter olabilir.`);
  }
  if (/[\r\n]/.test(title)) throw new Error('Bildirim başlığı tek satır olmalıdır.');

  const allowed = new Set(NOTIFICATION_TEMPLATE_VARIABLES[category]);
  for (const text of [title, message]) {
    const matches = [...text.matchAll(VARIABLE_PATTERN)];
    for (const match of matches) {
      if (!allowed.has(match[1])) throw new Error(`Bilinmeyen (unknown) template variable: {{${match[1]}}}.`);
    }
    const withoutVariables = text.replace(VARIABLE_PATTERN, '');
    if (withoutVariables.includes('{{') || withoutVariables.includes('}}')) {
      throw new Error('Template variable biçimi geçersiz.');
    }
  }
  return { title, message };
}

export function resolveNotificationTemplate(
  category: NotificationCategory,
  input?: NotificationTemplateInput | null,
): NotificationTemplateInput {
  try {
    return validateNotificationTemplate(category, input as NotificationTemplateInput);
  } catch {
    return { ...DEFAULT_NOTIFICATION_TEMPLATES[category] };
  }
}

export function renderNotificationTemplate(
  category: NotificationCategory,
  variables: Record<string, unknown>,
  input?: NotificationTemplateInput | null,
): NotificationTemplateInput {
  const template = resolveNotificationTemplate(category, input);
  const render = (text: string) => text.replace(VARIABLE_PATTERN, (_token, variable: string) => {
    if (!NOTIFICATION_TEMPLATE_VARIABLES[category].includes(variable)) return '';
    const value = variables?.[variable];
    return value == null ? '' : String(value).slice(0, NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH);
  });
  return {
    title: render(template.title).replace(/[\r\n]+/g, ' ').trim().slice(0, NOTIFICATION_TEMPLATE_TITLE_MAX_LENGTH),
    message: render(template.message).trim().slice(0, NOTIFICATION_TEMPLATE_MESSAGE_MAX_LENGTH),
  };
}

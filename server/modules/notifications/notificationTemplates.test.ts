import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  renderNotificationTemplate,
  validateNotificationTemplate,
} from '../../../shared/notificationTemplates.js';

test('template validation accepts allowed variables and rejects unknown variables', () => {
  assert.deepEqual(
    validateNotificationTemplate('new_order', {
      title: 'Yeni {{platform}} Siparişi',
      message: '#{{order_number}} — {{total}} TL',
    }),
    DEFAULT_NOTIFICATION_TEMPLATES.new_order,
  );
  assert.throws(() => validateNotificationTemplate('new_order', {
    title: 'Yeni {{unknown}} Siparişi',
    message: '#{{order_number}}',
  }), /unknown/);
  assert.throws(() => validateNotificationTemplate('new_order', { title: '', message: 'Mesaj' }), /boş/);
  assert.throws(() => validateNotificationTemplate('new_order', { title: 'x'.repeat(121), message: 'Mesaj' }), /120/);
  assert.throws(() => validateNotificationTemplate('new_order', { title: 'Başlık', message: 'x'.repeat(301) }), /300/);
});

test('template rendering substitutes variables and safely falls back to defaults', () => {
  assert.deepEqual(renderNotificationTemplate('stock_exception', {
    sku: 'SKU-42',
    message: 'Stok kritik seviyede',
  }, {
    title: 'Özel {{sku}}',
    message: '{{message}}',
  }), {
    title: 'Özel SKU-42',
    message: 'Stok kritik seviyede',
  });

  assert.deepEqual(renderNotificationTemplate('backup_exception', { message: 'Yedek alınamadı' }, {
    title: '',
    message: '{{broken}}',
  }), {
    title: 'Backup / DR Hatası',
    message: 'Yedek alınamadı',
  });
});

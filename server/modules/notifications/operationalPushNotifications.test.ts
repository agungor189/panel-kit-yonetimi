import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/initialize.js';
import { createOperationalPushNotifications } from './operationalPushNotifications.js';

test('goods receipt and backup failures use canonical records and stable dedupe identities', async () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  db.pragma('foreign_keys = OFF');
  db.prepare(`INSERT INTO warehouse_goods_receipts (
    id,receipt_series_id,stage_index,is_final,partial_policy,acquisition_cost_snapshot_id,purchase_order_id,
    purchase_line_id,product_id,supplier_lot_code,base_uom_code_snapshot,expected_quantity_base_int,
    accepted_quantity_base_int,damaged_quantity_base_int,variance_quantity_base_int,shortage_quantity_base_int,
    excess_quantity_base_int,status,receipt_operation_id,received_at
  ) VALUES ('receipt-1','series-1',1,1,'DISABLED','cost-1','PO-42','line-1','product-1','LOT-1','piece',10,7,1,-2,2,0,
    'ACCEPTED_WITH_VARIANCE','receipt-op-1','2026-09-26T10:00:00.000Z')`).run();
  db.prepare(`INSERT INTO backup_runs (id,trigger_type,backup_kind,status,cloud_status)
    VALUES ('backup-1','scheduled','database','failed','failed')`).run();
  db.pragma('foreign_keys = ON');

  const notifications: any[] = [];
  const bridge = createOperationalPushNotifications(db, {
    async sendOperational(input) {
      notifications.push(input);
      return { sent: 1, expired: 0, failed: 0, skipped: 0, duplicate: false, unavailable: false };
    },
  });

  await bridge.goodsReceiptException({ receiptId: 'receipt-1' });
  await bridge.backupException({ runId: 'backup-1', phase: 'local' });
  await bridge.backupException({ runId: 'backup-1', phase: 'cloud' });

  assert.deepEqual(notifications[0].variables, { reference: 'PO-42', message: '2 eksik, 1 hasarlı' });
  assert.equal(notifications[0].dedupeKey, 'goods_receipt_exception:receipt-1');
  assert.equal(notifications[1].dedupeKey, 'backup_exception:backup-1:local');
  assert.equal(notifications[2].dedupeKey, 'backup_exception:backup-1:cloud');
  db.close();
});

test('integration incidents use one persistent dedupe identity', async () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const notifications: any[] = [];
  const bridge = createOperationalPushNotifications(db, {
    async sendOperational(input) {
      notifications.push(input);
      return { sent: 1, expired: 0, failed: 0, skipped: 0, duplicate: false, unavailable: false };
    },
  });
  await bridge.integrationException({ incidentId: 'shopify:account-1:episode-1', integration: 'SHOPIFY', message: 'SHOPIFY_POLL_FAILED' });
  assert.equal(notifications[0].dedupeKey, 'integration_exception:shopify:account-1:episode-1');
  assert.deepEqual(notifications[0].variables, { integration: 'SHOPIFY', message: 'SHOPIFY_POLL_FAILED' });
  db.close();
});

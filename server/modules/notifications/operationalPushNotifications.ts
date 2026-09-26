import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PushNotificationService } from './pushNotificationService.js';

export type OrderAcceptedNotification = {
  eventType: 'channel.order.accepted.v1';
  saleId: string;
  channelOrderId: string;
};

export type ShippingExceptionNotification = {
  shipmentId: string;
  jobId: string;
};

export type OrderCancelReturnNotification = {
  eventType: 'channel.order.cancelled.v1' | 'channel.return.requested.v1';
  saleId: string;
  channelOrderId: string;
};

export type StockExceptionNotification = {
  exceptionType: 'STOCK_EXCEPTION';
  exceptionId: string;
  channelOrderId: string;
  productId: string;
};

export type GoodsReceiptExceptionNotification = {
  receiptId: string;
};

export type ReconciliationExceptionNotification = {
  findingId: string;
  runId: string;
};

export type IntegrationExceptionNotification = {
  incidentId: string;
  integration: string;
  message: string;
};

export type BackupExceptionNotification = {
  runId: string;
  phase: 'local' | 'cloud';
};

const formatMinor = (minor: number) => (minor / 100).toFixed(2);

export function createOperationalPushNotifications(
  db: Database.Database,
  push: Pick<PushNotificationService, 'sendOperational'>,
) {
  const orderAccepted = async (event: OrderAcceptedNotification) => {
    const row = db.prepare(`
      SELECT a.channel, o.external_order_id, f.gross_amount_minor
      FROM channel_orders o
      JOIN channel_accounts a ON a.id = o.account_id
      JOIN sale_financial_snapshots f ON f.sale_id = o.sale_id
      WHERE o.id = ? AND o.sale_id = ? AND o.order_state = 'ACCEPTED'
      ORDER BY f.snapshot_version DESC
      LIMIT 1
    `).get(event.channelOrderId, event.saleId) as {
      channel: string;
      external_order_id: string;
      gross_amount_minor: number;
    } | undefined;
    if (!row || !Number.isSafeInteger(row.gross_amount_minor)) return null;

    return push.sendOperational({
      category: 'new_order',
      variables: {
        platform: row.channel,
        order_number: row.external_order_id,
        total: formatMinor(row.gross_amount_minor),
      },
      targetUrl: `/sales?order=${encodeURIComponent(event.saleId)}`,
      tag: `new-order-${event.saleId}`,
      dedupeKey: `${event.eventType}:${event.saleId}`,
    });
  };

  const shippingException = async (event: ShippingExceptionNotification) => {
    const row = db.prepare(`
      SELECT s.order_code
      FROM shipment_preparations p
      JOIN sales s ON s.id = p.order_id
      WHERE p.id = ?
    `).get(event.shipmentId) as { order_code: string } | undefined;
    if (!row) return null;

    return push.sendOperational({
      category: 'shipping_exception',
      variables: { order_number: row.order_code },
      targetUrl: `/sales?shipment=${encodeURIComponent(event.shipmentId)}`,
      tag: `shipping-exception-${event.jobId}`,
      dedupeKey: `shipping_exception:${event.jobId}`,
    });
  };

  const orderCancelReturn = async (event: OrderCancelReturnNotification) => {
    const row = db.prepare(`
      SELECT o.external_order_id
      FROM channel_orders o
      WHERE o.id = ? AND o.sale_id = ?
    `).get(event.channelOrderId, event.saleId) as { external_order_id: string } | undefined;
    if (!row) return null;

    return push.sendOperational({
      category: 'order_cancel_return',
      variables: {
        order_number: row.external_order_id,
        action: event.eventType === 'channel.order.cancelled.v1' ? 'İptal' : 'İade',
      },
      targetUrl: `/sales?order=${encodeURIComponent(event.saleId)}`,
      tag: `order-transition-${event.saleId}`,
      dedupeKey: `${event.eventType}:${event.saleId}`,
    });
  };

  const stockException = async (event: StockExceptionNotification) => {
    const row = db.prepare(`
      SELECT p.sku
      FROM channel_exceptions e
      JOIN products p ON p.id = ?
      WHERE e.id = ?
        AND e.channel_order_id = ?
        AND e.exception_type = 'STOCK_EXCEPTION'
        AND e.state = 'OPEN'
    `).get(event.productId, event.exceptionId, event.channelOrderId) as { sku: string | null } | undefined;
    if (!row) return null;
    const dedupeKey = `stock_exception:${event.channelOrderId}:${event.productId}`;

    return push.sendOperational({
      category: 'stock_exception',
      variables: {
        sku: row.sku || event.productId,
        message: 'Sipariş rezervasyonu oluşturulamadı',
      },
      targetUrl: `/products/${encodeURIComponent(event.productId)}`,
      tag: `stock-exception-${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`,
      dedupeKey,
    });
  };

  const goodsReceiptException = async (event: GoodsReceiptExceptionNotification) => {
    const row = db.prepare(`
      SELECT r.id, r.purchase_order_id, r.product_id, r.expected_quantity_base_int,
             r.accepted_quantity_base_int, r.damaged_quantity_base_int,
             r.shortage_quantity_base_int, r.excess_quantity_base_int
      FROM warehouse_goods_receipts r
      WHERE r.id = ?
        AND (r.variance_quantity_base_int <> 0 OR r.damaged_quantity_base_int > 0)
    `).get(event.receiptId) as {
      id: string;
      purchase_order_id: string;
      product_id: string;
      expected_quantity_base_int: number;
      accepted_quantity_base_int: number;
      damaged_quantity_base_int: number;
      shortage_quantity_base_int: number;
      excess_quantity_base_int: number;
    } | undefined;
    if (!row) return null;
    const differences = [
      row.shortage_quantity_base_int > 0 ? `${row.shortage_quantity_base_int} eksik` : null,
      row.excess_quantity_base_int > 0 ? `${row.excess_quantity_base_int} fazla` : null,
      row.damaged_quantity_base_int > 0 ? `${row.damaged_quantity_base_int} hasarlı` : null,
    ].filter(Boolean).join(', ');

    return push.sendOperational({
      category: 'goods_receipt_exception',
      variables: {
        reference: row.purchase_order_id,
        message: differences,
      },
      targetUrl: `/products/${encodeURIComponent(row.product_id)}`,
      tag: `goods-receipt-${event.receiptId}`,
      dedupeKey: `goods_receipt_exception:${event.receiptId}`,
    });
  };

  const reconciliationException = async (event: ReconciliationExceptionNotification) => {
    const row = db.prepare(`
      SELECT code, severity
      FROM reconciliation_findings
      WHERE id = ? AND last_run_id = ? AND status = 'OPEN' AND severity IN ('CRITICAL', 'WARN')
    `).get(event.findingId, event.runId) as { code: string; severity: 'CRITICAL' | 'WARN' } | undefined;
    if (!row) return null;

    return push.sendOperational({
      category: 'reconciliation_exception',
      variables: { message: `${row.code} (${row.severity})` },
      targetUrl: '/reconciliation',
      tag: `reconciliation-${event.findingId}`,
      dedupeKey: `reconciliation_exception:${event.findingId}:${event.runId}`,
    });
  };

  const integrationException = (event: IntegrationExceptionNotification) => push.sendOperational({
    category: 'integration_exception',
    variables: { integration: event.integration, message: event.message },
    targetUrl: '/channels',
    tag: `integration-${createHash('sha256').update(event.incidentId).digest('hex').slice(0, 24)}`,
    dedupeKey: `integration_exception:${event.incidentId}`,
  });

  const backupException = async (event: BackupExceptionNotification) => {
    const row = db.prepare(`
      SELECT backup_kind, status, cloud_status
      FROM backup_runs WHERE id = ?
    `).get(event.runId) as { backup_kind: string; status: string; cloud_status: string | null } | undefined;
    const failed = event.phase === 'local' ? row?.status === 'failed' : row?.cloud_status === 'failed';
    if (!row || !failed) return null;

    return push.sendOperational({
      category: 'backup_exception',
      variables: {
        message: event.phase === 'cloud'
          ? `${row.backup_kind} yedeğinin uzak kopyası oluşturulamadı`
          : `${row.backup_kind} yedeği oluşturulamadı`,
      },
      targetUrl: '/settings',
      tag: `backup-${event.runId}-${event.phase}`,
      dedupeKey: `backup_exception:${event.runId}:${event.phase}`,
    });
  };

  return {
    orderAccepted,
    shippingException,
    orderCancelReturn,
    stockException,
    goodsReceiptException,
    reconciliationException,
    integrationException,
    backupException,
  };
}

export type OperationalPushNotifications = ReturnType<typeof createOperationalPushNotifications>;

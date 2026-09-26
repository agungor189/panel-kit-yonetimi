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

  return { orderAccepted, shippingException };
}

export type OperationalPushNotifications = ReturnType<typeof createOperationalPushNotifications>;

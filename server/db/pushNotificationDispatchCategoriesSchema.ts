export const PUSH_NOTIFICATION_DISPATCH_CATEGORIES_SCHEMA_V92 = String.raw`
ALTER TABLE push_notification_dispatches RENAME TO push_notification_dispatches_v91;

CREATE TABLE push_notification_dispatches (
  dedupe_key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN (
    'new_order',
    'order_cancel_return',
    'shipping_exception',
    'stock_exception'
  )),
  notification_tag TEXT NOT NULL,
  notification_topic TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO push_notification_dispatches
  (dedupe_key, category, notification_tag, notification_topic, target_url, created_at)
SELECT dedupe_key, category, notification_tag, notification_topic, target_url, created_at
FROM push_notification_dispatches_v91;

DROP TABLE push_notification_dispatches_v91;

CREATE INDEX idx_push_notification_dispatches_category_created
  ON push_notification_dispatches(category, created_at);
`;

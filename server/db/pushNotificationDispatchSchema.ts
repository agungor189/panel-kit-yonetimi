export const PUSH_NOTIFICATION_DISPATCH_SCHEMA_V91 = String.raw`
CREATE TABLE push_notification_dispatches (
  dedupe_key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('new_order', 'shipping_exception')),
  notification_tag TEXT NOT NULL,
  notification_topic TEXT NOT NULL,
  target_url TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_push_notification_dispatches_category_created
  ON push_notification_dispatches(category, created_at);
`;

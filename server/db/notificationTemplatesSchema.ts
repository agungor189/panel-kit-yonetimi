export const NOTIFICATION_TEMPLATES_SCHEMA_V90 = `
ALTER TABLE user_notification_preferences ADD COLUMN order_cancel_return INTEGER NOT NULL DEFAULT 1 CHECK(order_cancel_return IN (0, 1));
ALTER TABLE user_notification_preferences ADD COLUMN stock_exception INTEGER NOT NULL DEFAULT 1 CHECK(stock_exception IN (0, 1));
ALTER TABLE user_notification_preferences ADD COLUMN goods_receipt_exception INTEGER NOT NULL DEFAULT 1 CHECK(goods_receipt_exception IN (0, 1));
ALTER TABLE user_notification_preferences ADD COLUMN reconciliation_exception INTEGER NOT NULL DEFAULT 1 CHECK(reconciliation_exception IN (0, 1));
ALTER TABLE user_notification_preferences ADD COLUMN integration_exception INTEGER NOT NULL DEFAULT 1 CHECK(integration_exception IN (0, 1));
ALTER TABLE user_notification_preferences ADD COLUMN backup_exception INTEGER NOT NULL DEFAULT 1 CHECK(backup_exception IN (0, 1));

UPDATE user_notification_preferences
SET stock_exception = critical_stock,
    reconciliation_exception = system_exception,
    integration_exception = system_exception,
    backup_exception = system_exception;

CREATE TABLE notification_templates (
  category          TEXT PRIMARY KEY,
  title_template    TEXT NOT NULL,
  message_template  TEXT NOT NULL,
  updated_by        TEXT,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
);
`;

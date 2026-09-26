export const NOTIFICATION_PREFERENCES_SCHEMA_V89 = `
CREATE TABLE user_notification_preferences (
  user_id               TEXT PRIMARY KEY,
  new_order             INTEGER NOT NULL DEFAULT 1 CHECK(new_order IN (0, 1)),
  shipping_exception    INTEGER NOT NULL DEFAULT 1 CHECK(shipping_exception IN (0, 1)),
  critical_stock        INTEGER NOT NULL DEFAULT 1 CHECK(critical_stock IN (0, 1)),
  system_exception      INTEGER NOT NULL DEFAULT 1 CHECK(system_exception IN (0, 1)),
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PUSH_SUBSCRIPTIONS_SCHEMA_V88 = `
CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  p256dh            TEXT NOT NULL,
  auth              TEXT NOT NULL,
  expiration_time   INTEGER,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_success_at   DATETIME,
  failure_count     INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  UNIQUE(user_id, endpoint),
  UNIQUE(endpoint),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, updated_at);
`;

import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { initializeDatabase, openDatabase } from "../server/db/initialize.js";

if (process.env.NODE_ENV !== "test" || process.env.E2E_ALLOW_SEED !== "true") {
  throw new Error("Operations E2E seed is restricted to NODE_ENV=test with E2E_ALLOW_SEED=true.");
}

const dbPath = process.env.DB_PATH;
const clearApiKey = process.env.E2E_WAREHOUSE_API_KEY;
const hashSecret = process.env.PANEL_API_HASH_SECRET;
if (!dbPath || !clearApiKey || !hashSecret) {
  throw new Error("DB_PATH, E2E_WAREHOUSE_API_KEY and PANEL_API_HASH_SECRET are required.");
}

const db = openDatabase(dbPath);
initializeDatabase(db);

db.prepare(`
  INSERT INTO users (id, username, password_hash, role, must_change_password, is_active)
  VALUES ('operations-e2e-admin', 'admin', ?, 'admin', 1, 1)
  ON CONFLICT(username) DO UPDATE SET
    password_hash = excluded.password_hash,
    role = 'admin',
    must_change_password = 1,
    is_active = 1
`).run(bcrypt.hashSync("admin", 4));

const permissions = [
  "read:warehouse_orders",
  "read:products",
  "read:bom",
  "write:warehouse_status",
  "kit-catalog:read",
];
const keyHash = crypto.createHmac("sha256", hashSecret).update(clearApiKey).digest("hex");
const keyPrefix = clearApiKey.slice(0, 12);
const last4 = clearApiKey.slice(-4);

db.prepare(`
  INSERT INTO panel_api_keys
    (id, name, key_prefix, key_hash, last4, status, environment, permissions)
  VALUES
    ('operations-e2e', 'Operations E2E', ?, ?, ?, 'active', 'test', ?)
  ON CONFLICT(id) DO UPDATE SET
    key_prefix = excluded.key_prefix,
    key_hash = excluded.key_hash,
    last4 = excluded.last4,
    status = 'active',
    permissions = excluded.permissions,
    updated_at = CURRENT_TIMESTAMP,
    deleted_at = NULL,
    revoked_at = NULL
`).run(keyPrefix, keyHash, last4, JSON.stringify(permissions));

db.prepare("UPDATE exchange_rates SET is_active = 0").run();
db.prepare(`
  INSERT INTO exchange_rates (id, base_currency, target_currency, rate, source, is_active)
  VALUES ('operations-e2e-rate', 'USD', 'TRY', 40, 'operations-e2e', 1)
  ON CONFLICT(id) DO UPDATE SET rate = 40, fetched_at = CURRENT_TIMESTAMP, is_active = 1
`).run();

db.close();
console.log("Operations E2E fixtures are ready in the isolated test database.");

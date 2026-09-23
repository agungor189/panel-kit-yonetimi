import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { initializeDatabase, openDatabase } from "../server/db/initialize.js";

if (process.env.NODE_ENV !== "test" || process.env.E2E_ALLOW_SEED !== "true") {
  throw new Error("Operations E2E seed is restricted to NODE_ENV=test with E2E_ALLOW_SEED=true.");
}

const dbPath = process.env.DB_PATH;
const serviceKeys = {
  warehouse: process.env.E2E_WAREHOUSE_API_KEY,
  kitStudio: process.env.E2E_KIT_STUDIO_API_KEY,
  labelPrinter: process.env.E2E_LABEL_PRINTER_API_KEY,
  customerHub: process.env.E2E_CUSTOMER_HUB_API_KEY,
};
const hashSecret = process.env.PANEL_API_HASH_SECRET;
if (!dbPath || !hashSecret || Object.values(serviceKeys).some((value) => !value)) {
  throw new Error("DB_PATH, E2E_WAREHOUSE_API_KEY, E2E_KIT_STUDIO_API_KEY, E2E_LABEL_PRINTER_API_KEY, E2E_CUSTOMER_HUB_API_KEY and PANEL_API_HASH_SECRET are required.");
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

db.prepare(`
  INSERT INTO cash_accounts (id, name, currency, type, opening_balance, is_active)
  VALUES ('operations-e2e-cash', 'Operations E2E Cash', 'TRY', 'cash', 0, 1)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    currency = excluded.currency,
    type = excluded.type,
    opening_balance = 0,
    is_active = 1
`).run();

const authScopes = ["auth:login", "auth:session:validate", "auth:session:revoke", "auth:password:change"];
const principals = [
  { id: "operations-e2e-warehouse", name: "Operations E2E Warehouse", key: serviceKeys.warehouse!, permissions: [...authScopes, "read:warehouse_orders", "read:products", "read:bom", "write:warehouse_status"] },
  { id: "operations-e2e-kit", name: "Operations E2E Kit Studio", key: serviceKeys.kitStudio!, permissions: [...authScopes, "kit-catalog:read"] },
  { id: "operations-e2e-label", name: "Operations E2E Label Printer", key: serviceKeys.labelPrinter!, permissions: authScopes },
  { id: "operations-e2e-customer-hub", name: "Operations E2E Customer Hub", key: serviceKeys.customerHub!, permissions: authScopes },
];
const upsertPrincipal = db.prepare(`
  INSERT INTO panel_api_keys
    (id, name, key_prefix, key_hash, last4, status, environment, permissions)
  VALUES
    (?, ?, ?, ?, ?, 'active', 'test', ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    key_prefix = excluded.key_prefix,
    key_hash = excluded.key_hash,
    last4 = excluded.last4,
    status = 'active',
    permissions = excluded.permissions,
    updated_at = CURRENT_TIMESTAMP,
    deleted_at = NULL,
    revoked_at = NULL
`);
for (const principal of principals) {
  const keyHash = crypto.createHmac("sha256", hashSecret).update(principal.key).digest("hex");
  upsertPrincipal.run(principal.id, principal.name, principal.key.slice(0, 12), keyHash, principal.key.slice(-4), JSON.stringify(principal.permissions));
}

db.prepare("UPDATE exchange_rates SET is_active = 0").run();
db.prepare(`
  INSERT INTO exchange_rates (id, base_currency, target_currency, rate, source, is_active)
  VALUES ('operations-e2e-rate', 'USD', 'TRY', 40, 'operations-e2e', 1)
  ON CONFLICT(id) DO UPDATE SET rate = 40, fetched_at = CURRENT_TIMESTAMP, is_active = 1
`).run();

db.close();
console.log("Operations E2E fixtures are ready in the isolated test database.");

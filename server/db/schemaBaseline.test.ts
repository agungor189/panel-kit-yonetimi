import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "./initialize.js";
import { CURRENT_SCHEMA_VERSION, getMigrationManifest, runMigrations, SUPPORTED_UPGRADE_STARTS } from "../migrations/runner.js";

const count = (db: Database.Database, table: string): number => Number(
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
);

const columns = (db: Database.Database, table: string): string[] => (
  db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
).map(({ name }) => name).sort();

const indexes = (db: Database.Database, table: string): string[] => (
  db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
).map(({ name }) => name).filter((name) => !name.startsWith("sqlite_autoindex_")).sort();

const businessTablesThatMustStartEmpty = [
  "products",
  "product_bom",
  "stock_movements",
  "sales",
  "sale_items",
  "transactions",
  "cash_transactions",
  "pricing_history",
  "kits",
  "kit_profiles",
  "kit_profile_offers",
  "inbound_batches",
  "inbound_batch_lines",
  "warehouse_packages",
  "warehouse_pick_progress",
  "pick_sessions",
  "label_print_jobs",
  "marketplace_orders",
  "marketplace_order_lines",
] as const;

test("fresh production schema is exact, versioned and has zero business history", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);

  const manifest = getMigrationManifest();
  assert.equal(manifest.length, 59);
  assert.equal(manifest.at(-1)?.version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(SUPPORTED_UPGRADE_STARTS, [48, 53]);
  assert.deepEqual(
    db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
    manifest,
  );
  assert.ok(manifest.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));

  const requiredColumns: Record<string, string[]> = {
    products: ["central_stock", "id", "product_type", "sku", "title"],
    stock_movements: ["change_amount", "id", "product_id", "reason", "type"],
    sales: ["id", "income_transaction_id", "order_code", "status"],
    sale_items: ["id", "product_id", "purchase_cost", "quantity", "sale_id", "unit_price"],
    cash_transactions: ["account_id", "amount", "currency", "id", "source_id", "source_type", "type"],
    warehouse_packages: ["current_location_id", "id", "planned_quantity", "remaining_quantity", "status"],
    schema_migrations: ["applied_at", "checksum", "name", "version"],
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const actual = columns(db, table);
    for (const column of expected) assert.ok(actual.includes(column), `${table}.${column} must exist`);
  }
  assert.ok(indexes(db, "products").includes("idx_products_status"));
  assert.ok(indexes(db, "stock_movements").includes("idx_stock_movements_product"));
  assert.ok(indexes(db, "sales").includes("idx_sales_order_code_unique"));

  for (const table of businessTablesThatMustStartEmpty) {
    assert.equal(count(db, table), 0, `${table} must contain no bootstrap business rows`);
  }
  assert.equal(count(db, "users"), 1);
  assert.equal(count(db, "cash_accounts"), 6);
  assert.equal(count(db, "dashboard_widgets"), 8);
  assert.equal(count(db, "settings"), 15);

  const before = Object.fromEntries([
    ...businessTablesThatMustStartEmpty,
    "users",
    "cash_accounts",
    "dashboard_widgets",
    "settings",
    "schema_migrations",
  ].map((table) => [table, count(db, table)]));
  initializeDatabase(db);
  const after = Object.fromEntries(Object.keys(before).map((table) => [table, count(db, table)]));
  assert.deepEqual(after, before, "repeated bootstrap must not create hidden rows or events");
  db.close();
});

test("migration history fails closed on unknown, renamed or changed entries", () => {
  const unknown = new Database(":memory:");
  initializeDatabase(unknown);
  unknown.prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (999, 'future', ?)").run("0".repeat(64));
  assert.throws(() => runMigrations(unknown), /unsupported migration version v999/);
  unknown.close();

  const renamed = new Database(":memory:");
  initializeDatabase(renamed);
  renamed.prepare("UPDATE schema_migrations SET name = 'altered' WHERE version = 1").run();
  assert.throws(() => runMigrations(renamed), /Migration v1 name mismatch/);
  renamed.close();

  const changed = new Database(":memory:");
  initializeDatabase(changed);
  changed.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("f".repeat(64));
  assert.throws(() => runMigrations(changed), /Migration v1 checksum mismatch/);
  changed.close();
});

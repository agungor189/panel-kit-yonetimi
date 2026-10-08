import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { initializeDatabase } from './initialize.js';
import { runMigrations } from '../migrations/runner.js';

for (const version of [48,53]) test(`v${version} fixture upgrades through v97 to v98 without business repair`, () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(readFileSync(new URL(`./fixtures/panel-v${version}.sql`, import.meta.url), 'utf8'));
  runMigrations(db, 97);
  const before = db.prepare('SELECT * FROM products ORDER BY id').all();
  runMigrations(db, 98);
  assert.deepEqual(db.prepare('SELECT * FROM products ORDER BY id').all(), before);
  for (const name of ['procurement_imports','procurement_import_records','procurement_package_plan','catalog_supplier_aliases']) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${name}`).pluck().get(), 0);
  const fresh = new Database(':memory:'); initializeDatabase(fresh);
  const shape = (database: Database.Database) => database.prepare("SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'procurement_import%' OR name='procurement_package_plan' OR name='catalog_supplier_aliases' OR name='trg_products_pending_activation_clear_guard' ORDER BY name").all();
  assert.deepEqual(shape(db), shape(fresh));
  assert.throws(() => db.exec("INSERT INTO procurement_package_plan(id) VALUES ('invalid')"), /NOT NULL/);
  fresh.close(); db.close();
});


test('v98 to v99 preserves immutable source money and adds nullable historical counterparty only', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(readFileSync(new URL('./fixtures/panel-v48.sql', import.meta.url), 'utf8'));
  runMigrations(db, 98);
  const before = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='trg_purchase_order_snapshot_immutable'").get();
  runMigrations(db, 99);
  assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name='trg_purchase_order_snapshot_immutable'").get(), before);
  const column = db.prepare('PRAGMA table_info(purchase_cost_component_details)').all().find((r: any) => r.name === 'counterparty') as any;
  assert.equal(column.notnull, 0);
  assert.equal(column.dflt_value, null);
  assert.throws(() => db.prepare("INSERT INTO purchase_cost_component_details(component_id,expense_type,occurred_on,target_scope,target_line_ids_json,counterparty) VALUES ('x','OTHER','2026-01-01','COMMON','[]','INVENTED')").run());
  db.close();
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initializeDatabase } from "./initialize.js";
import { CURRENT_SCHEMA_VERSION, getMigrationManifest, runMigrations, SUPPORTED_UPGRADE_STARTS, validateMigrationManifest } from "../migrations/runner.js";

const count = (db: Database.Database, table: string): number => Number(
  (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
);
const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));

const columns = (db: Database.Database, table: string): string[] => (
  db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
).map(({ name }) => name).sort();

const indexes = (db: Database.Database, table: string): string[] => (
  db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
).map(({ name }) => name).filter((name) => !name.startsWith("sqlite_autoindex_")).sort();

const schemaShape = (db: Database.Database) => (
  db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND sql IS NOT NULL ORDER BY type, name").all()
    .map((object: any) => ({
      ...object,
      columns: object.type === "table" ? (db.prepare(`PRAGMA table_info(\"${object.name.replaceAll('"', '""')}\")`).all() as any[])
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk })).sort((a, b) => a.name.localeCompare(b.name)) : undefined,
      indexColumns: object.type === "index" ? (db.prepare(`PRAGMA index_info(\"${object.name.replaceAll('"', '""')}\")`).all() as any[])
        .map(({ seqno, name }) => ({ seqno, name })) : undefined,
    }))
);

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
  "command_operations",
  "command_audit_log",
  "command_outbox",
  "catalog_product_versions",
  "fx_rate_observations",
  "fx_current_rates",
  "procurement_suppliers",
  "purchase_orders",
  "purchase_order_lines",
  "purchase_attachments",
  "purchase_cost_components",
  "purchase_cost_allocations",
  "acquisition_lot_cost_snapshots",
  "purchase_payments",
  "procurement_cash_postings",
  "inventory_lots",
  "inventory_ledger_events",
  "inventory_lot_location_balances",
  "inventory_reservations",
  "inventory_reservation_lines",
  "inventory_reservation_allocations",
  "sale_financial_snapshots",
  "sale_financial_lines",
  "sale_financial_line_components",
  "sale_financial_expense_facts",
  "sale_financial_cogs_finalizations",
  "sale_financial_cogs_allocations",
  "return_requests",
  "return_request_lines",
  "return_financial_reversal_allocations",
  "return_cogs_reversal_allocations",
  "customer_shipping_refund_facts",
  "marketplace_commission_reversal_facts",
  "return_receipts",
  "return_receipt_lines",
  "return_receipt_inventory_allocations",
  "return_quarantine_facts",
  "return_loss_facts",
  "refund_approvals",
  "refund_payments",
  "refund_cash_postings",
  "refund_settlement_postings",
  "warehouse_topologies",
  "warehouse_rack_configs",
  "warehouse_level_configs",
  "warehouse_position_configs",
  "warehouse_location_slots",
  "warehouse_excess_approvals",
  "warehouse_goods_receipts",
  "warehouse_execution_packages",
  "warehouse_package_movements_v2",
  "warehouse_replenishment_tasks",
  "warehouse_stock_discrepancies_v2",
  "warehouse_stock_counts_v2",
  "published_kits",
  "published_kit_versions",
  "published_kit_version_components",
  "published_kit_version_cuts",
  "published_kit_version_packages",
  "published_kit_version_package_items",
  "sale_kit_version_snapshots",
  "profile_inventory_pieces",
  "profile_piece_reservations",
  "profile_piece_reservation_cuts",
  "profile_cut_executions",
  "profile_cut_outputs",
  "profile_cut_waste_facts",
  "profile_return_piece_restorations",
  "profile_piece_migration_blocks",
] as const;

test("fresh production schema is exact, versioned and has zero business history", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);

  const manifest = getMigrationManifest();
  assert.equal(manifest.length, 77);
  assert.equal(manifest.at(-1)?.version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(SUPPORTED_UPGRADE_STARTS, [48, 53]);
  assert.deepEqual(
    db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
    manifest,
  );
  assert.ok(manifest.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)));

  const requiredColumns: Record<string, string[]> = {
    products: ["base_uom_code", "catalog_class", "catalog_type", "catalog_version", "catalog_version_ref", "central_stock", "id", "mass_grams_int", "material_behavior", "product_type", "sku", "title"],
    product_profile_attributes: ["custom_length_allowed", "form", "material", "product_id", "standard_purchase_lengths_mm_json", "wall_thickness_micrometers", "wall_thickness_mm"],
    catalog_product_versions: ["catalog_version", "content_hash", "product_id", "snapshot_json", "version_ref"],
    uom_definitions: ["base_quantum", "code", "dimension", "quantity_scale", "registry_version"],
    uom_conversions: ["denominator", "from_uom_code", "numerator", "to_uom_code", "version_ref"],
    stock_movements: ["change_amount", "id", "product_id", "reason", "type"],
    sales: ["id", "income_transaction_id", "order_code", "status"],
    sale_items: ["id", "product_id", "purchase_cost", "quantity", "sale_id", "unit_price"],
    cash_transactions: ["account_id", "amount", "currency", "id", "source_id", "source_type", "type"],
    warehouse_packages: ["current_location_id", "id", "planned_quantity", "remaining_quantity", "status"],
    users: ["id", "permissions", "role", "session_epoch"],
    user_sessions: ["expires_at", "id", "revoked_at", "service_principal_id", "session_epoch", "user_id"],
    command_operations: ["actor_scope", "command_type", "id", "operation_id", "payload_hash", "result_json", "result_status_code"],
    command_audit_log: ["command_type", "human_actor_id", "operation_id", "payload_hash", "service_actor_id"],
    command_outbox: ["event_type", "operation_record_id", "payload_hash", "payload_json", "status", "topic"],
    fx_rate_observations: ["actor_id", "actor_type", "base_currency", "id", "observed_at", "quote_currency", "rate_denominator", "rate_numerator", "source"],
    fx_current_rates: ["changed_at", "changed_by", "observation_id", "pair_key"],
    procurement_suppliers: ["default_currency", "id", "name"],
    purchase_orders: ["acquisition_cost_vat_policy", "direct_cost_base_try_net_minor", "merchandise_net_minor", "paid_minor", "payment_status", "status", "supplier_currency", "supplier_id", "total_base_try_gross_minor", "total_gross_minor"],
    purchase_order_lines: ["base_try_net_minor", "fx_rate_denominator", "fx_rate_numerator", "normalized_cost_denominator", "normalized_cost_numerator", "product_id", "purchase_order_id", "quantity_base_int", "quote_basis", "supplier_net_minor", "supplier_vat_minor", "supplier_gross_minor", "vat_mode"],
    purchase_cost_components: ["allocation_method", "base_try_net_minor", "category", "purchase_order_id", "rounding_residual_minor", "source_currency", "source_net_minor", "source_vat_minor", "source_gross_minor", "suggestion_json"],
    purchase_cost_allocations: ["amount_try_minor", "component_id", "line_id", "provenance", "purchase_order_id"],
    acquisition_lot_cost_snapshots: ["allocation_snapshot_json", "landed_cost_try_minor", "merchandise_cost_try_minor", "normalized_cost_denominator", "normalized_cost_numerator", "purchase_line_id", "state", "vat_policy_snapshot", "vat_try_minor"],
    purchase_payments: ["amount_minor", "cash_account_id", "currency", "paid_at", "purchase_order_id"],
    procurement_cash_postings: ["amount_minor", "currency", "direction", "payment_id", "purchase_id", "source_type"],
    inventory_lots: ["acquisition_cost_snapshot_id", "base_uom_code_snapshot", "on_hand_base_int", "product_id", "receipt_id", "reserved_base_int", "status"],
    inventory_ledger_events: ["event_type", "lot_id", "operation_id", "product_id", "quantity_delta_base_int", "reason_code", "reference_id"],
    inventory_lot_location_balances: ["active", "location_id", "location_kind", "lot_id", "physical_state", "quantity_base_int"],
    inventory_reservations: ["dispatch_operation_id", "id", "order_id", "reserve_operation_id", "shipment_id", "status"],
    inventory_reservation_lines: ["base_uom_code_snapshot", "product_id", "quantity_base_int", "reservation_id"],
    inventory_reservation_allocations: ["fifo_sequence", "lot_id", "product_id", "quantity_base_int", "reservation_id"],
    sale_financial_snapshots: ["commission_amount_minor", "commission_calculation_basis", "currency", "discount_minor", "fx_rate_denominator", "fx_rate_numerator", "gross_amount_minor", "net_revenue_minor", "sale_id", "snapshot_version", "vat_amount_minor"],
    sale_financial_lines: ["catalog_version_ref_snapshot", "discount_allocation_minor", "gross_amount_minor", "net_revenue_minor", "product_id", "quantity_base_int", "sale_line_id", "vat_amount_minor", "vat_rate_bps"],
    sale_financial_line_components: ["component_catalog_version_ref", "component_product_id", "financial_line_id", "quantity_base_int"],
    sale_financial_expense_facts: ["amount_base_try_minor", "amount_minor", "category", "fact_version", "financial_snapshot_id", "operation_id", "provenance_json", "state"],
    sale_financial_cogs_finalizations: ["dispatch_operation_id", "financial_snapshot_id", "reservation_id", "shipment_id", "total_cogs_base_try_minor"],
    sale_financial_cogs_allocations: ["acquisition_cost_snapshot_id", "cost_base_try_minor", "dispatch_operation_id", "financial_line_id", "inventory_lot_id", "quantity_base_int", "sale_line_id"],
    published_kits: ["current_version_id", "product_id", "sku", "workspace_kit_id"],
    published_kit_versions: ["canonical_cost_minor", "content_hash", "core_policy_hash", "effective_kerf_mm", "final_sale_price_minor", "published_kit_id", "version_number"],
    published_kit_version_components: ["component_catalog_version_ref", "component_product_id", "extended_cost_minor", "quantity_base_int"],
    published_kit_version_cuts: ["consumed_length_mm", "kerf_mm", "length_mm", "profile_product_id", "quantity"],
    published_kit_version_packages: ["instruction_version", "package_number", "published_kit_version_id"],
    sale_kit_version_snapshots: ["content_hash", "financial_line_id", "published_kit_version_id", "snapshot_json", "version_number"],
    profile_inventory_pieces: ["current_length_mm", "historical_cost_minor", "inventory_lot_id", "origin_piece_id", "reserved_length_mm", "status"],
    profile_piece_reservations: ["consumed_length_mm", "planned_remnant_length_mm", "profile_piece_id", "reservation_id", "status"],
    profile_cut_executions: ["consumed_cost_minor", "consumed_length_mm", "operation_id", "remnant_cost_minor", "remnant_length_mm", "source_piece_id"],
    profile_cut_waste_facts: ["execution_id", "inventory_lot_id", "inventory_ledger_event_id", "source_location_id", "waste_length_mm"],
    profile_return_piece_restorations: ["return_receipt_inventory_allocation_id", "returned_piece_id", "source_delivery_piece_id", "warehouse_package_id"],
    profile_piece_migration_blocks: ["inventory_lot_id", "product_id", "reason_code"],
    return_requests: ["currency", "financial_snapshot_id", "id", "request_operation_id", "requested_by_actor_id", "sale_id"],
    return_request_lines: ["financial_line_id", "id", "quantity_base_int", "reason_code", "return_id", "sale_line_id"],
    return_financial_reversal_allocations: ["discount_minor", "gross_minor", "net_minor", "quantity_base_int", "return_line_id", "vat_minor"],
    return_cogs_reversal_allocations: ["acquisition_cost_snapshot_id", "cost_base_try_minor", "inventory_lot_id", "original_cogs_allocation_id", "quantity_base_int", "return_line_id"],
    return_receipts: ["id", "receipt_operation_id", "received_by_actor_id", "return_id"],
    return_receipt_lines: ["disposition", "location_id", "quantity_base_int", "receipt_id", "return_line_id"],
    return_receipt_inventory_allocations: ["cost_base_try_minor", "disposition", "inventory_ledger_event_id", "original_inventory_lot_id", "quantity_base_int"],
    return_loss_facts: ["amount_base_try_minor", "original_acquisition_cost_snapshot_id", "original_cogs_allocation_id", "return_id"],
    refund_approvals: ["amount_minor", "approval_operation_id", "approval_reference", "approved_by_actor_id", "return_id"],
    refund_payments: ["amount_minor", "payment_mode", "payment_operation_id", "return_id"],
    refund_cash_postings: ["amount_minor", "cash_account_id", "direction", "refund_payment_id"],
    refund_settlement_postings: ["amount_minor", "refund_payment_id", "state"],
    warehouse_topologies: ["code_template", "config_hash", "config_json", "id", "name"],
    warehouse_rack_configs: ["allow_mixed_lot", "allow_mixed_sku", "depth_count", "level_count", "placement_priority", "position_count", "rack_code", "role", "topology_id"],
    warehouse_level_configs: ["heavy_penalty", "level_number", "rack_code", "role", "topology_id"],
    warehouse_position_configs: ["allow_mixed_lot", "allow_mixed_sku", "level_number", "position_number", "rack_code", "topology_id"],
    warehouse_location_slots: ["code", "depth_code", "depth_index", "is_front", "level_number", "position_number", "rack_code", "role", "topology_id"],
    warehouse_execution_settings: ["heavy_package_threshold_grams", "prepare_threshold_pct", "watch_threshold_pct"],
    warehouse_goods_receipts: ["accepted_quantity_base_int", "acquisition_cost_snapshot_id", "damaged_quantity_base_int", "excess_quantity_base_int", "inventory_lot_id", "is_final", "receipt_series_id", "shortage_quantity_base_int", "stage_index", "variance_quantity_base_int"],
    warehouse_execution_packages: ["acquisition_cost_snapshot_id", "current_slot_id", "disposition", "inventory_lot_id", "label_identity", "origin_inventory_lot_id", "origin_type", "package_code", "product_id", "receipt_id", "remaining_quantity_base_int", "return_receipt_id", "return_receipt_inventory_allocation_id", "supplier_lot_code"],
    warehouse_package_movements_v2: ["from_location_id", "inventory_lot_id", "movement_type", "operation_id", "package_id", "to_location_id"],
    warehouse_replenishment_tasks: ["current_pct", "inventory_lot_id", "source_package_id", "status", "target_slot_id", "threshold_pct"],
    warehouse_stock_discrepancies_v2: ["inventory_lot_id", "operation_id", "reason", "status"],
    warehouse_stock_counts_v2: ["difference_base_int", "expected_quantity_base_int", "observed_quantity_base_int", "status"],
    schema_migrations: ["applied_at", "checksum", "name", "version"],
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const actual = columns(db, table);
    for (const column of expected) assert.ok(actual.includes(column), `${table}.${column} must exist`);
  }
  assert.ok(indexes(db, "products").includes("idx_products_status"));
  assert.ok(indexes(db, "stock_movements").includes("idx_stock_movements_product"));
  assert.ok(indexes(db, "sales").includes("idx_sales_order_code_unique"));
  assert.ok(indexes(db, "command_outbox").includes("idx_command_outbox_dispatch"));
  assert.ok(indexes(db, "acquisition_lot_cost_snapshots").includes("idx_acquisition_lots_product"));
  assert.ok(indexes(db, "cash_transactions").includes("idx_cash_transactions_procurement_payment"));
  assert.ok(indexes(db, "inventory_lots").includes("idx_inventory_lots_product_fifo"));
  assert.ok(indexes(db, "warehouse_replenishment_tasks").includes("idx_warehouse_replenishment_one_open_pick_lot"));

  for (const table of businessTablesThatMustStartEmpty) {
    assert.equal(count(db, table), 0, `${table} must contain no bootstrap business rows`);
  }
  assert.equal(count(db, "users"), 0, "fresh bootstrap must require secure one-time admin provisioning");
  assert.equal(count(db, "cash_accounts"), 0, "cash accounts are business configuration, not technical seed data");
  assert.equal(count(db, "dashboard_widgets"), 0, "user-owned dashboard data must not be invented before a user exists");
  assert.equal(count(db, "settings"), 0, "unresolved business policy must remain unconfigured");
  assert.equal(count(db, "warehouse_rack_metadata"), 0, "fresh bootstrap must not invent warehouse placement policy");
  assert.deepEqual(db.prepare(`SELECT id,watch_threshold_pct,prepare_threshold_pct,heavy_package_threshold_grams
    FROM warehouse_execution_settings`).all(), [{
    id: "default",
    watch_threshold_pct: 20,
    prepare_threshold_pct: 10,
    heavy_package_threshold_grams: 20_000,
  }], "warehouse execution thresholds must be explicit persisted configuration");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username='admin'").pluck().get(), 0);

  assert.throws(
    () => db.prepare("INSERT INTO products (id,title,product_type,base_uom_code) VALUES ('invalid-uom','Invalid UOM','simple','free-text')").run(),
    /base_uom|foreign key|uom/i,
  );

  const before = Object.fromEntries([
    ...businessTablesThatMustStartEmpty,
    "users",
    "cash_accounts",
    "dashboard_widgets",
    "settings",
    "warehouse_rack_metadata",
    "schema_migrations",
  ].map((table) => [table, count(db, table)]));
  initializeDatabase(db);
  const after = Object.fromEntries(Object.keys(before).map((table) => [table, count(db, table)]));
  assert.deepEqual(after, before, "repeated bootstrap must not create hidden rows or events");
  db.close();
});

test("existing warehouse rack policy remains untouched by repeated initialization", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare(`
    INSERT INTO warehouse_rack_metadata (rack_code, status, placement_priority, notes)
    VALUES ('C2', 'ACTIVE', 'LOW', 'Owner configured policy')
  `).run();

  initializeDatabase(db);

  assert.deepEqual(
    db.prepare("SELECT rack_code, status, placement_priority, notes FROM warehouse_rack_metadata WHERE rack_code = 'C2'").get(),
    { rack_code: "C2", status: "ACTIVE", placement_priority: "LOW", notes: "Owner configured policy" },
  );
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

for (const start of SUPPORTED_UPGRADE_STARTS) {
  test(`historical v${start} nonzero legacy stock fails closed without inventing canonical inventory`, () => {
    const sql = fs.readFileSync(path.join(fixtureDirectory, `panel-v${start}.sql`), "utf8");
    const db = new Database(":memory:");
    db.exec(sql);
    db.prepare("INSERT INTO products (id, title, product_type, central_stock) VALUES (?, ?, ?, ?)")
      .run(`legacy-stock-v${start}`, `Legacy stock v${start}`, "simple", 7);

    assert.throws(
      () => runMigrations(db),
      /INVENTORY_MIGRATION_REQUIRED.*legacy-stock-v\d+/,
    );
    assert.equal(db.prepare("SELECT central_stock FROM products WHERE id=?").pluck().get(`legacy-stock-v${start}`), 7);
    assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_lots").pluck().get(), 0);
    assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events").pluck().get(), 0);
    assert.equal(db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get(), 69);
    db.close();
  });

  test(`historical v${start} SQL fixture is provenance-pinned and upgrades to v${CURRENT_SCHEMA_VERSION}`, () => {
    const sql = fs.readFileSync(path.join(fixtureDirectory, `panel-v${start}.sql`), "utf8");
    assert.match(sql, new RegExp(`^-- source-commit: [a-f0-9]{40}\\n-- schema-version: ${start}\\n`));
    const db = new Database(":memory:");
    db.exec(sql);
    db.prepare("INSERT INTO products (id, title, product_type) VALUES (?, ?, ?)")
      .run(`fixture-v${start}`, `Historical v${start} product`, "simple");
    runMigrations(db);
    assert.equal(count(db, "products"), 1);
    assert.throws(
      () => db.prepare("UPDATE products SET base_uom_code='free-text' WHERE id=?").run(`fixture-v${start}`),
      /base_uom|foreign key|uom/i,
    );
    assert.throws(
      () => db.prepare("INSERT INTO products (id,title,product_type,base_uom_code) VALUES (?,?,?,'free-text')")
        .run(`invalid-uom-v${start}`, "Invalid upgraded UOM", "simple"),
      /base_uom|foreign key|uom/i,
    );
    assert.deepEqual(
      db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
      getMigrationManifest(),
    );
    const fresh = new Database(":memory:");
    initializeDatabase(fresh);
    assert.deepEqual(schemaShape(db), schemaShape(fresh), `v${start} upgrade must converge to the fresh schema shape`);
    const first = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all();
    runMigrations(db);
    assert.deepEqual(db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(), first);
    fresh.close();
    db.close();
  });

  test(`historical v${start} upgrade resumes from a closed v60 checkpoint and converges to v${CURRENT_SCHEMA_VERSION}`, () => {
    const sql = fs.readFileSync(path.join(fixtureDirectory, `panel-v${start}.sql`), "utf8");
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `panel-v${start}-resume-`));
    const databasePath = path.join(temporaryDirectory, "panel.sqlite");
    let staged: Database.Database | undefined;
    let direct: Database.Database | undefined;
    try {
      staged = new Database(databasePath);
      staged.exec(sql);
      staged.prepare("INSERT INTO products (id, title, product_type) VALUES (?, ?, ?)")
        .run(`staged-v${start}`, `Staged v${start} product`, "assembly");
      runMigrations(staged, 60);
      assert.equal(staged.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get(), 60);
      assert.equal(staged.prepare("SELECT product_type FROM products WHERE id = ?").pluck().get(`staged-v${start}`), "assembly");
      staged.close();
      staged = new Database(databasePath);
      runMigrations(staged);

      direct = new Database(":memory:");
      direct.exec(sql);
      direct.prepare("INSERT INTO products (id, title, product_type) VALUES (?, ?, ?)")
        .run(`staged-v${start}`, `Staged v${start} product`, "assembly");
      runMigrations(direct);

      assert.equal(staged.prepare("SELECT product_type FROM products WHERE id = ?").pluck().get(`staged-v${start}`), "assembly");
      assert.deepEqual(schemaShape(staged), schemaShape(direct));
      assert.deepEqual(
        staged.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all(),
        getMigrationManifest(),
      );
    } finally {
      staged?.close();
      direct?.close();
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
}

test("the historical v41 hole is frozen against retroactive migration insertion", () => {
  const manifest = getMigrationManifest();
  const insertionPoint = manifest.findIndex(({ version }) => version === 42);
  manifest.splice(insertionPoint, 0, { version: 41, name: "retroactive", checksum: "0".repeat(64) });
  assert.throws(() => validateMigrationManifest(manifest), /Frozen migration sequence mismatch/);
});

test("migration history rejects deleted records and claimed schema effects that are absent", () => {
  const deletedV1 = new Database(":memory:");
  initializeDatabase(deletedV1);
  deletedV1.prepare("DELETE FROM schema_migrations WHERE version = 1").run();
  assert.throws(() => runMigrations(deletedV1), /history.*prefix|missing.*v1/i);
  deletedV1.close();

  const deletedV30 = new Database(":memory:");
  initializeDatabase(deletedV30);
  deletedV30.prepare("DELETE FROM schema_migrations WHERE version = 30").run();
  assert.throws(() => runMigrations(deletedV30), /history.*prefix|missing.*v30/i);
  deletedV30.close();

  const missingEffect = new Database(":memory:");
  initializeDatabase(missingEffect);
  missingEffect.exec("DROP TABLE backup_runs");
  assert.throws(() => runMigrations(missingEffect), /schema effect|backup_runs/i);
  missingEffect.close();

  const unverifiableNull = new Database(":memory:");
  initializeDatabase(unverifiableNull);
  unverifiableNull.prepare("UPDATE schema_migrations SET checksum = NULL WHERE version = 30").run();
  unverifiableNull.exec("DROP TABLE backup_runs");
  assert.throws(() => runMigrations(unverifiableNull), /NULL checksum|schema effect|checksum history|backup_runs/i);
  unverifiableNull.close();
});

test("v63 fails closed on same-name command objects with weakened definitions", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(path.join(fixtureDirectory, "panel-v53.sql"), "utf8"));
  runMigrations(db, 62);
  db.exec(`
    CREATE TABLE command_operations (
      id                 TEXT PRIMARY KEY,
      actor_scope        TEXT NOT NULL,
      operation_id       TEXT NOT NULL,
      command_type       TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      result_status_code INTEGER NOT NULL,
      result_json        TEXT NOT NULL,
      result_hash        TEXT NOT NULL,
      committed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX idx_command_operations_lookup
      ON command_operations(actor_scope, command_type, operation_id);
    CREATE TRIGGER trg_command_operations_immutable_update
    BEFORE UPDATE ON command_operations BEGIN
      SELECT 1;
    END;
    CREATE TRIGGER trg_command_operations_immutable_delete
    BEFORE DELETE ON command_operations BEGIN
      SELECT 1;
    END;
  `);
  const weakDefinitions = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name IN (
      'command_operations',
      'idx_command_operations_lookup',
      'trg_command_operations_immutable_update',
      'trg_command_operations_immutable_delete'
    )
    ORDER BY type, name
  `).all();

  assert.throws(() => runMigrations(db), /v63 schema effect.*table command_operations/i);
  assert.equal(db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get(), 62);
  assert.deepEqual(db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name IN (
      'command_operations',
      'idx_command_operations_lookup',
      'trg_command_operations_immutable_update',
      'trg_command_operations_immutable_delete'
    )
    ORDER BY type, name
  `).all(), weakDefinitions, "v63 must not silently repair or overwrite incompatible objects");
  db.close();
});

test("v63 verification rejects a same-column index with incompatible uniqueness semantics", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  db.exec(`
    DROP INDEX idx_command_operations_lookup;
    CREATE UNIQUE INDEX idx_command_operations_lookup
      ON command_operations(actor_scope, command_type, operation_id);
  `);

  assert.throws(() => runMigrations(db), /v63 schema effect.*index idx_command_operations_lookup/i);
  db.close();
});

test("v63 verification rejects a same-name no-op immutability trigger", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  db.exec(`
    DROP TRIGGER trg_command_operations_immutable_update;
    CREATE TRIGGER trg_command_operations_immutable_update
    BEFORE UPDATE ON command_operations BEGIN
      SELECT 1;
    END;
  `);

  assert.throws(() => runMigrations(db), /v63 schema effect.*trigger trg_command_operations_immutable_update/i);
  db.close();
});

test("v64 verification rejects weakened same-name catalog tables, indexes and triggers", () => {
  const weakTable = new Database(":memory:");
  initializeDatabase(weakTable);
  weakTable.exec("DROP TABLE uom_conversions; CREATE TABLE uom_conversions (id TEXT PRIMARY KEY)");
  assert.throws(() => runMigrations(weakTable), /schema effect.*uom_conversions/i);
  weakTable.close();

  const weakIndex = new Database(":memory:");
  initializeDatabase(weakIndex);
  weakIndex.exec("DROP INDEX idx_products_catalog_contract; CREATE UNIQUE INDEX idx_products_catalog_contract ON products(catalog_type,catalog_version,status)");
  assert.throws(() => runMigrations(weakIndex), /schema effect.*idx_products_catalog_contract/i);
  weakIndex.close();

  const weakTrigger = new Database(":memory:");
  initializeDatabase(weakTrigger);
  weakTrigger.exec("DROP TRIGGER trg_uom_conversions_immutable_update; CREATE TRIGGER trg_uom_conversions_immutable_update BEFORE UPDATE ON uom_conversions BEGIN SELECT 1; END");
  assert.throws(() => runMigrations(weakTrigger), /schema effect.*trg_uom_conversions_immutable_update/i);
  weakTrigger.close();
});

test("existing Panel schema with completely missing migration history fails without mutation", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("INSERT INTO products (id, title, product_type) VALUES ('history-loss-product', 'History loss product', 'assembly')").run();
  db.exec("DROP TABLE schema_migrations");
  const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  const productBefore = db.prepare("SELECT * FROM products WHERE id = 'history-loss-product'").get();

  assert.throws(() => initializeDatabase(db), /migration history.*missing|existing schema.*history/i);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(), undefined);
  assert.deepEqual(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), schemaBefore);
  assert.deepEqual(db.prepare("SELECT * FROM products WHERE id = 'history-loss-product'").get(), productBefore);
  db.close();
});

test("an isolated NULL checksum in a checksum-aware Panel history fails without backfill", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  db.prepare("UPDATE schema_migrations SET checksum = NULL WHERE version = 30").run();
  const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();

  assert.throws(() => runMigrations(db), /NULL checksum|checksum.*null|corrupt.*checksum/i);
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version = 30").pluck().get(), null);
  assert.deepEqual(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), schemaBefore);
  db.close();
});

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { ReconciliationService } from "./reconciliationService.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  return { db, service: new ReconciliationService(db) };
}

function insertInventory(db: Database.Database, input: { productId?: string; sku?: string; onHand?: number; ledger?: number; location?: number; central?: number; reserved?: number } = {}) {
  const productId = input.productId || "product-1";
  const sku = input.sku || "SKU-1";
  const onHand = input.onHand ?? 10;
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO products (id,title,sku,central_stock) VALUES (?,?,?,0)").run(productId, sku, sku);
  db.prepare(`INSERT INTO inventory_lots
    (id,receipt_id,acquisition_cost_snapshot_id,purchase_order_id,purchase_line_id,product_id,base_uom_code_snapshot,
     received_quantity_base_int,on_hand_base_int,reserved_base_int,status,received_at,receipt_operation_id)
    VALUES (?,?,?,?,?,?,'piece',?,?,?,'USABLE','2026-09-23T00:00:00Z','receive-op')`)
    .run(`lot-${productId}`, `receipt-${productId}`, `cost-${productId}`, "po", "line", productId, Math.max(onHand, 1), onHand, input.reserved ?? 0);
  if ((input.ledger ?? onHand) !== 0) db.prepare(`INSERT INTO inventory_ledger_events
    (id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,reason_code,reference_type,reference_id,occurred_at)
    VALUES (?,?, 'RECEIPT',?,?,?,'piece','TEST','fixture',?,'2026-09-23T00:00:00Z')`)
    .run(`event-${productId}`, `receive-${productId}`, productId, `lot-${productId}`, input.ledger ?? onHand, `receipt-${productId}`);
  db.prepare(`INSERT INTO inventory_lot_location_balances
    (id,lot_id,location_id,location_kind,quantity_base_int) VALUES (?,?,?,'PICKING',?)`)
    .run(`balance-${productId}`, `lot-${productId}`, `location-${productId}`, input.location ?? onHand);
  db.exec("DROP TRIGGER IF EXISTS trg_inventory_central_stock_projection_guard");
  db.prepare("UPDATE products SET central_stock=? WHERE id=?").run(input.central ?? onHand, productId);
  db.pragma("foreign_keys = ON");
  return { productId, sku, lotId: `lot-${productId}` };
}

test("projection drift is auto-repaired but canonical mismatch is never auto-repaired", () => {
  const { db, service } = fixture();
  insertInventory(db, { central: 3 });
  const before = Number(db.prepare("SELECT central_stock FROM products WHERE id='product-1'").pluck().get());
  const run = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "scan-1" });
  const after = Number(db.prepare("SELECT central_stock FROM products WHERE id='product-1'").pluck().get());
  assert.equal(before, 3);
  assert.equal(after, 10);
  assert.equal(run.findings.some((finding) => finding.code === "INVENTORY_CENTRAL_STOCK_PROJECTION_DRIFT" && finding.repairStatus === "AUTO_REPAIRED"), true);

  db.prepare("UPDATE inventory_lots SET on_hand_base_int=9 WHERE id='lot-product-1'").run();
  const mismatch = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "scan-2" });
  assert.equal(Number(db.prepare("SELECT on_hand_base_int FROM inventory_lots WHERE id='lot-product-1'").pluck().get()), 9);
  assert.equal(mismatch.findings.some((finding) => finding.code === "INVENTORY_LEDGER_MISMATCH" && finding.repairStatus === "APPROVAL_REQUIRED"), true);
});

test("critical findings block only the exact SKU and unblock only after a clean recheck or explicit verification", () => {
  const { db, service } = fixture();
  insertInventory(db, { productId: "bad", sku: "SKU-BAD", onHand: 8, ledger: 7 });
  insertInventory(db, { productId: "good", sku: "SKU-GOOD", onHand: 4, ledger: 4 });
  service.run({ trigger: "SCHEDULED", actor: { type: "SYSTEM", id: "reconciliation-scheduler" }, operationId: "scan-block" });
  assert.equal(service.isBlocked("SKU", "SKU-BAD"), true);
  assert.equal(service.isBlocked("SKU", "SKU-GOOD"), false);

  db.prepare("UPDATE inventory_lots SET on_hand_base_int=7 WHERE id='lot-bad'").run();
  db.prepare("UPDATE inventory_lot_location_balances SET quantity_base_int=7 WHERE lot_id='lot-bad'").run();
  service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "scan-clean" });
  assert.equal(service.isBlocked("SKU", "SKU-BAD"), false);

  db.prepare("UPDATE inventory_lots SET on_hand_base_int=6 WHERE id='lot-bad'").run();
  const reopened = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "scan-reopen" });
  const critical = reopened.findings.filter((item) => item.severity === "CRITICAL" && item.affectedId === "SKU-BAD");
  critical.forEach((finding, index) => service.verifyFinding({ findingId: finding.id, reason: "Physical count independently verified", actorId: "admin", operationId: `verify-${index}` }));
  assert.equal(service.isBlocked("SKU", "SKU-BAD"), false);
});

test("repeat scans deterministically update and reopen one finding without duplicate noise", () => {
  const { db, service } = fixture();
  insertInventory(db, { onHand: 8, ledger: 7 });
  const first = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "dedupe-1" });
  const second = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "dedupe-2" });
  const firstFinding = first.findings.find((item) => item.code === "INVENTORY_LEDGER_MISMATCH")!;
  const secondFinding = second.findings.find((item) => item.code === "INVENTORY_LEDGER_MISMATCH")!;
  assert.equal(firstFinding.id, secondFinding.id);
  assert.equal(Number(db.prepare("SELECT COUNT(*) FROM reconciliation_findings WHERE identity_key=?").pluck().get(firstFinding.identityKey)), 1);
  assert.equal(secondFinding.occurrences, 2);

  db.prepare("UPDATE inventory_lots SET on_hand_base_int=7 WHERE id='lot-product-1'").run();
  db.prepare("UPDATE inventory_lot_location_balances SET quantity_base_int=7 WHERE lot_id='lot-product-1'").run();
  service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "dedupe-clean" });
  db.prepare("UPDATE inventory_lots SET on_hand_base_int=6 WHERE id='lot-product-1'").run();
  const reopened = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "dedupe-reopen" });
  assert.equal(reopened.findings.find((item) => item.identityKey === firstFinding.identityKey)?.status, "OPEN");
  assert.equal(Number(db.prepare("SELECT COUNT(*) FROM reconciliation_findings WHERE identity_key=?").pluck().get(firstFinding.identityKey)), 1);
});

test("domain checks detect finance, reservation, shipment, return, channel, kit and print contradictions", () => {
  const { db, service } = fixture();
  insertInventory(db, { reserved: 2 });
  db.pragma("foreign_keys = OFF");
  db.prepare("UPDATE inventory_lots SET reserved_base_int=3 WHERE id='lot-product-1'").run();
  db.prepare(`INSERT INTO sale_financial_snapshots
    (id,sale_id,snapshot_version,formula_version,currency,source_channel,gross_before_discount_minor,discount_minor,gross_amount_minor,vat_amount_minor,net_revenue_minor,
     gross_amount_base_try_minor,vat_amount_base_try_minor,net_revenue_base_try_minor,commission_rate_numerator,commission_rate_denominator,commission_calculation_basis,
     commission_terms_json,commission_amount_minor,commission_base_try_minor,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,
     created_operation_id,created_actor_id,created_at)
    VALUES ('fs','order-1',1,'v1','TRY','DIRECT',1000,0,1000,180,700,1000,180,700,0,1,'GROSS_AFTER_DISCOUNT','{}',0,0,1,1,'NONE','2026-09-23','BASE_TO_QUOTE','sale-op','admin','2026-09-23')`)
    .run();
  db.prepare("INSERT INTO inventory_reservations (id,order_id,status,reserve_operation_id,created_at) VALUES ('res-1','order-1','DISPATCHED','reserve-op','2026-09-23')").run();
  db.prepare("INSERT INTO shipment_preparations (id,order_id,reservation_id,state,created_operation_id,created_at,updated_at) VALUES ('ship-1','order-1','res-1','DISPATCHED','ship-op','2026-09-23','2026-09-23')").run();
  db.prepare("INSERT INTO channel_accounts (id,channel,environment,merchant_account_id,secret_reference,state) VALUES ('acct','TRENDYOL','STAGE','merchant','secret','CONNECTED')").run();
  db.prepare(`INSERT INTO channel_orders (id,account_id,external_order_id,latest_external_version,currency,actual_discount_minor,order_state,first_event_id,raw_order_digest)
    VALUES ('channel-order','acct','external-1','1','TRY',0,'ACCEPTED','event-1',?)`).run("a".repeat(64));
  db.prepare(`INSERT INTO printing_jobs (id,purpose,subject_type,subject_id,subject_code,request_hash,template_id,template_version,template_content_hash,template_snapshot_json,
    payload_snapshot_json,payload_snapshot_hash,status,created_operation_id,created_by) VALUES ('print-1','LOCATION','LOCATION','loc','LOC',?,'template',1,?,'{}','{}',?,'ACKNOWLEDGED','print-op','admin')`)
    .run("a".repeat(64),"b".repeat(64),"0".repeat(64));
  db.pragma("foreign_keys = ON");

  const result = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "domain-scan" });
  const codes = new Set(result.findings.map((finding) => finding.code));
  for (const code of ["INVENTORY_RESERVED_MISMATCH", "SALE_FINANCIAL_TOTAL_MISMATCH", "SHIPMENT_DISPATCH_CHAIN_MISMATCH",
    "CHANNEL_CANONICAL_LINK_MISMATCH", "PRINT_CHAIN_MISMATCH"]) assert.equal(codes.has(code), true, code);
});

test("return quantity/money bounds and sold frozen kit version are checked exactly", () => {
  const { db, service } = fixture();
  insertInventory(db);
  db.pragma("foreign_keys = OFF");
  db.prepare(`INSERT INTO sale_financial_snapshots
    (id,sale_id,snapshot_version,formula_version,currency,source_channel,gross_before_discount_minor,discount_minor,gross_amount_minor,vat_amount_minor,net_revenue_minor,
     gross_amount_base_try_minor,vat_amount_base_try_minor,net_revenue_base_try_minor,commission_rate_numerator,commission_rate_denominator,commission_calculation_basis,
     commission_terms_json,commission_amount_minor,commission_base_try_minor,fx_rate_numerator,fx_rate_denominator,fx_source,fx_observed_at,fx_direction,created_operation_id,created_actor_id,created_at)
    VALUES ('fs-return','order-return',1,'v1','TRY','DIRECT',1000,0,1000,180,820,1000,180,820,0,1,'GROSS_AFTER_DISCOUNT','{}',0,0,1,1,'NONE','2026-09-23','BASE_TO_QUOTE','sale-return-op','admin','2026-09-23')`).run();
  db.prepare(`INSERT INTO sale_financial_lines
    (id,financial_snapshot_id,sale_line_id,line_sequence,product_id,product_sku_snapshot,product_title_snapshot,catalog_version_snapshot,catalog_version_ref_snapshot,
     base_uom_code_snapshot,quantity_base_int,unit_gross_minor,gross_before_discount_minor,discount_allocation_minor,gross_amount_minor,vat_rate_bps,vat_amount_minor,
     net_revenue_minor,gross_amount_base_try_minor,vat_amount_base_try_minor,net_revenue_base_try_minor,created_at)
    VALUES ('fl-return','fs-return','sale-line-return',0,'product-1','SKU-1','SKU-1',1,'catalog:v1','piece',3,333,1000,0,1000,1800,180,820,1000,180,820,'2026-09-23')`).run();
  for (const index of [1, 2]) {
    db.prepare("INSERT INTO return_requests (id,sale_id,financial_snapshot_id,currency,request_operation_id,requested_by_actor_id,requested_at) VALUES (?,?,?,'TRY',?,?,'2026-09-23')")
      .run(`return-${index}`, "order-return", "fs-return", `return-op-${index}`, "admin");
    db.prepare("INSERT INTO return_request_lines (id,return_id,financial_line_id,sale_line_id,quantity_base_int,reason_code,created_at) VALUES (?,?,?,?,2,'DAMAGED','2026-09-23')")
      .run(`return-line-${index}`, `return-${index}`, "fl-return", "sale-line-return");
  }
  db.prepare("INSERT INTO refund_payments (id,return_id,approval_id,amount_minor,currency,payment_mode,payment_operation_id,paid_at) VALUES ('refund-1','return-1','approval-1',1200,'TRY','DIRECT_CASH_BANK','refund-op','2026-09-23')").run();
  db.prepare("INSERT INTO published_kits (id,workspace_kit_id,product_id,sku,current_version_id) VALUES ('kit','workspace-kit','product-1','KIT-1','kit-version')").run();
  db.prepare(`INSERT INTO published_kit_versions
    (id,published_kit_id,version_number,workspace_version_id,authored_content_hash,content_hash,core_policy_hash,product_catalog_version,product_catalog_version_ref,
     title_snapshot,currency,canonical_cost_minor,suggested_sale_price_minor,final_sale_price_minor,cost_formula_version,cost_provenance_json,packaging_snapshot_json,
     installation_guide_version,effective_kerf_mm,published_operation_id,published_by_actor_id,published_at)
    VALUES ('kit-version','kit',1,'workspace-v1',?,?,?,1,'catalog:v1','Kit','TRY',100,200,200,'v1','{}','{}','guide-v1',3,'publish-op','admin','2026-09-23')`)
    .run("a".repeat(64), "b".repeat(64), "c".repeat(64));
  db.prepare(`INSERT INTO sale_kit_version_snapshots
    (id,financial_line_id,sale_line_id,product_id,published_kit_id,published_kit_version_id,version_number,content_hash,is_current_at_sale,snapshot_json)
    VALUES ('sold-kit','fl-return','sale-line-return','product-1','kit','kit-version',2,?,1,'{}')`).run("d".repeat(64));
  db.pragma("foreign_keys = ON");
  const codes = new Set(service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "return-kit-scan" }).findings.map((finding) => finding.code));
  assert.equal(codes.has("RETURN_QUANTITY_BOUND_EXCEEDED"), true);
  assert.equal(codes.has("REFUND_MONEY_BOUND_EXCEEDED"), true);
  assert.equal(codes.has("SOLD_KIT_FROZEN_VERSION_MISMATCH"), true);
});

test("repair approval is admin-only and immutable evidence is preserved", () => {
  const { db, service } = fixture();
  insertInventory(db, { onHand: 8, ledger: 7 });
  const run = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: "admin" }, operationId: "repair-scan" });
  const finding = run.findings.find((item) => item.code === "INVENTORY_LEDGER_MISMATCH")!;
  const proposal = service.proposeRepair({ findingId: finding.id, commandType: "inventory.correct.v1", commandPayload: { lotId: "lot-product-1" }, reason: "Approved count correction", actorId: "admin", operationId: "proposal-1" });
  assert.throws(() => service.approveRepair({ proposalId: proposal.id, reason: "review", actorId: "user", actorIsAdmin: false, operationId: "approve-user" }), /admin/i);
  service.approveRepair({ proposalId: proposal.id, reason: "Independent review", actorId: "admin-2", actorIsAdmin: true, operationId: "approve-admin" });
  assert.equal(Number(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE lot_id='lot-product-1'").pluck().get()), 1);
  assert.equal(Number(db.prepare("SELECT COUNT(*) FROM reconciliation_history WHERE finding_id=?").pluck().get(finding.id)) >= 3, true);
  assert.throws(() => db.prepare("DELETE FROM reconciliation_history WHERE finding_id=?").run(finding.id), /immutable/i);
});

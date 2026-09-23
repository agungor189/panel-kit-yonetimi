import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { ExchangeRateService } from "../modules/finance/exchangeRates.js";
import { InventoryService } from "../modules/inventory/inventoryService.js";
import { ProcurementService } from "../modules/procurement/procurementService.js";
import { api, createRetryOperation } from "../../src/lib/api.js";

const panelRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

const freePort = async () => {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
};

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

test("real /api/sales reserves aggregated BOM inventory, releases cancellation, and never restores a dispatch", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-sale-inventory-"));
  const databasePath = path.join(temporaryDirectory, "panel.sqlite");
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);

  new CatalogService(db).createProduct({ id: "component", sku: "COMP", title: "Component", catalog_type: "product", base_uom_code: "piece" });
  new CatalogService(db).createProduct({ id: "kit-a", sku: "KIT-A", title: "Kit A", catalog_type: "product", base_uom_code: "piece" });
  new CatalogService(db).createProduct({ id: "kit-b", sku: "KIT-B", title: "Kit B", catalog_type: "product", base_uom_code: "piece" });
  db.prepare("INSERT INTO product_bom (id,parent_product_id,component_product_id,quantity_per_unit,component_role) VALUES (?,?,?,?,?)")
    .run("bom-a", "kit-a", "component", 2, "BODY");
  db.prepare("INSERT INTO product_bom (id,parent_product_id,component_product_id,quantity_per_unit,component_role) VALUES (?,?,?,?,?)")
    .run("bom-b", "kit-b", "component", 3, "BODY");
  db.prepare("INSERT INTO cash_accounts (id,name,currency,type) VALUES ('cash','Cash','TRY','cash')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('commission_rates',?)").run(JSON.stringify({ "Satış Sistemi": 10 }));
  db.prepare(`INSERT INTO users (id,username,password_hash,role,permissions,must_change_password,is_active)
    VALUES ('admin','admin',?,'admin','{}',0,1)`).run(bcrypt.hashSync("password-1", 4));
  new ExchangeRateService(db).recordCurrentUsdTry({
    rate: "40", source: "TEST", changedAt: "2026-09-20T08:00:00.000Z", actorId: "test",
  });

  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({
    id: "purchase", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
    invoiceNumber: "INV-SALE", invoiceDate: "2026-09-20",
    lines: [{ id: "line", productId: "component", quantity: "10", quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
  });
  const snapshot = procurement.finalizeAcquisitionCosts("purchase", { allocations: [] }).lots[0];
  new InventoryService(db).receiveCostedLot({
    receiptId: "receipt", costSnapshotId: snapshot.id, receivedAt: "2026-09-20T08:00:00.000Z",
    location: { id: "pick", kind: "PICKING" }, operationId: "setup-receipt",
  });
  db.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", path.join(panelRoot, "node_modules/tsx/dist/loader.mjs"), path.join(panelRoot, "server.ts")], {
    cwd: temporaryDirectory,
    env: {
      ...process.env,
      PORT: String(port), DB_PATH: databasePath, NODE_ENV: "production",
      JWT_SECRET: "test-jwt-secret-with-at-least-32-characters",
      PANEL_API_HASH_SECRET: "test-api-hash-secret-with-at-least-32-characters",
      ENCRYPTION_SECRET: "test-encryption-secret-with-at-least-32-chars",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { output += chunk.toString(); });
  const nativeFetch = globalThis.fetch;
  let browserClientInstalled = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server startup timed out\n${output}`)), 15_000);
      const poll = () => {
        if (output.includes("Server running")) { clearTimeout(timeout); resolve(); return; }
        if (child.exitCode !== null) { clearTimeout(timeout); reject(new Error(`server exited ${child.exitCode}\n${output}`)); return; }
        setTimeout(poll, 25);
      };
      poll();
    });
    const login = await nativeFetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ username: "admin", password: "password-1" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.ok(cookie);
    const request = (url: string, operationId: string, body: unknown, method = "POST") => nativeFetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json", origin: base, cookie, "x-operation-id": operationId },
      body: JSON.stringify(body),
    });
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", base);
      headers.set("cookie", cookie);
      const target = String(input).startsWith("/") ? `${base}${String(input)}` : input;
      return nativeFetch(target, { ...init, headers });
    }) as typeof fetch;
    browserClientInstalled = true;
    const saleBody = {
      customer_name: "Inventory customer", total_quantity: 2, cash_account_id: "cash", platform: "Satış Sistemi",
      currency: "TRY", discount_minor: 0, commission_rate: 10,
      commission_calculation_basis: "GROSS_BEFORE_DISCOUNT", commission_terms: { source: "test" },
      expenses: Object.fromEntries(["shipping", "packaging", "other"].map((category) => [category, { state: "UNKNOWN", provenance: { source: "test", category } }])),
      items: [
        { product_id: "kit-a", product_name: "Kit A", quantity: 1, unit_gross_minor: 5_000, vat_rate_bps: 2_000 },
        { product_id: "kit-b", product_name: "Kit B", quantity: 1, unit_gross_minor: 5_000, vat_rate_bps: 2_000 },
      ],
    };

    const rejectedAdvertisingSale = await request("/api/sales", "sale-advertising-not-allowed", {
      ...saleBody,
      expenses: { ...saleBody.expenses, advertising: { state: "KNOWN", amountMinor: 25, currency: "TRY", provenance: { source: "marketing-invoice" } } },
    });
    assert.equal(rejectedAdvertisingSale.status, 400, await rejectedAdvertisingSale.clone().text());
    assert.equal((await rejectedAdvertisingSale.json() as any).error.code, "SALE_ADVERTISING_NOT_SALE_EXPENSE");

    const createOperation = createRetryOperation("sale-create");
    const createOperationId = createOperation.idFor(saleBody);
    const createdBody = await api.post("/sales", saleBody, { operationId: createOperationId }) as any;
    assert.equal(createdBody.idempotent, false);
    const saleId = createdBody.id as string;
    const reservationId = `sale-reservation:${saleId}`;

    const inspect = new Database(databasePath, { readonly: true });
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 10, reserved: 5 });
    assert.deepEqual(inspect.prepare("SELECT product_id AS productId,quantity_base_int AS quantity FROM inventory_reservation_lines WHERE reservation_id=?").all(reservationId), [{ productId: "component", quantity: 5 }]);
    assert.equal(inspect.prepare("SELECT central_stock FROM products WHERE id='component'").pluck().get(), 10);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?) AND category='ADVERTISING'").pluck().get(saleId), 0);
    assert.equal(inspect.prepare("SELECT ad_spend FROM sales WHERE id=?").pluck().get(saleId), null);

    const replay = await api.post("/sales", saleBody, { operationId: createOperation.idFor(saleBody) }) as any;
    assert.equal(replay.idempotent, true);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);

    const updatePayload = { customer_name: "Updated inventory customer", status: "Hazırlanıyor" };
    const updateOperation = createRetryOperation("sale-update");
    const updated = await api.put(`/sales/${saleId}`, updatePayload, { operationId: updateOperation.idFor(updatePayload) }) as any;
    assert.equal(updated.sale.customer_name, "Updated inventory customer");

    const shortage = await request("/api/sales", "sale-shortage", { ...saleBody, items: [{ product_id: "kit-a", product_name: "Kit A", quantity: 3, unit_gross_minor: 5_000, vat_rate_bps: 2_000 }] });
    assert.equal(shortage.status, 409);
    assert.equal((await shortage.json() as any).error.code, "INSUFFICIENT_AVAILABLE_STOCK");
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_operations WHERE operation_id='sale-shortage'").pluck().get(), 0);

    const cancellationPayload = { status: "İptal Edildi" };
    const cancellationOperation = createRetryOperation("sale-cancel");
    const cancelled = await api.patch(`/sales/${saleId}/status`, cancellationPayload, { operationId: cancellationOperation.idFor(cancellationPayload) }) as any;
    assert.equal(cancelled.sale.status, "İptal Edildi");
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 10, reserved: 0 });

    const dispatchedSale = await request("/api/sales", "sale-create-2", { ...saleBody, items: [{ product_id: "kit-a", product_name: "Kit A", quantity: 1, unit_gross_minor: 10_000, vat_rate_bps: 2_000 }] });
    assert.equal(dispatchedSale.status, 201, await dispatchedSale.clone().text());
    const dispatchedSaleId = (await dispatchedSale.json() as any).id as string;
    const dispatchedReservation = `sale-reservation:${dispatchedSaleId}`;
    for (const [step, body] of [["pick", {}], ["pack", {}], ["dispatch", { shipmentId: "shipment-1", dispatchedAt: "2026-09-20T12:00:00.000Z" }]] as const) {
      const response = await request(`/api/inventory/v1/reservations/${dispatchedReservation}/${step}`, `sale-2-${step}`, body);
      assert.equal(response.status, 200, `${step}: ${await response.text()}`);
    }
    const dispatchReplay = await request(`/api/inventory/v1/reservations/${dispatchedReservation}/dispatch`, "sale-2-dispatch", { shipmentId: "shipment-1", dispatchedAt: "2026-09-20T12:00:00.000Z" });
    assert.equal(dispatchReplay.status, 200, await dispatchReplay.clone().text());
    assert.equal((await dispatchReplay.json() as any).idempotent, true);
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 8, reserved: 0 });
    assert.deepEqual(inspect.prepare("SELECT quantity_base_int AS quantity,cost_base_try_minor AS cost FROM sale_financial_cogs_allocations WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?)").all(dispatchedSaleId), [{ quantity: 2, cost: 200 }]);
    assert.equal(inspect.prepare("SELECT total_cogs_base_try_minor FROM sale_financial_cogs_finalizations WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?)").pluck().get(dispatchedSaleId), 200);
    const frozenCommission = inspect.prepare("SELECT commission_rate_numerator AS numerator,commission_rate_denominator AS denominator FROM sale_financial_snapshots WHERE sale_id=?").get(dispatchedSaleId);
    assert.deepEqual(frozenCommission, { numerator: 1, denominator: 10 });
    const settingsWriter = new Database(databasePath);
    settingsWriter.prepare("UPDATE settings SET value=? WHERE key='commission_rates'").run(JSON.stringify({ "Satış Sistemi": 99 }));
    settingsWriter.close();
    assert.deepEqual(inspect.prepare("SELECT commission_rate_numerator AS numerator,commission_rate_denominator AS denominator FROM sale_financial_snapshots WHERE sale_id=?").get(dispatchedSaleId), frozenCommission);

    const beforeExpenseFacts = inspect.prepare(`SELECT category,fact_version AS version,state,amount_base_try_minor AS amount
      FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?)
      ORDER BY category,fact_version`).all(dispatchedSaleId);
    assert.deepEqual(beforeExpenseFacts, [
      { category: "OTHER", version: 1, state: "UNKNOWN", amount: null },
      { category: "PACKAGING", version: 1, state: "UNKNOWN", amount: null },
      { category: "SHIPPING", version: 1, state: "UNKNOWN", amount: null },
    ]);
    assert.equal((await api.get(`/sales/${dispatchedSaleId}/financial`) as any).data.state, "PROVISIONAL");

    const panelProvenance = { source: "PANEL_SALE_DETAIL", entryPoint: "SALE_FINANCIAL_EXPENSE_EDITOR", scope: "SALE" };
    const expensePayload = { category: "shipping", state: "KNOWN", amountMinor: 25, currency: "TRY", provenance: panelProvenance };
    const expenseOperation = createRetryOperation("sale-expense-shipping");
    const expenseOperationId = expenseOperation.idFor(expensePayload);
    const expense = await request(`/api/sales/${dispatchedSaleId}/financial-expenses`, expenseOperationId, expensePayload);
    assert.equal(expense.status, 201, await expense.clone().text());
    assert.equal(expenseOperation.idFor(expensePayload), expenseOperationId);
    const expenseReplay = await request(`/api/sales/${dispatchedSaleId}/financial-expenses`, expenseOperation.idFor(expensePayload), expensePayload);
    assert.equal(expenseReplay.status, 201, await expenseReplay.clone().text());
    assert.equal((await expenseReplay.json() as any).idempotent, true);
    expenseOperation.complete(expenseOperationId);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?) AND category='SHIPPING'").pluck().get(dispatchedSaleId), 2);

    for (const category of ["packaging", "other"]) {
      const zeroExpense = await request(`/api/sales/${dispatchedSaleId}/financial-expenses`, `sale-2-${category}`, {
        category, state: "KNOWN", amountMinor: 0, currency: "TRY", provenance: panelProvenance,
      });
      assert.equal(zeroExpense.status, 201, await zeroExpense.clone().text());
    }
    const completedFinancial = (await api.get(`/sales/${dispatchedSaleId}/financial`) as any).data;
    assert.equal(completedFinancial.state, "FINAL");
    assert.equal(completedFinancial.expenses.packaging.amountTryMinor, 0);
    assert.equal(completedFinancial.expenses.other.amountTryMinor, 0);
    assert.equal(completedFinancial.totals.knownExpenseTryMinor, 25);
    assert.equal(completedFinancial.totals.netContributionTryMinor, 7_108);
    assert.deepEqual(inspect.prepare(`SELECT category,fact_version AS version,state,amount_base_try_minor AS amount
      FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?)
      ORDER BY category,fact_version`).all(dispatchedSaleId), [
      { category: "OTHER", version: 1, state: "UNKNOWN", amount: null },
      { category: "OTHER", version: 2, state: "KNOWN", amount: 0 },
      { category: "PACKAGING", version: 1, state: "UNKNOWN", amount: null },
      { category: "PACKAGING", version: 2, state: "KNOWN", amount: 0 },
      { category: "SHIPPING", version: 1, state: "UNKNOWN", amount: null },
      { category: "SHIPPING", version: 2, state: "KNOWN", amount: 25 },
    ]);
    assert.match(inspect.prepare("SELECT provenance_json FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?) AND category='SHIPPING' AND fact_version=2").pluck().get(dispatchedSaleId) as string, /PANEL_SALE_DETAIL/);

    const advertisingExpense = await request(`/api/sales/${dispatchedSaleId}/financial-expenses`, "sale-2-advertising", {
      category: "advertising", state: "KNOWN", amountMinor: 25, currency: "TRY", provenance: { source: "marketing-invoice" },
    });
    assert.equal(advertisingExpense.status, 400, await advertisingExpense.clone().text());
    assert.equal((await advertisingExpense.json() as any).error.code, "SALE_ADVERTISING_NOT_SALE_EXPENSE");
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sale_financial_expense_facts WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?) AND category='ADVERTISING'").pluck().get(dispatchedSaleId), 0);

    const returned = await request(`/api/sales/${dispatchedSaleId}/status`, "sale-return-2", { status: "İade Edildi" }, "PATCH");
    assert.equal(returned.status, 200, await returned.text());
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 8, reserved: 0 });
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1);

    const legacyAdjust = await request("/api/stock/adjust", "legacy-adjust", { product_id: "component", change_amount: 1, reason: "forbidden" });
    assert.equal(legacyAdjust.status, 409, await legacyAdjust.clone().text());
    assert.equal((await legacyAdjust.json() as any).error.code, "STOCK_ADJUSTMENT_REQUIRES_LOT_CORRECTION");
    assert.equal(inspect.prepare("SELECT central_stock FROM products WHERE id='component'").pluck().get(), 8);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_audit_log WHERE operation_id IN (?,?,?,'sale-create-2','sale-return-2')").pluck().get(createOperationId, updateOperation.idFor(updatePayload), cancellationOperation.idFor(cancellationPayload)), 5);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_outbox WHERE operation_record_id IN (SELECT id FROM command_operations WHERE operation_id IN (?,?,?,'sale-create-2','sale-return-2'))").pluck().get(createOperationId, updateOperation.idFor(updatePayload), cancellationOperation.idFor(cancellationPayload)), 10);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_audit_log WHERE operation_id IN ('sale-2-dispatch',?,'sale-2-packaging','sale-2-other')").pluck().get(expenseOperationId), 4);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_outbox WHERE operation_record_id IN (SELECT id FROM command_operations WHERE operation_id IN ('sale-2-dispatch',?,'sale-2-packaging','sale-2-other'))").pluck().get(expenseOperationId), 5);
    inspect.close();
  } finally {
    if (browserClientInstalled) globalThis.fetch = nativeFetch;
    await stop(child);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

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
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ username: "admin", password: "password-1" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.ok(cookie);
    const request = (url: string, operationId: string, body: unknown, method = "POST") => fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json", origin: base, cookie, "x-operation-id": operationId },
      body: JSON.stringify(body),
    });
    const saleBody = {
      customer_name: "Inventory customer", total_amount: 100, total_quantity: 2, cash_account_id: "cash", platform: "Satış Sistemi",
      items: [
        { product_id: "kit-a", product_name: "Kit A", quantity: 1, price: 50 },
        { product_id: "kit-b", product_name: "Kit B", quantity: 1, price: 50 },
      ],
    };

    const created = await request("/api/sales", "sale-create-1", saleBody);
    assert.equal(created.status, 201, `${await created.clone().text()}\n${output}`);
    const createdBody = await created.json() as any;
    assert.equal(createdBody.idempotent, false);
    const saleId = createdBody.id as string;
    const reservationId = `sale-reservation:${saleId}`;

    const inspect = new Database(databasePath, { readonly: true });
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 10, reserved: 5 });
    assert.deepEqual(inspect.prepare("SELECT product_id AS productId,quantity_base_int AS quantity FROM inventory_reservation_lines WHERE reservation_id=?").all(reservationId), [{ productId: "component", quantity: 5 }]);
    assert.equal(inspect.prepare("SELECT central_stock FROM products WHERE id='component'").pluck().get(), 10);

    const replay = await request("/api/sales", "sale-create-1", saleBody);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as any).idempotent, true);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);

    const shortage = await request("/api/sales", "sale-shortage", { ...saleBody, items: [{ product_id: "kit-a", product_name: "Kit A", quantity: 3, price: 50 }] });
    assert.equal(shortage.status, 409);
    assert.equal((await shortage.json() as any).error.code, "INSUFFICIENT_AVAILABLE_STOCK");
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM sales").pluck().get(), 1);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_operations WHERE operation_id='sale-shortage'").pluck().get(), 0);

    const cancelled = await request(`/api/sales/${saleId}/status`, "sale-cancel-1", { status: "İptal Edildi" }, "PATCH");
    assert.equal(cancelled.status, 200, await cancelled.text());
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 10, reserved: 0 });

    const dispatchedSale = await request("/api/sales", "sale-create-2", { ...saleBody, items: [{ product_id: "kit-a", product_name: "Kit A", quantity: 1, price: 100 }] });
    assert.equal(dispatchedSale.status, 201, await dispatchedSale.clone().text());
    const dispatchedSaleId = (await dispatchedSale.json() as any).id as string;
    const dispatchedReservation = `sale-reservation:${dispatchedSaleId}`;
    for (const [step, body] of [["pick", {}], ["pack", {}], ["dispatch", { shipmentId: "shipment-1", dispatchedAt: "2026-09-20T12:00:00.000Z" }]] as const) {
      const response = await request(`/api/inventory/v1/reservations/${dispatchedReservation}/${step}`, `sale-2-${step}`, body);
      assert.equal(response.status, 200, `${step}: ${await response.text()}`);
    }
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 8, reserved: 0 });

    const returned = await request(`/api/sales/${dispatchedSaleId}/status`, "sale-return-2", { status: "İade Edildi" }, "PATCH");
    assert.equal(returned.status, 200, await returned.text());
    assert.deepEqual(inspect.prepare("SELECT on_hand_base_int AS onHand,reserved_base_int AS reserved FROM inventory_lots WHERE product_id='component'").get(), { onHand: 8, reserved: 0 });
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1);

    const legacyAdjust = await request("/api/stock/adjust", "legacy-adjust", { product_id: "component", change_amount: 1, reason: "forbidden" });
    assert.equal(legacyAdjust.status, 409, await legacyAdjust.clone().text());
    assert.equal((await legacyAdjust.json() as any).error.code, "STOCK_ADJUSTMENT_REQUIRES_LOT_CORRECTION");
    assert.equal(inspect.prepare("SELECT central_stock FROM products WHERE id='component'").pluck().get(), 8);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_audit_log WHERE operation_id IN ('sale-create-1','sale-cancel-1','sale-create-2','sale-return-2')").pluck().get(), 4);
    assert.equal(inspect.prepare("SELECT COUNT(*) FROM command_outbox WHERE operation_record_id IN (SELECT id FROM command_operations WHERE operation_id IN ('sale-create-1','sale-cancel-1','sale-create-2','sale-return-2'))").pluck().get(), 7);
    inspect.close();
  } finally {
    await stop(child);
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.js";
import { runMigrations } from "../migrations/runner.js";
import { WarehouseAdminService } from "./warehouseAdminService.js";
import { WarehouseService, WarehouseServiceError } from "./warehouseService.js";
import { startPrintQueueWorker } from "./printQueueWorker.js";
import { createServer } from "node:http";

const actor = { id: "warehouse-user", username: "Depocu", role: "admin", permissions: {} };
let db: Database.Database;
let service: WarehouseAdminService;

const importRows = (overrides: Record<string, unknown> = {}) => [{
  SKU: "SKU-1",
  "Paket Sayısı": 2,
  "Paket İçi Adet": 6,
  "Toplam Adet": 12,
  Lot: "LOT-1",
  ...overrides,
}];

const createImportedBatch = (rows = importRows()) => {
  const batch = service.createBatch({ supplier_code: "SUP-1", supplier_name: "Tedarikçi" }, actor) as any;
  const preview = service.previewImport(batch.id, rows);
  return service.applyImport(batch.id, rows, preview.preview_hash, actor) as any;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  runMigrations(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, 'hash', 'admin', 1)").run(actor.id, actor.username);
  db.prepare("INSERT INTO products (id, title, name, sku, supplier_code, central_stock, product_type, status) VALUES ('product-1', 'Test ürün', 'Test ürün', 'SKU-1', 'SUP-SKU-1', 0, 'simple', 'Active')").run();
  service = new WarehouseAdminService(db, () => {}, { claimLeaseSeconds: 90 });
});

describe("Warehouse Admin giriş, paket ve lokasyon akışı", () => {
  test("kuru çalıştırma veritabanına yazmadan doğrular", () => {
    const batch = service.createBatch({ supplier_code: "SUP-1" }, actor) as any;
    const preview = service.previewImport(batch.id, importRows());
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.totals, { lines: 1, packages: 2, units: 12 });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages").get() as any).count, 0);
  });

  test("onay değişmiş önizlemeyi reddeder", () => {
    const batch = service.createBatch({ supplier_code: "SUP-1" }, actor) as any;
    const preview = service.previewImport(batch.id, importRows());
    assert.throws(() => service.applyImport(batch.id, importRows({ "Toplam Adet": 11 }), preview.preview_hash, actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "IMPORT_PREVIEW_CHANGED");
  });

  test("paketleri önceden, global benzersiz ve stabil 1/N sırasıyla oluşturur", () => {
    const batch = createImportedBatch();
    const packages = db.prepare("SELECT package_code, package_number, total_packages, planned_quantity FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    assert.equal(packages.length, 2);
    assert.match(packages[0].package_code, /^PKG-\d{4}-000001$/);
    assert.deepEqual(packages.map((pkg) => [pkg.package_number, pkg.total_packages, pkg.planned_quantity]), [[1, 2, 6], [2, 2, 6]]);
  });

  test("450 fiziksel paketi tek transaction içinde pratik sürede hazırlar", () => {
    const started = performance.now();
    const batch = createImportedBatch(importRows({ "Paket Sayısı": 450, "Paket İçi Adet": 10, "Toplam Adet": 4500 }));
    const count = (db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages WHERE batch_id = ?").get(batch.id) as any).count;
    assert.equal(count, 450);
    assert.ok(performance.now() - started < 5_000);
  });

  test("ardışık eşzamanlı claim isteklerine aynı paketi vermez", () => {
    createImportedBatch();
    const first = service.claimNextPackage("SUP-1", actor) as any;
    const second = service.claimNextPackage("SUP-1", actor) as any;
    assert.notEqual(first.id, second.id);
    assert.equal(first.package_number, 1);
    assert.equal(second.package_number, 2);
  });

  test("süresi dolan claim aynı paket için güvenle yeniden alınabilir", () => {
    createImportedBatch(importRows({ "Paket Sayısı": 1, "Paket İçi Adet": 5, "Toplam Adet": 5 }));
    const first = service.claimNextPackage("SUP-1", actor) as any;
    db.prepare("UPDATE warehouse_packages SET claim_expires_at = datetime('now', '-1 second') WHERE id = ?").run(first.id);
    const second = service.claimNextPackage("SUP-1", actor) as any;
    assert.equal(second.id, first.id);
    assert.notEqual(second.claim_token, first.claim_token);
  });

  test("baskı idempotenttir ve yeniden baskı paket kimliğini değiştirmez", () => {
    createImportedBatch(importRows({ "Paket Sayısı": 1, "Paket İçi Adet": 5, "Toplam Adet": 5 }));
    const pkg = service.claimNextPackage("SUP-1", actor) as any;
    const first = service.queuePrint(pkg.id, { claim_token: pkg.claim_token, idempotency_key: "print-1" }, actor) as any;
    const replay = service.queuePrint(pkg.id, { idempotency_key: "print-1" }, actor) as any;
    assert.equal(first.job.id, replay.job.id);
    db.prepare("UPDATE warehouse_packages SET status = 'PRINT_FAILED' WHERE id = ?").run(pkg.id);
    const reprint = service.queuePrint(pkg.id, { idempotency_key: "print-2" }, actor) as any;
    assert.notEqual(reprint.job.id, first.job.id);
    assert.equal(reprint.package.package_code, pkg.package_code);
  });

  test("baskı worker hatayı kaydeder, yeniden dener ve başarıda paketi LABELED yapar", async () => {
    createImportedBatch(importRows({ "Paket Sayısı": 1, "Paket İçi Adet": 5, "Toplam Adet": 5 }));
    const pkg = service.claimNextPackage("SUP-1", actor) as any;
    service.queuePrint(pkg.id, { claim_token: pkg.claim_token, idempotency_key: "worker-print" }, actor);
    let calls = 0;
    const renderer = createServer((_req, res) => {
      calls += 1;
      if (calls === 1) { res.statusCode = 500; res.end("temporary"); return; }
      res.setHeader("Content-Type", "application/pdf"); res.end(Buffer.from("%PDF-rendered"));
    });
    await new Promise<void>((resolve) => renderer.listen(0, "127.0.0.1", resolve));
    const address = renderer.address();
    assert.ok(address && typeof address !== "string");
    const worker = startPrintQueueWorker(db, {
      rendererUrl: `http://127.0.0.1:${address.port}`,
      dryRun: true,
      autoStart: false,
      logger: { info() {}, warn() {}, error() {} },
    });
    assert.equal(await worker.runOnce(), false);
    assert.equal((db.prepare("SELECT status, attempts FROM print_jobs WHERE idempotency_key = 'worker-print'").get() as any).status, "FAILED");
    assert.equal(await worker.runOnce(), true);
    assert.equal((db.prepare("SELECT status FROM print_jobs WHERE idempotency_key = 'worker-print'").get() as any).status, "PRINTED");
    assert.equal((db.prepare("SELECT status FROM warehouse_packages WHERE id = ?").get(pkg.id) as any).status, "LABELED");
    await new Promise<void>((resolve, reject) => renderer.close((error) => error ? reject(error) : resolve()));
  });

  test("yerleştirme sıra, kapasite, stok senkronu ve idempotency kurallarını uygular", () => {
    const batch = createImportedBatch();
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED'").run();
    service.createLocation({ code: "A1-K1-P1", package_capacity: 1 }, actor);
    assert.throws(() => service.placePackage(packages[1].package_code, "A1-K1-P1", { idempotency_key: "place-2" }, actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PACKAGE_OUT_OF_ORDER");
    const placed = service.placePackage(packages[0].package_code, "A1-K1-P1", { idempotency_key: "place-1" }, actor) as any;
    const replay = service.placePackage(packages[0].package_code, "A1-K1-P1", { idempotency_key: "place-1" }, actor) as any;
    assert.equal(placed.placement.id, replay.placement.id);
    assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'product-1'").get() as any).central_stock, 6);
    assert.throws(() => service.placePackage(packages[1].package_code, "A1-K1-P1", { idempotency_key: "place-full" }, actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "LOCATION_FULL");
  });

  test("taşıma ve sayım paket/merkez stoğunu atomik tutar", () => {
    const batch = createImportedBatch(importRows({ "Paket Sayısı": 1, "Paket İçi Adet": 6, "Toplam Adet": 6 }));
    const pkg = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ?").get(batch.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(pkg.id);
    service.createLocation({ code: "A1", package_capacity: 2 }, actor);
    service.createLocation({ code: "B1", package_capacity: 2 }, actor);
    service.placePackage(pkg.package_code, "A1", { idempotency_key: "place" }, actor);
    const moved = service.movePackage(pkg.package_code, "B1", { idempotency_key: "move" }, actor) as any;
    assert.equal(moved.package.location_code, "B1");
    const counted = service.countPackage(pkg.package_code, 4, { idempotency_key: "count" }, actor) as any;
    assert.equal(counted.package.remaining_quantity, 4);
    assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'product-1'").get() as any).central_stock, 4);
  });

  test("paket farkındalıklı toplama 1/N sırasıyla böler, ilk paketi EMPTY ikinciyi OPEN yapar", () => {
    const batch = createImportedBatch();
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    service.createLocation({ code: "A1", package_capacity: 2 }, actor);
    for (const [index, pkg] of packages.entries()) {
      db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(pkg.id);
      service.placePackage(pkg.package_code, "A1", { idempotency_key: `place-${index}` }, actor);
    }
    db.prepare("INSERT INTO sales (id, order_code, status, total_quantity) VALUES ('order-1', 'DS-1', 'Hazırlanıyor', 8)").run();
    db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES ('item-1', 'order-1', 'product-1', 'Test ürün', 8, 0)").run();
    const picking = new WarehouseService(db, () => {});
    const plan = picking.buildPickPlan("order-1")!;
    assert.deepEqual(plan.items[0].package_allocations.map((allocation: any) => allocation.pick_quantity), [6, 2]);
    picking.startPicking("order-1", actor);
    picking.verifyPick("order-1", "product-1", packages[0].package_code, actor);
    picking.completePickItem("order-1", "product-1", 8, actor);
    const after = db.prepare("SELECT status, remaining_quantity FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    assert.deepEqual(after.map((pkg) => [pkg.status, pkg.remaining_quantity]), [["EMPTY", 0], ["OPEN", 4]]);
    assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'product-1'").get() as any).central_stock, 4);
  });
});

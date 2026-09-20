import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../db/initialize.js";
import { receivingCapacityForLocation, WarehouseAdminService } from "./warehouseAdminService.js";
import { WarehouseService, WarehouseServiceError } from "./warehouseService.js";
import { startPrintQueueWorker } from "./printQueueWorker.js";
import { createServer } from "node:http";
import express from "express";
import { createWarehouseRouter, userHasWarehousePermission } from "../routes/warehouseRoutes.js";

const actor = { id: "warehouse-user", username: "Depocu", role: "admin", permissions: {} };
let db: Database.Database;
let service: WarehouseAdminService;
let activities: Array<{ action: string; actorId?: string }>;

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

const createLotSession = (lotNumber = "LOT-SESSION", packageCount = 4, unitsPerPackage = 5, locations?: { planned?: string; reserve?: string[] }) => {
  db.prepare("UPDATE products SET warehouse_location = ? WHERE id = 'product-1'").run(locations?.planned || null);
  db.prepare("DELETE FROM product_reserve_locations WHERE product_id = 'product-1'").run();
  for (const [index, location] of (locations?.reserve || []).entries()) {
    db.prepare("INSERT INTO product_reserve_locations (id, product_id, location, sort_order) VALUES (?, 'product-1', ?, ?)")
      .run(`reserve-${lotNumber}-${index}`, location, index);
  }
  db.prepare(`INSERT INTO inbound_lot_lines (
    id, lot_number, product_id, supplier_code, package_count, units_per_package, total_units, package_weight_kg, total_weight_kg
  ) VALUES (?, ?, 'product-1', 'SUP-SKU-1', ?, ?, ?, 2.5, ?)`)
    .run(`lot-${lotNumber}`, lotNumber, packageCount, unitsPerPackage, packageCount * unitsPerPackage, packageCount * 2.5);
  return service.startReceivingSession(lotNumber, actor, "device-a") as any;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, 'hash', 'admin', 1)").run(actor.id, actor.username);
  db.prepare("INSERT INTO users (id, username, password_hash, role, is_active) VALUES ('warehouse-user-2', 'Ayşe', 'hash', 'user', 1)").run();
  db.prepare("INSERT INTO products (id, title, name, sku, supplier_code, central_stock, product_type, status) VALUES ('product-1', 'Test ürün', 'Test ürün', 'SKU-1', 'SUP-SKU-1', 0, 'simple', 'Active')").run();
  activities = [];
  service = new WarehouseAdminService(db, (action, _entityType, _entityId, _details, actorId) => activities.push({ action, actorId }), { claimLeaseSeconds: 90 });
});

describe("Warehouse Admin giriş, paket ve lokasyon akışı", () => {
  test("mal kabul kapasitesi K1/K2 için üçle sınırlanır, diğer katlarda fiziksel kapasiteyi kullanır", () => {
    assert.equal(receivingCapacityForLocation("A1-K1-P1", 4), 3);
    assert.equal(receivingCapacityForLocation("A1-K2-P1", 4), 3);
    assert.equal(receivingCapacityForLocation("A1-K1-P1", 2), 2);
    assert.equal(receivingCapacityForLocation("A1-K3-P1", 4), 4);
    assert.equal(receivingCapacityForLocation("A1-K4-P1", 4), 4);
    assert.equal(receivingCapacityForLocation("BILINMEYEN", 4), 4);
  });

  test("legacy plan yalnız geometri olarak sürümlenir ve map snapshot kapasiteyi DB'den alır", () => {
    service.createLocation({ code: "G1-K1-P1", package_capacity: 3 }, actor);
    const imported = service.importLegacyLayout({
      warehouseConfig: { name: "DSDST Depo", width: 10, length: 5, height: 4 },
      objects: [{ id: "rack-1", type: "rack", name: "A1 Rafı", rackCode: "G1", x: 1, z: 1, width: 1.8, depth: .6, height: 1.8, shelfCount: 1, binsPerShelf: 1, defaultLocationCapacity: 99 }],
      products: [{ sku: "IMPORT-ETME" }], packages: [{ package_code: "IMPORT-ETME" }], locationStocks: [{ quantity: 999 }],
    }, actor) as any;
    assert.equal(imported.layout_version, 1);
    const snapshot = service.getWarehouseMap() as any;
    assert.equal(snapshot.warehouse.layout.objects[0].rackCode, "G1");
    assert.equal(snapshot.locations[0].capacity, 3);
    assert.equal(snapshot.data_quality.layout_only_locations.length, 0);
    assert.equal(JSON.stringify(snapshot.warehouse.layout).includes("IMPORT-ETME"), false);
  });

  test("placement layout rack listesini doğal rackCode sırasında döndürür", () => {
    const rackCodes = ["H1", "G2", "F1", "E2", "D4", "C2", "B2", "A2", "G1", "F2", "E1", "D3", "C1", "B1", "A1"];
    service.importLegacyLayout({
      warehouseConfig: { name: "DSDST Depo", width: 10, length: 5, height: 4 },
      objects: rackCodes.map((rackCode) => ({
        id: `rack-${rackCode}`,
        type: "rack",
        name: `${rackCode} Rafı`,
        rackCode,
        x: 0,
        z: 0,
        width: 2,
        depth: 1,
        height: 2,
        shelfCount: 4,
        positionsPerShelf: 7,
      })),
    }, actor);

    assert.deepEqual((service.getPlacementLayout() as any).racks.map((rack: any) => rack.rack_code), [
      "A1", "A2", "B1", "B2", "C1", "C2", "D3", "D4", "E1", "E2", "F1", "F2", "G1", "G2", "H1",
    ]);
  });

  test("yerleşim CSV önizlenir, atomik sürümlenir ve Mal Kabul hedefini aktif layouttan alır", () => {
    for (const [code, purpose] of [["A1-K1-P1", "PICK"], ["A1-K3-P1", "RESERVE"], ["A1-K4-P1", "RESERVE"]] as const) {
      service.createLocation({ code, package_capacity: 2, purpose }, actor);
    }
    service.importLegacyLayout({
      warehouseConfig: { name: "DSDST Depo", width: 10, length: 5, height: 4 },
      objects: [{ id: "rack-a1", type: "rack", name: "A1 Rafı", rackCode: "A1", x: 1, z: 1, width: 2, depth: .6, height: 2, shelfCount: 4, binsPerShelf: 2 }],
    }, actor);
    const csvText = "sku,pick_face_location,reserve_locations\nSKU-1,A1-K1-P1,A1-K3-P1|A1-K4-P1\n";
    const preview = service.previewPlacementLayout({ source_filename: "yerlesim.csv", csv_text: csvText }) as any;
    assert.equal(preview.valid, true);
    assert.deepEqual(preview.summary, { rows_read: 1, matched_skus: 1, unknown_skus: 0, invalid_locations: 0, pick_face_conflicts: 0, warnings: 0, errors: 0 });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_layout_assignments").get() as any).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages").get() as any).count, 0);

    const applied = service.applyPlacementLayout({ source_filename: "yerlesim.csv", csv_text: csvText, preview_hash: preview.preview_hash }, actor) as any;
    assert.equal(applied.active.layout_version, 2);
    assert.equal(applied.active.status, "ACTIVE");
    assert.equal(applied.assignments[0].pick_group, "Belirsiz / Belirsiz / Belirsiz");
    assert.deepEqual(applied.assignments[0].reserve_locations.map((item: any) => item.code), ["A1-K3-P1", "A1-K4-P1"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages").get() as any).count, 0);

    db.prepare(`INSERT INTO inbound_lot_lines
      (id, lot_number, product_id, supplier_code, package_count, units_per_package, total_units)
      VALUES ('layout-lot', 'LOT-LAYOUT', 'product-1', 'SUP-SKU-1', 1, 5, 5)`).run();
    const session = service.startReceivingSession("LOT-LAYOUT", actor, "device-layout") as any;
    const line = db.prepare("SELECT planned_location_snapshot, reserve_locations_snapshot FROM inbound_batch_lines WHERE batch_id = ?").get(session.id) as any;
    assert.equal(line.planned_location_snapshot, "A1-K1-P1");
    assert.deepEqual(JSON.parse(line.reserve_locations_snapshot), ["A1-K3-P1", "A1-K4-P1"]);
  });

  test("yerleşim CSV bilinmeyen SKU, geçersiz lokasyon ve pick-face çakışmasını uygulatmaz", () => {
    service.createLocation({ code: "A1-K1-P1", package_capacity: 2 }, actor);
    db.prepare("INSERT INTO products (id, title, name, sku, central_stock, product_type, status) VALUES ('product-2', 'İkinci', 'İkinci', 'SKU-2', 0, 'simple', 'Active')").run();
    service.importLegacyLayout({ warehouseConfig: { name: "Depo", width: 5, length: 5, height: 4 }, objects: [{ id: "rack", type: "rack", name: "A1", rackCode: "A1", x: 0, z: 0, width: 2, depth: 1, height: 2, shelfCount: 1, binsPerShelf: 1 }] }, actor);
    const csvText = "sku,pick_face_location,reserve_locations\nSKU-1,A1-K1-P1,\nSKU-2,A1-K1-P1,\nBILINMEYEN,A1-K9-P9,\n";
    const preview = service.previewPlacementLayout({ csv_text: csvText }) as any;
    assert.equal(preview.valid, false);
    assert.ok(preview.issues.some((issue: any) => issue.code === "UNKNOWN_SKU"));
    assert.ok(preview.issues.some((issue: any) => issue.code === "PICK_FACE_CONFLICT"));
    assert.ok(preview.issues.some((issue: any) => issue.code === "LOCATION_NOT_DEFINED"));
    assert.throws(() => service.applyPlacementLayout({ csv_text: csvText, preview_hash: preview.preview_hash }, actor), /Kritik doğrulama/);
  });

  test("hareket ve kullanıcı akışları tüm anlamlı depo olaylarını güvenle listeler", () => {
    db.prepare(`INSERT INTO activity_logs (id, action, entity_type, entity_id, details, user_id, actor_username)
      VALUES ('activity-1', 'WAREHOUSE_RECEIVING_SESSION_STARTED', 'inbound_batch', 'batch-1', 'geçersiz-json', ?, ?),
             ('activity-2', 'WAREHOUSE_PICKING_COMPLETED', 'sale', 'sale-1', '{}', ?, ?),
             ('activity-3', 'WAREHOUSE_PACKAGE_COUNTED', 'warehouse_package', 'package-1', '{"counted_quantity":4}', ?, ?)`)
      .run(actor.id, actor.username, actor.id, actor.username, actor.id, actor.username);
    let movements: any[];
    try {
      movements = service.listMovements() as any[];
    } catch (error) {
      throw new Error(`Hareket sorgusu çalışmadı: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.deepEqual(movements.map((item) => item.event_type).sort(), [
      "WAREHOUSE_RECEIVING_SESSION_STARTED", "WAREHOUSE_PICKING_COMPLETED", "WAREHOUSE_PACKAGE_COUNTED",
    ].sort());
    assert.equal((service.listUserActivity() as any[]).length, 3);
  });

  test("admin session yönetebilir, yalnız receive yetkili normal kullanıcı yeni session yönetemez", () => {
    assert.equal(userHasWarehousePermission(actor, "warehouse:manage_receiving_sessions"), true);
    const operator = { role: "user", permissions: { "warehouse:receive": true } } as any;
    assert.equal(userHasWarehousePermission(operator, "warehouse:receive"), true);
    assert.equal(userHasWarehousePermission(operator, "warehouse:manage_receiving_sessions"), false);
  });

  test("session yönetimi API'de admin ile operator arasında zorunlu ayrılır", async () => {
    db.prepare(`INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, permissions)
      VALUES ('warehouse-key', 'Warehouse', 'test', 'secret', 'cret', ?)`)
      .run(JSON.stringify(["read:warehouse_orders", "read:products", "write:warehouse_status"]));
    db.prepare(`INSERT INTO inbound_lot_lines (
      id, lot_number, product_id, supplier_code, package_count, units_per_package, total_units
    ) VALUES ('permission-lot', 'LOT-PERMISSION', 'product-1', 'SUP-SKU-1', 1, 5, 5)`).run();
    const operator = { id: "warehouse-user-2", username: "Ayşe", role: "user", permissions: { "warehouse:receive": true }, must_change_password: false };
    const adminUser = { ...actor, must_change_password: false };
    const app = express();
    app.use(express.json());
    app.use("/api/warehouse/v1", createWarehouseRouter({
      db, hashApiKey: (value) => value, logActivity: () => {}, uploadsDir: process.cwd(),
      authenticateUserToken: (token) => token === "admin-token" ? adminUser : token === "operator-token" ? operator : null,
    }));
    const http = createServer(app);
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const request = (path: string, token: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}/api/warehouse/v1${path}`, {
      ...init, headers: { "x-api-key": "secret", authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    const denied = await request("/admin/receiving/sessions", "operator-token", { method: "POST", body: JSON.stringify({ lot_number: "LOT-PERMISSION" }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as any).error.code, "FORBIDDEN");
    const layoutDenied = await request("/admin/layouts/placement/preview", "operator-token", { method: "POST", body: JSON.stringify({ csv_text: "sku,pick_face_location\nSKU-1,A1-K1-P1" }) });
    assert.equal(layoutDenied.status, 403);
    assert.equal((await layoutDenied.json() as any).error.code, "FORBIDDEN");
    const started = await request("/admin/receiving/sessions", "admin-token", { method: "POST", body: JSON.stringify({ lot_number: "LOT-PERMISSION" }) });
    assert.equal(started.status, 201);
    const visible = await request("/admin/receiving/sessions", "operator-token");
    assert.equal(visible.status, 200);
    assert.equal((await visible.json() as any).data.length, 1);
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
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

  test("lokasyon etiketini aynı renderer ve CUPS worker kuyruğunda purpose ile işler", async () => {
    const location = service.createLocation({ code: "A1-K1-P1", package_capacity: 2 }, actor) as any;
    const queued = service.queueLocationPrint(location.id, { idempotency_key: "location-print-1" }, actor) as any;
    const replay = service.queueLocationPrint(location.id, { idempotency_key: "location-print-1" }, actor) as any;
    assert.equal(queued.job.id, replay.job.id);
    let requestPath = "";
    let requestBody = "";
    const renderer = createServer((req, res) => {
      requestPath = req.url || "";
      req.on("data", (chunk) => { requestBody += chunk; });
      req.on("end", () => { res.setHeader("Content-Type", "application/pdf"); res.end(Buffer.from("%PDF-location")); });
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
    assert.equal(await worker.runOnce(), true);
    assert.equal(requestPath, "/api/v1/render");
    assert.deepEqual(JSON.parse(requestBody), { purpose: "location", data: { Lokasyon: "A1-K1-P1" } });
    assert.equal((db.prepare("SELECT status FROM label_print_jobs WHERE id = ?").get(queued.job.id) as any).status, "PRINTED");
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
    assert.throws(() => service.placePackage(packages[0].package_code, "A1-K1-P1", { idempotency_key: "competing-place" }, { ...actor, id: "warehouse-user-2", username: "Ayşe" }),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PACKAGE_NOT_LABELED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM package_placements WHERE package_id = ?").get(packages[0].id) as any).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_package_movements WHERE package_id = ? AND movement_type = 'INBOUND'").get(packages[0].id) as any).count, 1);
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

  test("iki farklı kullanıcı audit kayıtlarında doğru kimlikle korunur", () => {
    service.createLocation({ code: "A1", package_capacity: 1 }, actor);
    service.createLocation({ code: "B1", package_capacity: 1 }, { ...actor, id: "warehouse-user-2", username: "Ayşe" });
    assert.deepEqual(activities.filter((entry) => entry.action === "WAREHOUSE_LOCATION_CREATED").map((entry) => entry.actorId), [actor.id, "warehouse-user-2"]);
  });

  test("lot masterından tek ortak session ve mevcut 1/N paketleri oluşturur", () => {
    const session = createLotSession("LOT-4", 4, 5);
    const packages = db.prepare("SELECT package_number, total_packages FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
    assert.deepEqual(packages.map((pkg) => `${pkg.package_number}/${pkg.total_packages}`), ["1/4", "2/4", "3/4", "4/4"]);
    const resumed = service.startReceivingSession("lot-4", { ...actor, id: "warehouse-user-2", username: "Ayşe" }, "device-b") as any;
    assert.equal(resumed.id, session.id);
    assert.equal(resumed.resumed, true);
    const freshService = new WarehouseAdminService(db, () => {});
    assert.equal((freshService.listReceivingSessions() as any[])[0].id, session.id);
  });

  test("master rafı ve rezervler session başlangıcında snapshot edilir", () => {
    service.createLocation({ code: " a3 - k2 - p5 ", package_capacity: 2 }, actor);
    const session = createLotSession("LOT-SNAPSHOT", 1, 5, { planned: " a3 - k2 - p5 ", reserve: ["A3-K2-P6", "A3-K2-P7"] });
    db.prepare("UPDATE products SET warehouse_location = 'Z9' WHERE id = 'product-1'").run();
    db.prepare("DELETE FROM product_reserve_locations WHERE product_id = 'product-1'").run();
    const line = db.prepare("SELECT planned_location_snapshot, reserve_locations_snapshot FROM inbound_batch_lines WHERE batch_id = ?").get(session.id) as any;
    assert.equal(line.planned_location_snapshot, "A3-K2-P5");
    assert.deepEqual(JSON.parse(line.reserve_locations_snapshot), ["A3-K2-P6", "A3-K2-P7"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_locations WHERE code IN ('A3-K2-P5','A3-K2-P6','A3-K2-P7')").get() as any).count, 3);
    assert.equal((db.prepare("SELECT package_capacity FROM warehouse_locations WHERE code = 'A3-K2-P5'").get() as any).package_capacity, 2);
    assert.equal((db.prepare("SELECT package_capacity FROM warehouse_locations WHERE code = 'A3-K2-P6'").get() as any).package_capacity, 4);
    assert.equal((service.getLot("LOT-SNAPSHOT") as any).lines[0].warehouse_location, "Z9");
  });

  test("aynı SKU başka rafta olsa da LABELED paket master planlı rafı kullanır ve yanlış rafı reddeder", () => {
    const session = createLotSession("LOT-PLANNED", 2, 5, { planned: "A1-K1-P1" });
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
    const a1 = db.prepare("SELECT * FROM warehouse_locations WHERE code = 'A1-K1-P1'").get() as any;
    db.prepare("UPDATE warehouse_locations SET package_capacity = 2 WHERE id = ?").run(a1.id);
    const b1 = service.createLocation({ code: "B1-K1-P1", package_capacity: 2 }, actor) as any;
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id=?").run(b1.id, packages[0].id);
    db.prepare("UPDATE warehouse_packages SET status='LABELED' WHERE id=?").run(packages[1].id);
    const target = service.getReceivingLocation(packages[1].id) as any;
    assert.equal(target.code, "A1-K1-P1");
    assert.equal(target.using_reserve, false);
    assert.throws(() => service.placePackage(packages[1].package_code, "B1-K1-P1", { idempotency_key: "wrong-master" }, actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "WRONG_LOCATION");
    assert.equal((service.placePackage(packages[1].package_code, "A1-K1-P1", { idempotency_key: "right-master" }, actor) as any).package.location_code, "A1-K1-P1");
    assert.equal(a1.code, "A1-K1-P1");
  });

  test("planlı raf doluysa sıradaki rezervi kullanır; hepsi doluysa durur ve override korunur", () => {
    const session = createLotSession("LOT-RESERVE", 3, 5, { planned: "A1-K1-P1", reserve: ["R1-K1-P1"] });
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
    const a1 = db.prepare("SELECT * FROM warehouse_locations WHERE code = 'A1-K1-P1'").get() as any;
    const r1 = db.prepare("SELECT * FROM warehouse_locations WHERE code = 'R1-K1-P1'").get() as any;
    db.prepare("UPDATE warehouse_locations SET package_capacity = 1 WHERE id IN (?, ?)").run(a1.id, r1.id);
    service.createLocation({ code: "O1-K1-P1", package_capacity: 1 }, actor);
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id=?").run(a1.id, packages[0].id);
    db.prepare("UPDATE warehouse_packages SET status='LABELED' WHERE id=?").run(packages[1].id);
    const reserveTarget = service.getReceivingLocation(packages[1].id) as any;
    assert.equal(reserveTarget.code, "R1-K1-P1");
    assert.equal(reserveTarget.using_reserve, true);
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id=?").run(r1.id, packages[1].id);
    db.prepare("UPDATE warehouse_packages SET status='LABELED' WHERE id=?").run(packages[2].id);
    assert.throws(() => service.getReceivingLocation(packages[2].id),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_FULL" && error.message === "A1-K1-P1 planlanan lokasyonu dolu. Uygun rezerv lokasyon bulunamadı.");
    const overridden = service.placePackage(packages[2].package_code, "O1-K1-P1", { idempotency_key: "planned-override", override_reason: "Raflar dolu" }, actor) as any;
    assert.equal(overridden.package.location_code, "O1-K1-P1");
  });

  test("lot-scope claim farklı kullanıcıları farklı paketlere ayırır ve aynı paketi iki kez vermez", () => {
    const session = createLotSession("LOT-CLAIM", 2, 5);
    assert.throws(() => service.claimNextPackage("WRONG-SUP", actor, session.id),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PRODUCT_NOT_IN_ACTIVE_LOT" && error.message === "Bu ürün aktif partide bulunamadı.");
    const first = service.claimNextPackage("SUP-SKU-1", actor, session.id, "device-a") as any;
    const secondActor = { ...actor, id: "warehouse-user-2", username: "Ayşe" };
    const second = service.claimNextPackage("SUP-SKU-1", secondActor, session.id, "device-b") as any;
    assert.notEqual(first.id, second.id);
    assert.deepEqual([first.package_number, second.package_number], [1, 2]);
    assert.throws(() => service.claimNextPackage("SUP-SKU-1", secondActor, session.id),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "ACTIVE_PACKAGE_EXISTS");
  });

  test("claim kullanıcıya placement'a kadar bağlı kalır ve refresh sonrası bütün aşamalarda geri yüklenir", () => {
    const session = createLotSession("LOT-RESTORE", 1, 5, { planned: "A2-K1-P1" });
    const claimed = service.claimNextPackage("SUP-SKU-1", actor, session.id, "phone-a") as any;
    assert.equal((service.getMyActiveReceivingPackage(actor) as any).id, claimed.id);
    const freshService = new WarehouseAdminService(db, () => {});
    assert.equal((freshService.getMyActiveReceivingPackage(actor, session.id) as any).status, "CLAIMED");

    service.queuePrint(claimed.id, { claim_token: claimed.claim_token, idempotency_key: "restore-print" }, actor);
    assert.equal((freshService.getMyActiveReceivingPackage(actor) as any).status, "LABEL_QUEUED");
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(claimed.id);
    assert.equal((freshService.getMyActiveReceivingPackage(actor) as any).status, "LABELED");
    const target = service.getReceivingLocation(claimed.id, actor) as any;
    service.placePackage(claimed.package_code, target.code, { idempotency_key: "restore-place" }, actor);
    assert.equal(service.getMyActiveReceivingPackage(actor), null);
    const placed = db.prepare("SELECT current_location_id, receiving_location_reserved_at FROM warehouse_packages WHERE id = ?").get(claimed.id) as any;
    assert.equal(placed.current_location_id, target.id);
    assert.equal(placed.receiving_location_reserved_at, null);
    const location = (service.listLocations() as any[]).find((item) => item.id === target.id);
    assert.equal(location.occupied_packages, 1);
    assert.equal(location.reserved_packages, 0);
  });

  test("aktif receiving işi varken aynı kullanıcı ikinci paket claim edemez", () => {
    const session = createLotSession("LOT-ONE-WORK", 2, 5);
    const first = service.claimNextPackage("SUP-SKU-1", actor, session.id) as any;
    assert.throws(() => service.claimNextPackage("SUP-SKU-1", actor, session.id),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "ACTIVE_PACKAGE_EXISTS" && error.message.includes(`${first.sku_snapshot} 1/2`));
  });

  test("iki kullanıcının benim yerleştirdiklerim geçmişi birbirinden izole kalır", () => {
    const secondActor = { ...actor, id: "warehouse-user-2", username: "Ayşe" };
    const session = createLotSession("LOT-MY-HISTORY", 2, 5, { planned: "A4-K1-P1" });
    db.prepare("UPDATE warehouse_locations SET package_capacity = 2 WHERE code = 'A4-K1-P1'").run();
    const first = service.claimNextPackage("SUP-SKU-1", actor, session.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(first.id);
    service.getReceivingLocation(first.id, actor);
    service.placePackage(first.package_code, "A4-K1-P1", { idempotency_key: "history-alper" }, actor);
    const second = service.claimNextPackage("SUP-SKU-1", secondActor, session.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(second.id);
    service.getReceivingLocation(second.id, secondActor);
    service.placePackage(second.package_code, "A4-K1-P1", { idempotency_key: "history-ayse" }, secondActor);

    assert.deepEqual((service.listMyReceivingPackages(session.id, actor) as any[]).map((pkg) => pkg.package_code), [first.package_code]);
    const ayseHistory = service.listMyReceivingPackages(session.id, secondActor) as any[];
    assert.deepEqual(ayseHistory.map((pkg) => pkg.package_code), [second.package_code]);
    assert.equal(ayseHistory[0].image_url, "/api/products/product-1/image");
    assert.equal((service.getReceivingSession(session.id) as any).lines.length, 1);
    assert.equal((service.getReceivingSession(session.id, { includeAdminDetail: false }) as any).lines.length, 0);
  });

  test("son kapasite transaction içinde rezerve edilir ve claim reset rezervasyonu serbest bırakır", () => {
    const secondActor = { ...actor, id: "warehouse-user-2", username: "Ayşe" };
    const session = createLotSession("LOT-RESERVATION", 2, 5, { planned: "A5-K1-P1" });
    db.prepare("UPDATE warehouse_locations SET package_capacity = 1 WHERE code = 'A5-K1-P1'").run();
    const first = service.claimNextPackage("SUP-SKU-1", actor, session.id) as any;
    const second = service.claimNextPackage("SUP-SKU-1", secondActor, session.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id IN (?, ?)").run(first.id, second.id);
    assert.equal((service.getReceivingLocation(first.id, actor) as any).code, "A5-K1-P1");
    assert.throws(() => service.getReceivingLocation(second.id, secondActor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_FULL");
    service.releaseReceivingPackage(first.id, actor);
    assert.equal((service.getReceivingLocation(second.id, secondActor) as any).code, "A5-K1-P1");
  });

  test("K1/K2 rafında iki yerleşik ve bir rezerve paket yeni mal kabul önerisini engeller", () => {
    for (const level of [1, 2]) {
      const code = `A${level + 7}-K${level}-P1`;
      const session = createLotSession(`LOT-K${level}-RECEIVING-LIMIT`, 4, 5, { planned: code });
      const location = db.prepare("SELECT * FROM warehouse_locations WHERE code = ?").get(code) as any;
      const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
      assert.equal(location.package_capacity, 4);

      db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id IN (?, ?)")
        .run(location.id, packages[0].id, packages[1].id);
      db.prepare(`UPDATE warehouse_packages SET status='LABELED', recommended_location_id=?,
        receiving_location_reserved_at=CURRENT_TIMESTAMP WHERE id=?`).run(location.id, packages[2].id);
      db.prepare("UPDATE warehouse_packages SET status='LABELED' WHERE id=?").run(packages[3].id);

      assert.throws(() => service.getReceivingLocation(packages[3].id),
        (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_FULL");

      db.prepare("UPDATE warehouse_packages SET recommended_location_id=NULL, receiving_location_reserved_at=NULL WHERE id=?").run(packages[2].id);
      const accepted = service.getReceivingLocation(packages[3].id) as any;
      assert.equal(accepted.code, code);
      assert.equal(accepted.available_capacity, 0);

      const mapLocation = (service.getWarehouseMap() as any).locations.find((item: any) => item.code === code);
      assert.equal(mapLocation.capacity, 4);
    }
  });

  test("K3 rafı fiziksel kapasiteye kadar mal kabul eder", () => {
    const session = createLotSession("LOT-K3-RECEIVING-LIMIT", 5, 5, { planned: "A10-K3-P1" });
    const location = db.prepare("SELECT * FROM warehouse_locations WHERE code = 'A10-K3-P1'").get() as any;
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id IN (?, ?, ?)")
      .run(location.id, packages[0].id, packages[1].id, packages[2].id);
    db.prepare("UPDATE warehouse_packages SET status='LABELED' WHERE id IN (?, ?)").run(packages[3].id, packages[4].id);

    const accepted = service.getReceivingLocation(packages[3].id) as any;
    assert.equal(accepted.code, "A10-K3-P1");
    assert.equal(accepted.available_capacity, 0);
    assert.throws(() => service.getReceivingLocation(packages[4].id),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_FULL");
  });

  test("yarışan mal kabul placement işlemleri K1 limitini aşamaz", () => {
    const session = createLotSession("LOT-PLACE-RACE", 4, 5, { planned: "A11-K1-P1" });
    const location = db.prepare("SELECT * FROM warehouse_locations WHERE code = 'A11-K1-P1'").get() as any;
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(session.id) as any[];
    const secondActor = { ...actor, id: "warehouse-user-2", username: "Ayşe" };
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id IN (?, ?)")
      .run(location.id, packages[0].id, packages[1].id);
    db.prepare(`UPDATE warehouse_packages SET status='LABELED', recommended_location_id=?, claimed_by=? WHERE id=?`)
      .run(location.id, actor.id, packages[2].id);
    db.prepare(`UPDATE warehouse_packages SET status='LABELED', recommended_location_id=?, claimed_by=? WHERE id=?`)
      .run(location.id, secondActor.id, packages[3].id);

    service.placePackage(packages[2].package_code, location.code, { idempotency_key: "race-place-1" }, actor);
    const competingService = new WarehouseAdminService(db, () => {});
    assert.throws(() => competingService.placePackage(packages[3].package_code, location.code, { idempotency_key: "race-place-2" }, secondActor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "LOCATION_FULL");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages WHERE current_location_id=? AND status IN ('PLACED','OPEN')").get(location.id) as any).count, 3);
  });

  test("normal move K1 rafının dördüncü fiziksel kapasitesini kullanabilir", () => {
    const batch = createImportedBatch(importRows({ "Paket Sayısı": 4, "Paket İçi Adet": 5, "Toplam Adet": 20 }));
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    const target = service.createLocation({ code: "A12-K1-P1", package_capacity: 4 }, actor) as any;
    const source = service.createLocation({ code: "A12-K3-P1", package_capacity: 4 }, actor) as any;
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id IN (?, ?, ?)")
      .run(target.id, packages[0].id, packages[1].id, packages[2].id);
    db.prepare("UPDATE warehouse_packages SET status='PLACED', current_location_id=? WHERE id=?").run(source.id, packages[3].id);

    const moved = service.movePackage(packages[3].package_code, target.code, { idempotency_key: "move-to-physical-slot-4" }, actor) as any;
    assert.equal(moved.package.location_code, target.code);
    assert.equal((service.getWarehouseMap() as any).locations.find((item: any) => item.code === target.code).capacity, 4);
  });

  test("otomatik K1 rafı toplam üç placement/reservation kabul eder ve dördüncü paketi reddeder", () => {
    const workers = [
      actor,
      { ...actor, id: "warehouse-user-2", username: "Ayşe" },
      { ...actor, id: "warehouse-user-3", username: "Mehmet" },
      { ...actor, id: "warehouse-user-4", username: "Zeynep" },
    ];
    for (const worker of workers.slice(2)) {
      db.prepare("INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, 'hash', 'user', 1)")
        .run(worker.id, worker.username);
    }
    const session = createLotSession("LOT-AUTO-CAPACITY", 4, 5, { planned: "A7-K1-P1" });
    assert.equal((db.prepare("SELECT package_capacity FROM warehouse_locations WHERE code = 'A7-K1-P1'").get() as any).package_capacity, 4);

    for (let index = 0; index < 3; index += 1) {
      const claimed = service.claimNextPackage("SUP-SKU-1", workers[index], session.id) as any;
      db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(claimed.id);
      const target = service.getReceivingLocation(claimed.id, workers[index]) as any;
      assert.equal(target.code, "A7-K1-P1");
      if (index < 2) {
        service.placePackage(claimed.package_code, target.code, { idempotency_key: `auto-capacity-place-${index}` }, workers[index]);
      }
    }

    const fourth = service.claimNextPackage("SUP-SKU-1", workers[3], session.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(fourth.id);
    assert.throws(() => service.getReceivingLocation(fourth.id, workers[3]),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_FULL");
    const usage = (service.listLocations() as any[]).find((location) => location.code === "A7-K1-P1");
    assert.equal(usage.occupied_packages, 2);
    assert.equal(usage.reserved_packages, 1);
    assert.equal(usage.available_capacity, 1);
  });

  test("session iptali aktif iş claim ve lokasyon rezervasyonunu serbest bırakır", () => {
    const session = createLotSession("LOT-CANCEL-RESERVATION", 1, 5, { planned: "A6-K1-P1" });
    const claimed = service.claimNextPackage("SUP-SKU-1", actor, session.id) as any;
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(claimed.id);
    service.getReceivingLocation(claimed.id, actor);
    service.setReceivingState(session.id, "cancelled", actor);
    const cancelled = db.prepare(`SELECT claimed_by, recommended_location_id, receiving_location_reserved_at
      FROM warehouse_packages WHERE id = ?`).get(claimed.id) as any;
    assert.equal(cancelled.claimed_by, null);
    assert.equal(cancelled.recommended_location_id, null);
    assert.equal(cancelled.receiving_location_reserved_at, null);
  });

  test("format dışı ve katalogda bulunmayan master rafı kör şekilde oluşturulmaz", () => {
    assert.throws(() => createLotSession("LOT-BAD-LOCATION", 1, 5, { planned: "yanlış raf" }),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PLANNED_LOCATION_NOT_FOUND" && error.message.includes("Master ürün lokasyonunu kontrol edin"));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM warehouse_locations").get() as any).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM inbound_batches WHERE lot_number = 'LOT-BAD-LOCATION'").get() as any).count, 0);
  });

  test("aynı SKU farklı lotlarda karışmaz", () => {
    const first = createLotSession("LOT-A", 1, 5);
    db.prepare(`INSERT INTO inbound_lot_lines (id, lot_number, product_id, supplier_code, package_count, units_per_package, total_units)
      VALUES ('lot-b', 'LOT-B', 'product-1', 'SUP-SKU-1', 1, 7, 7)`).run();
    const second = service.startReceivingSession("LOT-B", actor) as any;
    const firstPackage = service.claimNextPackage("SUP-SKU-1", actor, first.id) as any;
    const secondPackage = service.claimNextPackage("SUP-SKU-1", { ...actor, id: "warehouse-user-2", username: "Ayşe" }, second.id) as any;
    assert.equal(firstPackage.lot_number, "LOT-A");
    assert.equal(secondPackage.lot_number, "LOT-B");
    assert.equal(secondPackage.planned_quantity, 7);
    assert.equal((service.listReceivingSessions() as any[]).filter((item) => item.receiving_state === "active").length, 2);
  });

  test("önerilmeyen rafı reddeder, tekrar yerleştirmede stoğu bir kez artırır ve sessionı tamamlar", () => {
    const session = createLotSession("LOT-PLACE", 1, 5);
    const pkg = service.claimNextPackage("SUP-SKU-1", actor, session.id) as any;
    service.queuePrint(pkg.id, { claim_token: pkg.claim_token, idempotency_key: "lot-print" }, actor);
    db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(pkg.id);
    service.createLocation({ code: "A1", package_capacity: 2 }, actor);
    service.createLocation({ code: "B1", package_capacity: 2 }, actor);
    const suggestion = service.suggestLocation(pkg.id) as any;
    assert.equal(suggestion.code, "A1");
    assert.throws(() => service.placePackage(pkg.package_code, "B1", { idempotency_key: "wrong" }, actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "WRONG_LOCATION");
    const placed = service.placePackage(pkg.package_code, "A1", { idempotency_key: "place-once", device_id: "device-a" }, actor) as any;
    const replay = service.placePackage(pkg.package_code, "A1", { idempotency_key: "place-once", device_id: "device-a" }, actor) as any;
    assert.equal(placed.placement.id, replay.placement.id);
    assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'product-1'").get() as any).central_stock, 5);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM warehouse_package_movements WHERE idempotency_key = ?").get(`place:${pkg.id}`) as any).count, 1);
    assert.equal((service.getReceivingSession(session.id) as any).receiving_state, "completed");
  });

  test("eksik session normal tamamlanmaz; yetkili sebebiyle force-complete edilir", () => {
    const session = createLotSession("LOT-FORCE", 2, 5);
    assert.throws(() => service.completeReceivingSession(session.id, "", actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "PACKAGES_REMAINING");
    const completed = service.completeReceivingSession(session.id, "Bir koli gümrükte kaldı", actor, "device-a") as any;
    assert.equal(completed.receiving_state, "completed");
    assert.equal(completed.force_complete_reason, "Bir koli gümrükte kaldı");
    assert.throws(() => service.setReceivingState(session.id, "active", actor),
      (error: unknown) => error instanceof WarehouseServiceError && error.code === "SESSION_CLOSED");
  });

  test("75'lik paketlerde 40 sonra 50 toplama 35+15 bölünür ve ikinci pakette 60 bırakır", () => {
    const batch = createImportedBatch(importRows({ "Paket Sayısı": 2, "Paket İçi Adet": 75, "Toplam Adet": 150 }));
    const packages = db.prepare("SELECT * FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    service.createLocation({ code: "A1", package_capacity: 2 }, actor);
    for (const [index, pkg] of packages.entries()) {
      db.prepare("UPDATE warehouse_packages SET status = 'LABELED' WHERE id = ?").run(pkg.id);
      service.placePackage(pkg.package_code, "A1", { idempotency_key: `place-${index}` }, actor);
    }
    db.prepare("INSERT INTO sales (id, order_code, status, total_quantity) VALUES ('order-1', 'DS-1', 'Hazırlanıyor', 40)").run();
    db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES ('item-1', 'order-1', 'product-1', 'Test ürün', 40, 0)").run();
    const picking = new WarehouseService(db, () => {});
    picking.startPicking("order-1", actor);
    picking.verifyPick("order-1", "product-1", packages[0].package_code, actor);
    picking.completePickItem("order-1", "product-1", 40, actor);
    let after = db.prepare("SELECT status, remaining_quantity FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    assert.deepEqual(after.map((pkg) => [pkg.status, pkg.remaining_quantity]), [["OPEN", 35], ["PLACED", 75]]);

    db.prepare("INSERT INTO sales (id, order_code, status, total_quantity) VALUES ('order-2', 'DS-2', 'Hazırlanıyor', 50)").run();
    db.prepare("INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight) VALUES ('item-2', 'order-2', 'product-1', 'Test ürün', 50, 0)").run();
    const plan = picking.buildPickPlan("order-2")!;
    assert.deepEqual(plan.items[0].package_allocations.map((allocation: any) => allocation.pick_quantity), [35, 15]);
    picking.startPicking("order-2", actor);
    picking.verifyPick("order-2", "product-1", packages[0].package_code, actor);
    picking.completePickItem("order-2", "product-1", 50, actor);
    after = db.prepare("SELECT status, remaining_quantity FROM warehouse_packages WHERE batch_id = ? ORDER BY package_number").all(batch.id) as any[];
    assert.deepEqual(after.map((pkg) => [pkg.status, pkg.remaining_quantity]), [["EMPTY", 0], ["OPEN", 60]]);
    assert.equal((db.prepare("SELECT central_stock FROM products WHERE id = 'product-1'").get() as any).central_stock, 60);
  });
});

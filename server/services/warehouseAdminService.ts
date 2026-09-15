import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { WarehouseServiceError, type WarehousePicker } from "./warehouseService.js";

export type WarehouseActor = WarehousePicker & { role: string; permissions: Record<string, unknown> };

type ActivityWriter = (
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown,
  actorId?: string,
) => void;

export const DEFAULT_CLAIM_LEASE_SECONDS = 90;

export const DEFAULT_PACKAGE_LABEL_TEMPLATE = {
  id: "warehouse-package-150x100-v1",
  name: "DSDST Depo Paket Etiketi",
  width: 150,
  height: 100,
  elements: [
    { id: "border", type: "box", x: 2, y: 2, width: 146, height: 96, borderWidth: 0.6 },
    { id: "brand", type: "text", x: 7, y: 6, width: 48, height: 8, value: "DSDST WAREHOUSE", fontSize: 5, fontWeight: "black" },
    { id: "package-code", type: "text", x: 58, y: 5, width: 84, height: 11, value: "{Package_code}", fontSize: 7, fontWeight: "black", textAlign: "right" },
    { id: "product-name", type: "text", x: 7, y: 20, width: 135, height: 15, value: "{Urun_adi}", fontSize: 6, fontWeight: "bold" },
    { id: "sku-label", type: "text", x: 7, y: 39, width: 55, height: 7, value: "SKU: {SKU}", fontSize: 4, fontWeight: "bold" },
    { id: "lot", type: "text", x: 66, y: 39, width: 76, height: 7, value: "LOT: {Parti_Lot}", fontSize: 4, textAlign: "right" },
    { id: "count", type: "text", x: 7, y: 49, width: 60, height: 8, value: "ADET: {Paket_ici_adet}", fontSize: 5, fontWeight: "black" },
    { id: "ordinal", type: "text", x: 76, y: 49, width: 66, height: 8, value: "PAKET {Paket_no}/{Toplam_paket}", fontSize: 5, fontWeight: "black", textAlign: "right" },
    { id: "package-barcode", type: "barcode", x: 7, y: 61, width: 96, height: 29, value: "{Package_code}", showBarcodeText: true },
    { id: "package-qr", type: "qr", x: 111, y: 61, width: 29, height: 29, value: "{Package_code}" },
  ],
};

const asNumber = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};

const clean = (value: unknown, max = 250) => String(value ?? "").trim().slice(0, max);
const keyOf = (value: unknown) => clean(value).toLocaleLowerCase("tr-TR").replace(/[^a-z0-9çğıöşü]+/gi, "_").replace(/^_+|_+$/g, "");

const rowValue = (row: Record<string, unknown>, names: string[]) => {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [keyOf(key), value]));
  for (const name of names) {
    const value = normalized.get(keyOf(name));
    if (value !== undefined && clean(value)) return value;
  }
  return undefined;
};

type NormalizedImportRow = {
  source_row: number;
  product_id: string;
  sku: string;
  product_name: string;
  supplier_product_code: string | null;
  lot_number: string | null;
  package_count: number;
  units_per_package: number;
  last_package_units: number;
  total_units: number;
};

export class WarehouseAdminService {
  private readonly claimLeaseSeconds: number;

  constructor(
    private readonly db: Database.Database,
    private readonly writeActivity: ActivityWriter,
    options: { claimLeaseSeconds?: number } = {},
  ) {
    this.claimLeaseSeconds = Math.max(15, Math.min(600, Math.trunc(options.claimLeaseSeconds || DEFAULT_CLAIM_LEASE_SECONDS)));
  }

  ensureDefaultTemplate(actorId?: string) {
    const existing = this.db.prepare("SELECT id FROM label_templates WHERE template_type = 'PACKAGE' AND is_default = 1 AND active = 1").get() as any;
    if (existing) return existing.id as string;
    const id = DEFAULT_PACKAGE_LABEL_TEMPLATE.id;
    this.db.prepare(`
      INSERT OR IGNORE INTO label_templates (id, name, template_type, version, template_json, active, is_default, created_by)
      VALUES (?, ?, 'PACKAGE', 1, ?, 1, 1, ?)
    `).run(id, DEFAULT_PACKAGE_LABEL_TEMPLATE.name, JSON.stringify(DEFAULT_PACKAGE_LABEL_TEMPLATE), actorId || null);
    return id;
  }

  createBatch(input: Record<string, unknown>, actor: WarehouseActor) {
    const supplierCode = clean(input.supplier_code, 100);
    if (!supplierCode) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Tedarikçi kodu zorunludur.");
    return this.db.transaction(() => {
      const id = randomUUID();
      const batchNumber = clean(input.batch_number, 100) || this.nextBatchNumber();
      this.db.prepare(`
        INSERT INTO inbound_batches (id, batch_number, supplier_code, supplier_name, source_filename, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, batchNumber, supplierCode, clean(input.supplier_name) || null, clean(input.source_filename) || null, actor.id);
      this.audit("WAREHOUSE_BATCH_CREATED", "inbound_batch", id, { batch_number: batchNumber, supplier_code: supplierCode }, actor);
      return this.getBatch(id);
    })();
  }

  listBatches() {
    return this.db.prepare(`
      SELECT b.*,
        COUNT(p.id) AS package_count,
        SUM(CASE WHEN p.status IN ('PLACED','OPEN','EMPTY') THEN 1 ELSE 0 END) AS placed_count,
        SUM(CASE WHEN p.status = 'LABELED' THEN 1 ELSE 0 END) AS labeled_count,
        SUM(CASE WHEN p.status = 'PRINT_FAILED' THEN 1 ELSE 0 END) AS print_failed_count
      FROM inbound_batches b
      LEFT JOIN warehouse_packages p ON p.batch_id = b.id
      GROUP BY b.id
      ORDER BY datetime(b.created_at) DESC, b.batch_number DESC
    `).all();
  }

  getBatch(id: string) {
    const batch = this.db.prepare("SELECT * FROM inbound_batches WHERE id = ?").get(id) as any;
    if (!batch) throw new WarehouseServiceError(404, "BATCH_NOT_FOUND", "Giriş partisi bulunamadı.");
    const lines = this.db.prepare(`
      SELECT l.*,
        SUM(CASE WHEN p.status IN ('PLACED','OPEN','EMPTY') THEN 1 ELSE 0 END) AS placed_count,
        SUM(CASE WHEN p.status IN ('LABELED','PLACED','OPEN','EMPTY') THEN 1 ELSE 0 END) AS labeled_count
      FROM inbound_batch_lines l
      LEFT JOIN warehouse_packages p ON p.batch_line_id = l.id
      WHERE l.batch_id = ?
      GROUP BY l.id ORDER BY l.line_number
    `).all(id);
    const statusCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM warehouse_packages WHERE batch_id = ? GROUP BY status ORDER BY status
    `).all(id);
    return { ...batch, lines, package_status_counts: statusCounts };
  }

  previewImport(batchId: string, sourceRows: unknown[]) {
    const batch = this.getBatch(batchId) as any;
    if (batch.status !== "DRAFT") throw new WarehouseServiceError(409, "BATCH_NOT_DRAFT", "Yalnızca taslak partiye veri aktarılabilir.");
    if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
      throw new WarehouseServiceError(400, "VALIDATION_ERROR", "İçe aktarılacak satır bulunamadı.");
    }
    if (sourceRows.length > 5000) throw new WarehouseServiceError(413, "IMPORT_TOO_LARGE", "Tek seferde en fazla 5000 satır aktarılabilir.");

    const rows: NormalizedImportRow[] = [];
    const errors: Array<{ source_row: number; code: string; message: string }> = [];
    const seen = new Set<string>();
    for (let index = 0; index < sourceRows.length; index += 1) {
      const sourceRow = index + 2;
      const source = sourceRows[index];
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        errors.push({ source_row: sourceRow, code: "INVALID_ROW", message: "Satır nesne biçiminde değil." });
        continue;
      }
      const row = source as Record<string, unknown>;
      const sku = clean(rowValue(row, ["sku", "stok kodu", "stok_kodu", "ürün sku"]), 150);
      const supplierProductCode = clean(rowValue(row, ["supplier_code", "tedarikçi kodu", "tedarikci_kodu", "ürün kodu", "urun_kodu"]), 150);
      const product = (sku ? this.db.prepare(`
        SELECT id, sku, COALESCE(NULLIF(title,''), NULLIF(name_tr,''), name, sku) AS product_name, supplier_code
        FROM products WHERE sku = ? COLLATE NOCASE AND COALESCE(status, 'Active') != 'deleted' LIMIT 1
      `).get(sku) : undefined) || (supplierProductCode ? this.db.prepare(`
        SELECT id, sku, COALESCE(NULLIF(title,''), NULLIF(name_tr,''), name, sku) AS product_name, supplier_code
        FROM products WHERE supplier_code = ? COLLATE NOCASE AND COALESCE(status, 'Active') != 'deleted' LIMIT 1
      `).get(supplierProductCode) : undefined) as any;
      if (!product) {
        errors.push({ source_row: sourceRow, code: "PRODUCT_NOT_FOUND", message: `${sku || supplierProductCode || "Kod yok"} için ürün bulunamadı.` });
        continue;
      }
      const duplicateKey = `${product.id}:${clean(rowValue(row, ["lot", "lot_number", "parti lot", "parti_lot"]))}`;
      if (seen.has(duplicateKey)) {
        errors.push({ source_row: sourceRow, code: "DUPLICATE_LINE", message: "Aynı ürün/lot birden fazla satırda bulunuyor." });
        continue;
      }
      seen.add(duplicateKey);
      const packageCountInput = asNumber(rowValue(row, ["package_count", "paket sayısı", "paket_sayisi", "toplam paket", "toplam_paket"]));
      const unitsPerPackage = asNumber(rowValue(row, ["units_per_package", "paket içi adet", "paket_ici_adet", "koli içi", "koli_ici"]));
      const totalUnitsInput = asNumber(rowValue(row, ["total_units", "toplam adet", "toplam_adet", "adet"]));
      const packageCount = Math.trunc(packageCountInput || (unitsPerPackage > 0 ? Math.ceil(totalUnitsInput / unitsPerPackage) : 0));
      const totalUnits = totalUnitsInput || packageCount * unitsPerPackage;
      if (packageCount <= 0 || unitsPerPackage <= 0 || totalUnits <= 0 || totalUnits > packageCount * unitsPerPackage) {
        errors.push({ source_row: sourceRow, code: "INVALID_QUANTITY", message: "Paket sayısı, paket içi adet ve toplam adet değerlerini kontrol edin." });
        continue;
      }
      const lastPackageUnits = totalUnits - (packageCount - 1) * unitsPerPackage;
      if (lastPackageUnits <= 0) {
        errors.push({ source_row: sourceRow, code: "INVALID_LAST_PACKAGE", message: "Son paket adedi sıfırdan büyük olmalıdır." });
        continue;
      }
      rows.push({
        source_row: sourceRow,
        product_id: product.id,
        sku: product.sku,
        product_name: product.product_name,
        supplier_product_code: product.supplier_code || supplierProductCode || null,
        lot_number: clean(rowValue(row, ["lot", "lot_number", "parti lot", "parti_lot"]), 150) || null,
        package_count: packageCount,
        units_per_package: unitsPerPackage,
        last_package_units: lastPackageUnits,
        total_units: totalUnits,
      });
    }
    const totals = rows.reduce((result, row) => ({
      lines: result.lines + 1,
      packages: result.packages + row.package_count,
      units: result.units + row.total_units,
    }), { lines: 0, packages: 0, units: 0 });
    const previewHash = this.importHash(batchId, rows);
    return { valid: errors.length === 0, rows, errors, totals, preview_hash: previewHash };
  }

  applyImport(batchId: string, sourceRows: unknown[], previewHash: string, actor: WarehouseActor) {
    const preview = this.previewImport(batchId, sourceRows);
    if (!preview.valid) throw new WarehouseServiceError(400, "IMPORT_HAS_ERRORS", "Hatalı satırlar düzeltilmeden aktarım yapılamaz.");
    if (!previewHash || previewHash !== preview.preview_hash) {
      throw new WarehouseServiceError(409, "IMPORT_PREVIEW_CHANGED", "Önizleme değişti. Onaylamadan önce yeniden önizleyin.");
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT COUNT(*) AS count FROM inbound_batch_lines WHERE batch_id = ?").get(batchId) as any;
      if (Number(existing.count) > 0) throw new WarehouseServiceError(409, "BATCH_ALREADY_IMPORTED", "Bu partiye daha önce veri aktarıldı.");
      const templateId = this.ensureDefaultTemplate(actor.id);
      const insertLine = this.db.prepare(`
        INSERT INTO inbound_batch_lines (
          id, batch_id, line_number, supplier_code, product_id, sku_snapshot, product_name_snapshot,
          lot_number, expected_package_count, units_per_package, last_package_units, total_units
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertPackage = this.db.prepare(`
        INSERT INTO warehouse_packages (
          id, package_code, batch_id, batch_line_id, product_id, supplier_code, package_number,
          total_packages, planned_quantity, remaining_quantity, status, label_template_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPECTED', ?)
      `);
      const batch = this.db.prepare("SELECT supplier_code FROM inbound_batches WHERE id = ? AND status = 'DRAFT'").get(batchId) as any;
      if (!batch) throw new WarehouseServiceError(409, "BATCH_NOT_DRAFT", "Parti artık taslak durumda değil.");
      preview.rows.forEach((row, index) => {
        const lineId = randomUUID();
        insertLine.run(
          lineId, batchId, index + 1, row.supplier_product_code || batch.supplier_code, row.product_id,
          row.sku, row.product_name, row.lot_number, row.package_count, row.units_per_package,
          row.last_package_units, row.total_units,
        );
        for (let packageIndex = 1; packageIndex <= row.package_count; packageIndex += 1) {
          const quantity = packageIndex === row.package_count ? row.last_package_units : row.units_per_package;
          insertPackage.run(
            randomUUID(), this.nextPackageCode(), batchId, lineId, row.product_id, batch.supplier_code,
            packageIndex, row.package_count, quantity, quantity, templateId,
          );
        }
      });
      this.db.prepare(`
        UPDATE inbound_batches SET status = 'READY', expected_package_count = ?, expected_unit_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(preview.totals.packages, preview.totals.units, batchId);
      this.audit("WAREHOUSE_BATCH_IMPORTED", "inbound_batch", batchId, preview.totals, actor);
      return this.getBatch(batchId);
    })();
  }

  claimNextPackage(supplierCode: string, actor: WarehouseActor) {
    const code = clean(supplierCode, 100);
    if (!code) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Tedarikçi kodu zorunludur.");
    return this.db.transaction(() => {
      const candidate = this.db.prepare(`
        SELECT p.id
        FROM warehouse_packages p
        JOIN inbound_batches b ON b.id = p.batch_id
        JOIN inbound_batch_lines l ON l.id = p.batch_line_id
        WHERE p.supplier_code = ? COLLATE NOCASE
          AND b.status NOT IN ('COMPLETED','CANCELLED')
          AND (p.status = 'EXPECTED' OR (p.status = 'CLAIMED' AND datetime(p.claim_expires_at) <= datetime('now')))
        ORDER BY datetime(b.created_at), l.line_number, p.package_number
        LIMIT 1
      `).get(code) as any;
      if (!candidate) throw new WarehouseServiceError(404, "NO_PACKAGE_AVAILABLE", "Bu tedarikçi kodu için bekleyen paket yok.");
      const claimToken = randomUUID();
      const result = this.db.prepare(`
        UPDATE warehouse_packages
        SET status = 'CLAIMED', claim_token = ?, claimed_by = ?,
            claim_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (status = 'EXPECTED' OR (status = 'CLAIMED' AND datetime(claim_expires_at) <= datetime('now')))
      `).run(claimToken, actor.id, `+${this.claimLeaseSeconds} seconds`, candidate.id);
      if (result.changes !== 1) throw new WarehouseServiceError(409, "PACKAGE_ALREADY_CLAIMED", "Paket başka bir kullanıcı tarafından alındı; yeniden okutun.");
      this.db.prepare("UPDATE inbound_batches SET status = 'RECEIVING', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT batch_id FROM warehouse_packages WHERE id = ?) AND status = 'READY'").run(candidate.id);
      this.audit("WAREHOUSE_PACKAGE_CLAIMED", "warehouse_package", candidate.id, { claim_seconds: this.claimLeaseSeconds }, actor);
      return this.getPackage(candidate.id);
    }).immediate();
  }

  getPackageByCode(packageCode: string) {
    const row = this.db.prepare("SELECT id FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
    if (!row) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
    return this.getPackage(row.id);
  }

  getPackage(id: string) {
    const pkg = this.db.prepare(`
      SELECT p.*, b.batch_number, l.line_number, l.sku_snapshot, l.product_name_snapshot, l.lot_number,
             l.units_per_package, loc.code AS location_code,
             t.name AS template_name, t.template_json
      FROM warehouse_packages p
      JOIN inbound_batches b ON b.id = p.batch_id
      JOIN inbound_batch_lines l ON l.id = p.batch_line_id
      LEFT JOIN warehouse_locations loc ON loc.id = p.current_location_id
      LEFT JOIN label_templates t ON t.id = p.label_template_id
      WHERE p.id = ?
    `).get(id) as any;
    if (!pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
    return { ...pkg, label_template: pkg.template_json ? JSON.parse(pkg.template_json) : null, claim_lease_seconds: this.claimLeaseSeconds };
  }

  queuePrint(packageId: string, input: Record<string, unknown>, actor: WarehouseActor) {
    const idempotencyKey = clean(input.idempotency_key, 200);
    if (!idempotencyKey) throw new WarehouseServiceError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key zorunludur.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM print_jobs WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) {
        if ((existing as any).package_id !== packageId) throw new WarehouseServiceError(409, "IDEMPOTENCY_KEY_CONFLICT", "Bu işlem anahtarı başka bir paket için kullanılmış.");
        return { job: existing, package: this.getPackage(packageId), idempotent: true };
      }
      const pkg = this.db.prepare("SELECT * FROM warehouse_packages WHERE id = ?").get(packageId) as any;
      if (!pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
      const reprint = ["LABELED", "PLACED", "OPEN", "EMPTY", "PRINT_FAILED"].includes(pkg.status);
      if (!reprint) {
        if (pkg.status !== "CLAIMED" || pkg.claimed_by !== actor.id || pkg.claim_token !== clean(input.claim_token, 100) || new Date(`${pkg.claim_expires_at}Z`).getTime() <= Date.now()) {
          throw new WarehouseServiceError(409, "CLAIM_EXPIRED", "Paket rezervasyonu geçersiz veya süresi dolmuş; tekrar okutun.");
        }
      }
      const templateId = clean(input.template_id, 100) || pkg.label_template_id || this.ensureDefaultTemplate(actor.id);
      const template = this.db.prepare("SELECT id FROM label_templates WHERE id = ? AND active = 1").get(templateId);
      if (!template) throw new WarehouseServiceError(404, "TEMPLATE_NOT_FOUND", "Etiket şablonu bulunamadı.");
      const jobId = randomUUID();
      this.db.prepare(`
        INSERT INTO print_jobs (id, package_id, template_id, idempotency_key, printer_name, package_status_before, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, packageId, templateId, idempotencyKey, clean(input.printer_name, 160) || null, pkg.status, actor.id);
      this.db.prepare(`
        UPDATE warehouse_packages SET status = CASE WHEN status IN ('PLACED','OPEN','EMPTY') THEN status ELSE 'LABEL_QUEUED' END,
          label_template_id = ?, claim_token = NULL,
          claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(templateId, packageId);
      this.audit(reprint ? "WAREHOUSE_LABEL_REPRINT_QUEUED" : "WAREHOUSE_LABEL_QUEUED", "warehouse_package", packageId, { job_id: jobId }, actor);
      return { job: this.db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(jobId), package: this.getPackage(packageId), idempotent: false };
    })();
  }

  listPrintJobs(limit = 100) {
    return this.db.prepare(`
      SELECT j.*, p.package_code, p.status AS package_status, l.sku_snapshot, l.product_name_snapshot
      FROM print_jobs j JOIN warehouse_packages p ON p.id = j.package_id
      JOIN inbound_batch_lines l ON l.id = p.batch_line_id
      ORDER BY datetime(j.created_at) DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  createLocation(input: Record<string, unknown>, actor: WarehouseActor) {
    const code = clean(input.code, 100).toUpperCase();
    const capacity = Math.trunc(asNumber(input.package_capacity) || 1);
    if (!code || capacity < 1) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Lokasyon kodu ve pozitif kapasite zorunludur.");
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO warehouse_locations (id, code, zone, aisle, rack, shelf, bin, package_capacity, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, code, clean(input.zone) || null, clean(input.aisle) || null, clean(input.rack) || null, clean(input.shelf) || null, clean(input.bin) || null, capacity, clean(input.notes, 1000) || null, actor.id);
    this.audit("WAREHOUSE_LOCATION_CREATED", "warehouse_location", id, { code, package_capacity: capacity }, actor);
    return this.db.prepare("SELECT * FROM warehouse_locations WHERE id = ?").get(id);
  }

  listLocations() {
    return this.db.prepare(`
      SELECT l.*, COUNT(p.id) AS occupied_packages,
             MAX(0, l.package_capacity - COUNT(p.id)) AS available_capacity
      FROM warehouse_locations l
      LEFT JOIN warehouse_packages p ON p.current_location_id = l.id AND p.status IN ('PLACED','OPEN')
      GROUP BY l.id ORDER BY l.code COLLATE NOCASE
    `).all();
  }

  suggestLocation() {
    const row = this.db.prepare(`
      SELECT l.*, COUNT(p.id) AS occupied_packages,
             l.package_capacity - COUNT(p.id) AS available_capacity
      FROM warehouse_locations l
      LEFT JOIN warehouse_packages p ON p.current_location_id = l.id AND p.status IN ('PLACED','OPEN')
      WHERE l.active = 1
      GROUP BY l.id HAVING COUNT(p.id) < l.package_capacity
      ORDER BY COUNT(p.id), l.code COLLATE NOCASE LIMIT 1
    `).get();
    if (!row) throw new WarehouseServiceError(409, "NO_LOCATION_CAPACITY", "Kullanılabilir lokasyon kapasitesi yok.");
    return row;
  }

  placePackage(packageCode: string, locationCode: string, input: Record<string, unknown>, actor: WarehouseActor) {
    const idempotencyKey = clean(input.idempotency_key, 200);
    if (!idempotencyKey) throw new WarehouseServiceError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key zorunludur.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM package_placements WHERE idempotency_key = ?").get(idempotencyKey) as any;
      if (existing) {
        const requested = this.db.prepare("SELECT id FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
        if (!requested || requested.id !== existing.package_id) throw new WarehouseServiceError(409, "IDEMPOTENCY_KEY_CONFLICT", "Bu işlem anahtarı başka bir paket için kullanılmış.");
        return { placement: existing, package: this.getPackage(existing.package_id), idempotent: true };
      }
      const pkg = this.db.prepare("SELECT * FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
      if (!pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
      const location = this.db.prepare("SELECT * FROM warehouse_locations WHERE code = ? COLLATE NOCASE AND active = 1").get(clean(locationCode, 100)) as any;
      if (!location) throw new WarehouseServiceError(404, "LOCATION_NOT_FOUND", "Aktif lokasyon bulunamadı.");
      if (pkg.status !== "LABELED") throw new WarehouseServiceError(409, "PACKAGE_NOT_LABELED", "Yerleştirmeden önce paket etiketi başarıyla basılmalıdır.");
      const occupied = this.db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages WHERE current_location_id = ? AND status IN ('PLACED','OPEN')").get(location.id) as any;
      if (Number(occupied.count) >= Number(location.package_capacity)) throw new WarehouseServiceError(409, "LOCATION_FULL", "Lokasyon kapasitesi dolu.");
      const lowerPending = this.db.prepare(`
        SELECT package_code FROM warehouse_packages
        WHERE batch_line_id = ? AND package_number < ?
          AND status NOT IN ('PLACED','OPEN','EMPTY','MISSING','DAMAGED','QUARANTINED','CANCELLED')
        ORDER BY package_number LIMIT 1
      `).get(pkg.batch_line_id, pkg.package_number) as any;
      const overrideReason = clean(input.override_reason, 1000);
      if (lowerPending && !overrideReason) {
        throw new WarehouseServiceError(409, "PACKAGE_OUT_OF_ORDER", `Önce ${lowerPending.package_code} yerleştirilmelidir.`);
      }
      const placementId = randomUUID();
      this.db.prepare(`
        INSERT INTO package_placements (id, package_id, from_location_id, to_location_id, action, idempotency_key, override_reason, actor_id)
        VALUES (?, ?, NULL, ?, 'PLACE', ?, ?, ?)
      `).run(placementId, pkg.id, location.id, idempotencyKey, overrideReason || null, actor.id);
      this.db.prepare(`
        UPDATE warehouse_packages SET status = 'PLACED', current_location_id = ?, placed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(location.id, pkg.id);
      this.recordStockMovement(pkg, "INBOUND", pkg.planned_quantity, "package_placement", placementId, `place:${pkg.id}`, actor);
      this.db.prepare("UPDATE products SET central_stock = COALESCE(central_stock, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pkg.planned_quantity, pkg.product_id);
      this.db.prepare("INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type) VALUES (?, ?, 'WAREHOUSE', ?, ?, 'IN')")
        .run(randomUUID(), pkg.product_id, pkg.planned_quantity, `Paket girişi: ${pkg.package_code}`);
      this.refreshBatchStatus(pkg.batch_id);
      this.audit("WAREHOUSE_PACKAGE_PLACED", "warehouse_package", pkg.id, { location_code: location.code, quantity: pkg.planned_quantity, override_reason: overrideReason || null }, actor);
      return { placement: this.db.prepare("SELECT * FROM package_placements WHERE id = ?").get(placementId), package: this.getPackage(pkg.id), idempotent: false };
    })();
  }

  movePackage(packageCode: string, locationCode: string, input: Record<string, unknown>, actor: WarehouseActor) {
    const idempotencyKey = clean(input.idempotency_key, 200);
    if (!idempotencyKey) throw new WarehouseServiceError(400, "IDEMPOTENCY_KEY_REQUIRED", "idempotency_key zorunludur.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM package_placements WHERE idempotency_key = ?").get(idempotencyKey) as any;
      if (existing) {
        const requested = this.db.prepare("SELECT id FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
        if (!requested || requested.id !== existing.package_id) throw new WarehouseServiceError(409, "IDEMPOTENCY_KEY_CONFLICT", "Bu işlem anahtarı başka bir paket için kullanılmış.");
        return { placement: existing, package: this.getPackage(existing.package_id), idempotent: true };
      }
      const pkg = this.db.prepare("SELECT * FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
      if (!pkg || !["PLACED", "OPEN"].includes(pkg.status)) throw new WarehouseServiceError(409, "PACKAGE_NOT_MOVABLE", "Paket taşınabilir durumda değil.");
      const location = this.db.prepare("SELECT * FROM warehouse_locations WHERE code = ? COLLATE NOCASE AND active = 1").get(clean(locationCode, 100)) as any;
      if (!location) throw new WarehouseServiceError(404, "LOCATION_NOT_FOUND", "Aktif lokasyon bulunamadı.");
      if (location.id === pkg.current_location_id) throw new WarehouseServiceError(409, "SAME_LOCATION", "Paket zaten bu lokasyonda.");
      const occupied = this.db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages WHERE current_location_id = ? AND status IN ('PLACED','OPEN')").get(location.id) as any;
      if (Number(occupied.count) >= Number(location.package_capacity)) throw new WarehouseServiceError(409, "LOCATION_FULL", "Lokasyon kapasitesi dolu.");
      const placementId = randomUUID();
      this.db.prepare(`
        INSERT INTO package_placements (id, package_id, from_location_id, to_location_id, action, idempotency_key, actor_id)
        VALUES (?, ?, ?, ?, 'MOVE', ?, ?)
      `).run(placementId, pkg.id, pkg.current_location_id, location.id, idempotencyKey, actor.id);
      this.db.prepare("UPDATE warehouse_packages SET current_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(location.id, pkg.id);
      this.audit("WAREHOUSE_PACKAGE_MOVED", "warehouse_package", pkg.id, { from_location_id: pkg.current_location_id, to_location_code: location.code }, actor);
      return { placement: this.db.prepare("SELECT * FROM package_placements WHERE id = ?").get(placementId), package: this.getPackage(pkg.id), idempotent: false };
    })();
  }

  countPackage(packageCode: string, quantityValue: unknown, input: Record<string, unknown>, actor: WarehouseActor) {
    const quantity = Number(quantityValue);
    const idempotencyKey = clean(input.idempotency_key, 200);
    if (!Number.isFinite(quantity) || quantity < 0 || !idempotencyKey) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Geçerli sayım adedi ve idempotency_key zorunludur.");
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM warehouse_stock_counts WHERE idempotency_key = ?").get(idempotencyKey) as any;
      if (existing) return { count: existing, package: this.getPackage(existing.package_id), idempotent: true };
      const pkg = this.db.prepare("SELECT * FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
      if (!pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
      const delta = quantity - asNumber(pkg.remaining_quantity);
      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO warehouse_stock_counts (id, package_id, location_id, previous_quantity, counted_quantity, idempotency_key, actor_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, pkg.id, pkg.current_location_id, pkg.remaining_quantity, quantity, idempotencyKey, actor.id, clean(input.note, 1000) || null);
      const nextStatus = quantity === 0 ? "EMPTY" : quantity < asNumber(pkg.planned_quantity) ? "OPEN" : pkg.status;
      this.db.prepare("UPDATE warehouse_packages SET remaining_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(quantity, nextStatus, pkg.id);
      if (delta !== 0) {
        this.recordStockMovement(pkg, "COUNT_ADJUST", delta, "stock_count", id, `count:${idempotencyKey}`, actor);
        this.db.prepare("UPDATE products SET central_stock = MAX(0, COALESCE(central_stock, 0) + ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(delta, pkg.product_id);
        this.db.prepare("INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type) VALUES (?, ?, 'WAREHOUSE', ?, ?, 'ADJUST')")
          .run(randomUUID(), pkg.product_id, delta, `Paket sayımı: ${pkg.package_code}`);
      }
      this.audit("WAREHOUSE_PACKAGE_COUNTED", "warehouse_package", pkg.id, { previous_quantity: pkg.remaining_quantity, counted_quantity: quantity, delta }, actor);
      return { count: this.db.prepare("SELECT * FROM warehouse_stock_counts WHERE id = ?").get(id), package: this.getPackage(pkg.id), idempotent: false };
    })();
  }

  listTemplates(type = "PACKAGE") {
    this.ensureDefaultTemplate();
    return (this.db.prepare("SELECT * FROM label_templates WHERE template_type = ? ORDER BY is_default DESC, name COLLATE NOCASE").all(type) as any[])
      .map((row) => ({ ...row, template: JSON.parse(row.template_json) }));
  }

  saveTemplate(input: Record<string, unknown>, actor: WarehouseActor) {
    const name = clean(input.name, 160);
    const template = input.template;
    if (!name || !template || typeof template !== "object") throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Şablon adı ve JSON içeriği zorunludur.");
    const templateObject = template as Record<string, unknown>;
    const elements = templateObject.elements;
    if (!Number.isFinite(Number(templateObject.width)) || !Number.isFinite(Number(templateObject.height)) ||
        Number(templateObject.width) < 20 || Number(templateObject.width) > 300 ||
        Number(templateObject.height) < 20 || Number(templateObject.height) > 300 ||
        !Array.isArray(elements) || elements.length < 1 || elements.length > 100) {
      throw new WarehouseServiceError(400, "INVALID_TEMPLATE", "Şablon ölçüleri 20–300 mm ve öğe sayısı 1–100 aralığında olmalıdır.");
    }
    const allowedElementTypes = new Set(["text", "barcode", "qr", "line", "box", "logo"]);
    if (elements.some((element) => !element || typeof element !== "object" || !allowedElementTypes.has(String((element as any).type)))) {
      throw new WarehouseServiceError(400, "INVALID_TEMPLATE", "Şablonda desteklenmeyen öğe türü var.");
    }
    const id = clean(input.id, 100) || randomUUID();
    this.db.transaction(() => {
      if (input.is_default === true) this.db.prepare("UPDATE label_templates SET is_default = 0 WHERE template_type = 'PACKAGE'").run();
      this.db.prepare(`
        INSERT INTO label_templates (id, name, template_type, version, template_json, active, is_default, created_by)
        VALUES (?, ?, 'PACKAGE', 1, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = label_templates.version + 1,
          template_json = excluded.template_json, is_default = excluded.is_default, updated_at = CURRENT_TIMESTAMP
      `).run(id, name, JSON.stringify(template), input.is_default === true ? 1 : 0, actor.id);
      this.audit("WAREHOUSE_LABEL_TEMPLATE_SAVED", "label_template", id, { name }, actor);
    })();
    return this.listTemplates().find((item: any) => item.id === id);
  }

  private nextBatchNumber() {
    const value = this.nextSequence("inbound_batch");
    const date = new Date();
    const stamp = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return `INB-${stamp}-${String(value).padStart(5, "0")}`;
  }

  private nextPackageCode() {
    const value = this.nextSequence("warehouse_package");
    const date = new Date();
    const stamp = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    return `PKG-${stamp}-${String(value).padStart(6, "0")}`;
  }

  private nextSequence(key: string) {
    this.db.prepare("INSERT OR IGNORE INTO warehouse_sequences (sequence_key, next_value) VALUES (?, 1)").run(key);
    const row = this.db.prepare("SELECT next_value FROM warehouse_sequences WHERE sequence_key = ?").get(key) as any;
    this.db.prepare("UPDATE warehouse_sequences SET next_value = next_value + 1, updated_at = CURRENT_TIMESTAMP WHERE sequence_key = ?").run(key);
    return Number(row.next_value);
  }

  private importHash(batchId: string, rows: NormalizedImportRow[]) {
    return createHash("sha256").update(JSON.stringify({ batchId, rows })).digest("hex");
  }

  private recordStockMovement(pkg: any, type: string, delta: number, referenceType: string, referenceId: string, idempotencyKey: string, actor: WarehouseActor) {
    this.db.prepare(`
      INSERT INTO warehouse_package_movements (
        id, package_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key, actor_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), pkg.id, pkg.product_id, type, delta, referenceType, referenceId, idempotencyKey, actor.id);
  }

  private refreshBatchStatus(batchId: string) {
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('PLACED','OPEN','EMPTY','MISSING','DAMAGED','QUARANTINED','CANCELLED') THEN 1 ELSE 0 END) AS accounted,
        SUM(CASE WHEN status IN ('PLACED','OPEN','EMPTY') THEN 1 ELSE 0 END) AS placed
      FROM warehouse_packages WHERE batch_id = ?
    `).get(batchId) as any;
    const complete = Number(counts.total) > 0 && Number(counts.accounted) === Number(counts.total);
    this.db.prepare(`
      UPDATE inbound_batches SET status = ?, completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'CANCELLED'
    `).run(complete ? "COMPLETED" : Number(counts.placed) > 0 ? "PLACING" : "RECEIVING", complete ? 1 : 0, batchId);
  }

  private audit(action: string, entityType: string, entityId: string, details: unknown, actor: WarehouseActor) {
    this.writeActivity(action, entityType, entityId, { ...(details as Record<string, unknown>), source: "warehouse_admin" }, actor.id);
  }
}

import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { WarehouseServiceError, type WarehousePicker } from "./warehouseService.js";
import { layoutLocationCodes, parseLegacyWarehouseLayout, type WarehouseLayout } from "./warehouseLayout.js";

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
    { id: "supplier", type: "text", x: 7, y: 46, width: 70, height: 6, value: "TEDARIK: {Supplier_no}", fontSize: 3.5, fontWeight: "bold" },
    { id: "size-weight", type: "text", x: 79, y: 46, width: 63, height: 6, value: "{Olcu} · {Kutu_agirligi} kg", fontSize: 3.5, textAlign: "right" },
    { id: "count", type: "text", x: 7, y: 53, width: 60, height: 8, value: "ADET: {Paket_ici_adet}", fontSize: 5, fontWeight: "black" },
    { id: "ordinal", type: "text", x: 76, y: 53, width: 66, height: 8, value: "PAKET {Paket_no}/{Toplam_paket}", fontSize: 5, fontWeight: "black", textAlign: "right" },
    { id: "package-barcode", type: "barcode", x: 7, y: 64, width: 96, height: 27, value: "{Package_code}", showBarcodeText: true },
    { id: "package-qr", type: "qr", x: 113, y: 64, width: 27, height: 27, value: "{Package_code}" },
  ],
};

const asNumber = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};

const clean = (value: unknown, max = 250) => String(value ?? "").trim().slice(0, max);
export const normalizeWarehouseLocationCode = (value: unknown) => clean(value, 100).toUpperCase().replace(/\s+/g, "");
export const isValidWarehouseLocationCode = (value: unknown) => /^[A-Z]+\d+-K\d+-P\d+$/.test(normalizeWarehouseLocationCode(value));
const RECEIVING_ACTIVE_STATUSES = ["CLAIMED", "LABEL_QUEUED", "LABELED", "PRINT_FAILED"];
const hasActorPermission = (actor: WarehouseActor, permission: string) => {
  if (actor.role === "admin" || actor.permissions?.[permission] === true) return true;
  const warehouse = actor.permissions?.warehouse;
  return Boolean(warehouse && typeof warehouse === "object" && (warehouse as Record<string, unknown>)[permission.replace("warehouse:", "")] === true);
};
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
    const existing = this.db.prepare("SELECT id, version, template_json FROM label_templates WHERE template_type = 'PACKAGE' AND is_default = 1 AND active = 1").get() as any;
    if (existing) {
      if (existing.id === DEFAULT_PACKAGE_LABEL_TEMPLATE.id && Number(existing.version) === 1 && !String(existing.template_json || "").includes("{Supplier_no}")) {
        this.db.prepare("UPDATE label_templates SET template_json = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(JSON.stringify(DEFAULT_PACKAGE_LABEL_TEMPLATE), existing.id);
      }
      return existing.id as string;
    }
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

  getLot(lotNumberValue: string) {
    const lotNumber = clean(lotNumberValue, 150);
    if (!lotNumber) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Parti/Lot zorunludur.");
    const sourceLines = this.db.prepare(`
      SELECT ll.*, p.sku, p.name_tr, p.name_en, p.title, p.material, p.product_series,
             p.model, p.form_code, p.size, p.weight_grams, p.central_stock, p.warehouse_location,
             (SELECT pi.path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.id LIMIT 1) AS image_path
      FROM inbound_lot_lines ll
      JOIN products p ON p.id = ll.product_id
      WHERE ll.lot_number = ? COLLATE NOCASE AND COALESCE(p.status, 'Active') != 'deleted'
      ORDER BY p.sku COLLATE NOCASE
    `).all(lotNumber) as any[];
    if (!sourceLines.length) throw new WarehouseServiceError(404, "LOT_NOT_FOUND", "Bu parti/lot Panel master verisinde bulunamadı.");
    const reserveStatement = this.db.prepare("SELECT location FROM product_reserve_locations WHERE product_id = ? ORDER BY sort_order, created_at, id");
    const lines = sourceLines.map((line) => ({
      ...line,
      reserve_locations: (reserveStatement.all(line.product_id) as Array<{ location: string }>).map((item) => item.location),
    }));
    return {
      lot_number: lotNumber,
      lines,
      totals: lines.reduce((sum, line) => ({
        sku_count: sum.sku_count + 1,
        package_count: sum.package_count + Number(line.package_count),
        unit_count: sum.unit_count + Number(line.total_units),
        weight_kg: sum.weight_kg + Number(line.total_weight_kg || 0),
      }), { sku_count: 0, package_count: 0, unit_count: 0, weight_kg: 0 }),
    };
  }

  startReceivingSession(lotNumberValue: string, actor: WarehouseActor, deviceId?: string) {
    const lot = this.getLot(lotNumberValue) as any;
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id, receiving_state FROM inbound_batches WHERE lot_number = ? COLLATE NOCASE").get(lot.lot_number) as any;
      if (existing) {
        if (existing.receiving_state === "completed" || existing.receiving_state === "cancelled") {
          throw new WarehouseServiceError(409, "SESSION_CLOSED", "Bu parti için tamamlanmış veya iptal edilmiş bir mal kabul bulunuyor.");
        }
        this.sessionEvent(existing.id, null, "SESSION_JOINED", actor, deviceId);
        this.audit("WAREHOUSE_RECEIVING_SESSION_JOINED", "inbound_batch", existing.id, { lot_number: lot.lot_number }, actor);
        return { ...this.getReceivingSession(existing.id), resumed: true };
      }

      const id = randomUUID();
      const batchNumber = this.nextBatchNumber();
      this.db.prepare(`
        INSERT INTO inbound_batches (
          id, batch_number, supplier_code, supplier_name, status, expected_package_count,
          expected_unit_count, created_by, lot_number, receiving_state, started_by, started_at
        ) VALUES (?, ?, 'MULTI', 'Panel Lot Master', 'READY', ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
      `).run(id, batchNumber, lot.totals.package_count, lot.totals.unit_count, actor.id, lot.lot_number, actor.id);

      const templateId = this.ensureDefaultTemplate(actor.id);
      const insertLine = this.db.prepare(`
        INSERT INTO inbound_batch_lines (
          id, batch_id, line_number, supplier_code, product_id, sku_snapshot, product_name_snapshot,
          lot_number, expected_package_count, units_per_package, last_package_units, total_units,
          supplier_no_snapshot, name_tr_snapshot, name_en_snapshot, material_snapshot, series_snapshot,
          model_snapshot, form_snapshot, size_snapshot, unit_weight_g_snapshot,
          package_weight_kg_snapshot, total_weight_kg_snapshot, image_path_snapshot,
          planned_location_snapshot, reserve_locations_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertPackage = this.db.prepare(`
        INSERT INTO warehouse_packages (
          id, package_code, batch_id, batch_line_id, product_id, supplier_code,
          package_number, total_packages, planned_quantity, remaining_quantity, status, label_template_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXPECTED', ?)
      `);
      lot.lines.forEach((source: any, index: number) => {
        const plannedLocation = this.syncReceivingLocation(source.warehouse_location, actor, true);
        const reserveLocations = [...new Set((source.reserve_locations || [])
          .map((value: unknown) => this.syncReceivingLocation(value, actor, false))
          .filter(Boolean))];
        const lineId = randomUUID();
        const lastPackageUnits = Number(source.total_units) - (Number(source.package_count) - 1) * Number(source.units_per_package);
        insertLine.run(
          lineId, id, index + 1, source.supplier_code, source.product_id, source.sku,
          source.name_tr || source.title || source.name_en || source.sku, lot.lot_number,
          source.package_count, source.units_per_package, lastPackageUnits, source.total_units,
          source.supplier_code, source.name_tr, source.name_en, source.material, source.product_series,
          source.model, source.form_code, source.size, source.weight_grams || 0,
          source.package_weight_kg || 0, source.total_weight_kg || 0, source.image_path,
          plannedLocation, JSON.stringify(reserveLocations),
        );
        for (let packageNumber = 1; packageNumber <= Number(source.package_count); packageNumber += 1) {
          const quantity = packageNumber === Number(source.package_count) ? lastPackageUnits : Number(source.units_per_package);
          insertPackage.run(randomUUID(), this.nextPackageCode(), id, lineId, source.product_id, source.supplier_code,
            packageNumber, source.package_count, quantity, quantity, templateId);
        }
      });
      this.sessionEvent(id, null, "SESSION_STARTED", actor, deviceId, { lot_number: lot.lot_number });
      this.audit("WAREHOUSE_RECEIVING_SESSION_STARTED", "inbound_batch", id, { lot_number: lot.lot_number }, actor);
      return { ...this.getReceivingSession(id), resumed: false };
    }).immediate();
  }

  listReceivingSessions() {
    return this.db.prepare(`
      SELECT b.id, b.batch_number, b.lot_number, b.receiving_state, b.status, b.started_at,
             b.completed_at, b.expected_package_count, b.expected_unit_count,
             (SELECT COUNT(*) FROM inbound_batch_lines line_count WHERE line_count.batch_id = b.id) AS sku_count,
             (SELECT COUNT(*) FROM warehouse_packages package_count WHERE package_count.batch_id = b.id AND package_count.status IN ('PLACED','OPEN','EMPTY')) AS placed_count,
             COALESCE((SELECT SUM(weight_line.total_weight_kg_snapshot) FROM inbound_batch_lines weight_line WHERE weight_line.batch_id = b.id), 0) AS total_weight_kg,
             (SELECT GROUP_CONCAT(DISTINCT COALESCE(event_user.username, event.actor_username))
                FROM inbound_session_events event LEFT JOIN users event_user ON event_user.id = event.actor_id
               WHERE event.batch_id = b.id) AS actor_names
      FROM inbound_batches b
      WHERE b.lot_number IS NOT NULL
      ORDER BY CASE b.receiving_state WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
               datetime(COALESCE(b.started_at, b.created_at)) DESC
    `).all();
  }

  getReceivingSession(id: string, options: { includeAdminDetail?: boolean } = { includeAdminDetail: true }) {
    const batch = this.db.prepare(`
      SELECT b.*, u.username AS started_by_name
      FROM inbound_batches b LEFT JOIN users u ON u.id = b.started_by
      WHERE b.id = ? AND b.lot_number IS NOT NULL
    `).get(id) as any;
    if (!batch) throw new WarehouseServiceError(404, "SESSION_NOT_FOUND", "Mal kabul oturumu bulunamadı.");
    const lines = this.db.prepare(`
      SELECT l.*,
        SUM(CASE WHEN p.status IN ('PLACED','OPEN','EMPTY') THEN 1 ELSE 0 END) AS completed_packages,
        SUM(CASE WHEN p.status IN ('PLACED','OPEN','EMPTY') THEN p.planned_quantity ELSE 0 END) AS received_quantity
      FROM inbound_batch_lines l LEFT JOIN warehouse_packages p ON p.batch_line_id = l.id
      WHERE l.batch_id = ? GROUP BY l.id ORDER BY l.line_number
    `).all(id) as any[];
    const placed = lines.reduce((sum, line) => sum + Number(line.completed_packages || 0), 0);
    const events = this.db.prepare(`
      SELECT e.*, p.package_code, p.package_number, p.total_packages,
             l.sku_snapshot, l.product_name_snapshot, loc.code AS location_code
      FROM inbound_session_events e
      LEFT JOIN warehouse_packages p ON p.id = e.package_id
      LEFT JOIN inbound_batch_lines l ON l.id = p.batch_line_id
      LEFT JOIN warehouse_locations loc ON loc.id = p.current_location_id
      WHERE e.batch_id = ? ORDER BY datetime(e.created_at) DESC, e.id DESC LIMIT 250
    `).all(id);
    const supplierCodes = [...new Set(lines.map((line) => clean(line.supplier_code, 100)).filter(Boolean))];
    const activePackages = options.includeAdminDetail ? this.db.prepare(`
      SELECT p.id FROM warehouse_packages p
      WHERE p.batch_id = ? AND p.claimed_by IS NOT NULL
        AND p.status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED')
      ORDER BY datetime(COALESCE(p.receiving_last_activity_at, p.updated_at)) DESC
    `).all(id).map((row: any) => this.getPackage(row.id)) : [];
    return {
      ...batch,
      lines: options.includeAdminDetail ? lines : [],
      supplier_codes: supplierCodes,
      active_packages: activePackages,
      events: (events as any[]).filter((event) => event.event_type !== "SESSION_JOINED"),
      progress: {
        sku_count: lines.length,
        total_packages: Number(batch.expected_package_count),
        placed_packages: placed,
        remaining_packages: Math.max(0, Number(batch.expected_package_count) - placed),
        percent: Number(batch.expected_package_count) ? Math.round(placed / Number(batch.expected_package_count) * 100) : 0,
      },
    };
  }

  getMyActiveReceivingPackage(actor: WarehouseActor, sessionIdValue?: string) {
    const sessionId = clean(sessionIdValue, 100);
    const row = this.db.prepare(`
      SELECT p.id
      FROM warehouse_packages p
      JOIN inbound_batches b ON b.id = p.batch_id
      WHERE p.claimed_by = ?
        AND p.status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED')
        AND b.lot_number IS NOT NULL
        AND b.receiving_state NOT IN ('completed','cancelled')
        AND (? = '' OR p.batch_id = ?)
      ORDER BY datetime(COALESCE(p.receiving_last_activity_at, p.updated_at)) DESC, p.id DESC
      LIMIT 1
    `).get(actor.id, sessionId, sessionId) as any;
    return row ? this.getPackage(row.id) : null;
  }

  listMyReceivingPackages(sessionIdValue: string, actor: WarehouseActor) {
    const sessionId = clean(sessionIdValue, 100);
    this.getReceivingSession(sessionId, { includeAdminDetail: false });
    return this.db.prepare(`
      SELECT p.id AS package_id, p.package_code, p.product_id, l.sku_snapshot AS sku,
             l.product_name_snapshot AS product_name, l.supplier_no_snapshot AS supplier_no,
             b.lot_number, p.package_number, p.total_packages, p.planned_quantity AS quantity,
             l.package_weight_kg_snapshot AS package_weight_kg, l.image_path_snapshot,
             loc.code AS location_code, p.placed_at,
             COALESCE(p.placed_by_username, u.username) AS placed_by_username,
             '/api/products/' || p.product_id || '/image' AS image_url
      FROM warehouse_packages p
      JOIN inbound_batches b ON b.id = p.batch_id
      JOIN inbound_batch_lines l ON l.id = p.batch_line_id
      LEFT JOIN warehouse_locations loc ON loc.id = p.current_location_id
      LEFT JOIN users u ON u.id = p.placed_by_user_id
      WHERE p.batch_id = ? AND p.placed_by_user_id = ?
        AND p.status IN ('PLACED','OPEN','EMPTY')
      ORDER BY datetime(p.placed_at) DESC, p.id DESC
    `).all(sessionId, actor.id);
  }

  setReceivingState(id: string, state: "active" | "paused" | "cancelled", actor: WarehouseActor, deviceId?: string) {
    const session = this.getReceivingSession(id) as any;
    if (session.receiving_state === "completed" || session.receiving_state === "cancelled") {
      throw new WarehouseServiceError(409, "SESSION_CLOSED", "Tamamlanmış veya iptal edilmiş mal kabul tekrar açılamaz.");
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE inbound_batches SET receiving_state = ?,
        paused_at = CASE WHEN ? = 'paused' THEN CURRENT_TIMESTAMP ELSE paused_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
        status = CASE WHEN ? = 'cancelled' THEN 'CANCELLED' ELSE status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(state, state, state, state, id);
      if (state === "cancelled") {
        this.db.prepare(`UPDATE warehouse_packages SET claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
          receiving_device_id = NULL, receiving_last_activity_at = CURRENT_TIMESTAMP,
          receiving_location_reserved_at = NULL, recommended_location_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE batch_id = ? AND status NOT IN ('PLACED','OPEN','EMPTY')`).run(id);
      }
      this.sessionEvent(id, null, `SESSION_${state.toUpperCase()}`, actor, deviceId);
      this.audit(`WAREHOUSE_RECEIVING_SESSION_${state.toUpperCase()}`, "inbound_batch", id, {}, actor);
    })();
    return this.getReceivingSession(id);
  }

  completeReceivingSession(id: string, forceReasonValue: unknown, actor: WarehouseActor, deviceId?: string) {
    const session = this.getReceivingSession(id) as any;
    if (session.receiving_state === "completed") return { ...session, idempotent: true };
    if (session.receiving_state === "cancelled") throw new WarehouseServiceError(409, "SESSION_CLOSED", "İptal edilmiş mal kabul tamamlanamaz.");
    const remaining = Number(session.progress.remaining_packages);
    const forceReason = clean(forceReasonValue, 1000);
    if (remaining > 0 && !forceReason) {
      throw new WarehouseServiceError(409, "PACKAGES_REMAINING", `${remaining} paket henüz yerleştirilmedi.`);
    }
    this.db.prepare(`UPDATE inbound_batches SET receiving_state='completed', status='COMPLETED', completed_at=CURRENT_TIMESTAMP,
      force_completed_by=?, force_complete_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(remaining > 0 ? actor.id : null, remaining > 0 ? forceReason : null, id);
    if (remaining > 0) {
      this.db.prepare(`UPDATE warehouse_packages SET claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
        receiving_device_id = NULL, receiving_last_activity_at = CURRENT_TIMESTAMP,
        receiving_location_reserved_at = NULL, recommended_location_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE batch_id = ? AND status NOT IN ('PLACED','OPEN','EMPTY')`).run(id);
    }
    this.sessionEvent(id, null, remaining > 0 ? "SESSION_FORCE_COMPLETED" : "SESSION_COMPLETED", actor, deviceId, { remaining_packages: remaining, reason: forceReason || null });
    this.audit(remaining > 0 ? "WAREHOUSE_RECEIVING_FORCE_COMPLETED" : "WAREHOUSE_RECEIVING_COMPLETED", "inbound_batch", id, { remaining_packages: remaining, reason: forceReason || null }, actor);
    return { ...this.getReceivingSession(id), idempotent: false };
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

  claimNextPackage(supplierCode: string, actor: WarehouseActor, sessionIdValue?: string, deviceId?: string) {
    const code = clean(supplierCode, 100);
    const sessionId = clean(sessionIdValue, 100) || null;
    if (!code) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Tedarikçi kodu zorunludur.");
    if (sessionId) {
      const session = this.getReceivingSession(sessionId) as any;
      if (session.receiving_state !== "active") throw new WarehouseServiceError(409, "SESSION_NOT_ACTIVE", "Mal kabul oturumu aktif değil.");
      const supplierInSession = Boolean(this.db.prepare("SELECT 1 FROM inbound_batch_lines WHERE batch_id = ? AND supplier_code = ? COLLATE NOCASE LIMIT 1").get(sessionId, code));
      if (!supplierInSession) throw new WarehouseServiceError(404, "PRODUCT_NOT_IN_ACTIVE_LOT", "Bu ürün aktif partide bulunamadı.");
    }
    return this.db.transaction(() => {
      if (sessionId) {
        const activePackage = this.getMyActiveReceivingPackage(actor) as any;
        if (activePackage) {
          const target = activePackage.recommended_location_code ? ` ${activePackage.recommended_location_code} rafına` : "";
          throw new WarehouseServiceError(409, "ACTIVE_PACKAGE_EXISTS",
            `${activePackage.sku_snapshot} ${activePackage.package_number}/${activePackage.total_packages} paketini önce${target} yerleştirin.`);
        }
      }
      const candidate = sessionId ? this.db.prepare(`
        SELECT p.id
        FROM warehouse_packages p
        JOIN inbound_batches b ON b.id = p.batch_id
        JOIN inbound_batch_lines l ON l.id = p.batch_line_id
        WHERE p.batch_id = ? AND l.supplier_code = ? COLLATE NOCASE
          AND b.status NOT IN ('COMPLETED','CANCELLED') AND b.receiving_state = 'active'
          AND (p.status = 'EXPECTED' OR (
            p.status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED') AND p.claimed_by IS NULL
          ))
        ORDER BY CASE WHEN p.status = 'EXPECTED' THEN 1 ELSE 0 END,
                 l.line_number, p.package_number
        LIMIT 1
      `).get(sessionId, code) as any : this.db.prepare(`
        SELECT p.id
        FROM warehouse_packages p
        JOIN inbound_batches b ON b.id = p.batch_id
        JOIN inbound_batch_lines l ON l.id = p.batch_line_id
        WHERE p.supplier_code = ? COLLATE NOCASE
          AND b.status NOT IN ('COMPLETED','CANCELLED')
          AND COALESCE(b.receiving_state, 'active') = 'active'
          AND (p.status = 'EXPECTED' OR (p.status = 'CLAIMED' AND datetime(p.claim_expires_at) <= datetime('now')))
        ORDER BY datetime(b.created_at), l.line_number, p.package_number
        LIMIT 1
      `).get(code) as any;
      if (!candidate) throw new WarehouseServiceError(404, "NO_PACKAGE_AVAILABLE", sessionId ? "Bu ürün için aktif partide bekleyen paket yok." : "Bu tedarikçi kodu için bekleyen paket yok.");
      const claimToken = randomUUID();
      const result = sessionId ? this.db.prepare(`
        UPDATE warehouse_packages
        SET status = CASE WHEN status = 'EXPECTED' THEN 'CLAIMED' ELSE status END,
            claim_token = ?, claimed_by = ?, claim_expires_at = NULL,
            receiving_device_id = ?, receiving_work_started_at = COALESCE(receiving_work_started_at, CURRENT_TIMESTAMP),
            receiving_last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (status = 'EXPECTED' OR (
          status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED') AND claimed_by IS NULL
        ))
      `).run(claimToken, actor.id, clean(deviceId, 150) || null, candidate.id) : this.db.prepare(`
        UPDATE warehouse_packages
        SET status = 'CLAIMED', claim_token = ?, claimed_by = ?,
            claim_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND (status = 'EXPECTED' OR (status = 'CLAIMED' AND datetime(claim_expires_at) <= datetime('now')))
      `).run(claimToken, actor.id, `+${this.claimLeaseSeconds} seconds`, candidate.id);
      if (result.changes !== 1) throw new WarehouseServiceError(409, "PACKAGE_ALREADY_CLAIMED", "Paket başka bir kullanıcı tarafından alındı; yeniden okutun.");
      this.db.prepare("UPDATE inbound_batches SET status = 'RECEIVING', updated_at = CURRENT_TIMESTAMP WHERE id = (SELECT batch_id FROM warehouse_packages WHERE id = ?) AND status = 'READY'").run(candidate.id);
      const claimed = this.getPackage(candidate.id) as any;
      this.sessionEvent(claimed.batch_id, claimed.id, "PACKAGE_CLAIMED", actor, deviceId, { supplier_code: code });
      this.audit("WAREHOUSE_PACKAGE_CLAIMED", "warehouse_package", candidate.id, { claim_seconds: sessionId ? null : this.claimLeaseSeconds, persistent_receiving_work: Boolean(sessionId) }, actor);
      return claimed;
    }).immediate();
  }

  getPackageByCode(packageCode: string) {
    const row = this.db.prepare("SELECT id FROM warehouse_packages WHERE package_code = ? COLLATE NOCASE").get(clean(packageCode, 100)) as any;
    if (!row) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
    return this.getPackage(row.id);
  }

  getPackage(id: string) {
    const pkg = this.db.prepare(`
      SELECT p.*, b.batch_number, b.lot_number AS session_lot_number, l.line_number, l.sku_snapshot, l.product_name_snapshot, l.lot_number,
             l.units_per_package, l.supplier_no_snapshot, l.name_tr_snapshot, l.name_en_snapshot,
             l.material_snapshot, l.series_snapshot, l.model_snapshot, l.form_snapshot, l.size_snapshot,
             l.unit_weight_g_snapshot, l.package_weight_kg_snapshot, l.total_weight_kg_snapshot,
             l.image_path_snapshot, loc.code AS location_code, recommended.code AS recommended_location_code,
             t.name AS template_name, t.template_json
      FROM warehouse_packages p
      JOIN inbound_batches b ON b.id = p.batch_id
      JOIN inbound_batch_lines l ON l.id = p.batch_line_id
      LEFT JOIN warehouse_locations loc ON loc.id = p.current_location_id
      LEFT JOIN warehouse_locations recommended ON recommended.id = p.recommended_location_id
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
      const receivingSession = this.db.prepare("SELECT lot_number FROM inbound_batches WHERE id = ?").get(pkg.batch_id) as any;
      const persistentReceivingWork = Boolean(receivingSession?.lot_number) && RECEIVING_ACTIVE_STATUSES.includes(pkg.status);
      if (persistentReceivingWork && pkg.claimed_by !== actor.id) {
        throw new WarehouseServiceError(409, "PACKAGE_OWNED_BY_ANOTHER_USER", "Bu paket başka bir kullanıcının devam eden mal kabul işidir.");
      }
      const reprint = ["LABELED", "PLACED", "OPEN", "EMPTY", "PRINT_FAILED"].includes(pkg.status);
      if (!reprint) {
        const expired = !persistentReceivingWork && new Date(`${pkg.claim_expires_at}Z`).getTime() <= Date.now();
        if (pkg.status !== "CLAIMED" || pkg.claimed_by !== actor.id || pkg.claim_token !== clean(input.claim_token, 100) || expired) {
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
          claim_expires_at = NULL, receiving_last_activity_at = CASE WHEN claimed_by IS NOT NULL THEN CURRENT_TIMESTAMP ELSE receiving_last_activity_at END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(templateId, packageId);
      this.sessionEvent(pkg.batch_id, pkg.id, reprint ? "LABEL_REPRINT_QUEUED" : "LABEL_QUEUED", actor, clean(input.device_id, 150), { job_id: jobId });
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
    const code = normalizeWarehouseLocationCode(input.code);
    const capacity = Math.trunc(asNumber(input.package_capacity) || 1);
    if (!code || capacity < 1) throw new WarehouseServiceError(400, "VALIDATION_ERROR", "Lokasyon kodu ve pozitif kapasite zorunludur.");
    if (this.findWarehouseLocation(code)) throw new WarehouseServiceError(409, "LOCATION_EXISTS", "Bu fiziksel lokasyon katalogda zaten bulunuyor.");
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
      SELECT l.*,
             COUNT(DISTINCT p.id) AS occupied_packages,
             COUNT(DISTINCT reservation.id) AS reserved_packages,
             MAX(0, l.package_capacity - COUNT(DISTINCT p.id) - COUNT(DISTINCT reservation.id)) AS available_capacity
      FROM warehouse_locations l
      LEFT JOIN warehouse_packages p ON p.current_location_id = l.id AND p.status IN ('PLACED','OPEN')
      LEFT JOIN warehouse_packages reservation ON reservation.recommended_location_id = l.id
        AND reservation.receiving_location_reserved_at IS NOT NULL
        AND reservation.current_location_id IS NULL
        AND reservation.status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED')
      GROUP BY l.id ORDER BY l.code COLLATE NOCASE
    `).all();
  }

  importLegacyLayout(input: unknown, actor: WarehouseActor) {
    let layout: WarehouseLayout;
    try { layout = parseLegacyWarehouseLayout(input); }
    catch (error) {
      throw new WarehouseServiceError(400, "INVALID_LAYOUT", error instanceof Error ? error.message : "Geçersiz depo planı.");
    }
    const duplicateRackCodes = layout.objects
      .filter((object) => object.type === "rack")
      .map((object) => object.rackCode!)
      .filter((code, index, codes) => codes.indexOf(code) !== index);
    if (duplicateRackCodes.length) {
      throw new WarehouseServiceError(400, "DUPLICATE_RACK_CODE", `Tekrarlanan rackCode: ${[...new Set(duplicateRackCodes)].join(", ")}`);
    }
    return this.db.transaction(() => {
      const current = this.db.prepare("SELECT layout_version FROM warehouse_layouts WHERE active = 1").get() as any;
      const id = randomUUID();
      const version = Number(current?.layout_version || 0) + 1;
      this.db.prepare("UPDATE warehouse_layouts SET active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE active = 1").run(actor.id);
      this.db.prepare(`INSERT INTO warehouse_layouts
        (id, name, layout_version, layout_json, active, created_by, updated_by)
        VALUES (?, ?, ?, ?, 1, ?, ?)`)
        .run(id, layout.warehouse.name, version, JSON.stringify(layout), actor.id, actor.id);
      this.audit("WAREHOUSE_LAYOUT_IMPORTED", "warehouse_layout", id, {
        layout_version: version,
        object_count: layout.objects.length,
        rack_count: layout.objects.filter((object) => object.type === "rack").length,
      }, actor);
      return { id, name: layout.warehouse.name, layout_version: version, active: 1, layout };
    })();
  }

  getWarehouseMap() {
    const layoutRow = this.db.prepare("SELECT id, name, layout_version, layout_json, updated_at FROM warehouse_layouts WHERE active = 1").get() as any;
    const layout = layoutRow ? JSON.parse(layoutRow.layout_json) as WarehouseLayout : null;
    const locations = this.listLocations() as any[];
    const packages = this.db.prepare(`
      SELECT p.id, p.package_code, p.status, p.package_number, p.total_packages,
             p.remaining_quantity AS quantity, p.placed_at, p.placed_by_username AS placed_by,
             l.code AS location_code, line.sku_snapshot AS sku,
             line.product_name_snapshot AS product_name,
             line.supplier_no_snapshot AS supplier_no, line.lot_number,
             line.package_weight_kg_snapshot AS weight,
             product.width_mm, product.length_mm AS depth_mm, product.height_mm,
             CASE WHEN line.image_path_snapshot IS NOT NULL THEN '/api/products/' || p.product_id || '/image' ELSE NULL END AS image_url
      FROM warehouse_packages p
      JOIN inbound_batch_lines line ON line.id = p.batch_line_id
      JOIN products product ON product.id = p.product_id
      LEFT JOIN warehouse_locations l ON l.id = p.current_location_id
      WHERE p.status IN ('PLACED','OPEN') AND p.current_location_id IS NOT NULL
      ORDER BY l.code COLLATE NOCASE, p.package_code COLLATE NOCASE
    `).all();
    const totalPackages = packages.length;
    const totalCapacity = locations.reduce((sum, location) => sum + Number(location.package_capacity || 0), 0);
    const occupiedCapacity = locations.reduce((sum, location) => sum + Number(location.occupied_packages || 0) + Number(location.reserved_packages || 0), 0);
    const layoutCodes = layout ? layoutLocationCodes(layout) : [];
    const layoutCodeSet = new Set(layoutCodes);
    const dbCodeSet = new Set(locations.map((location) => String(location.code)));
    const rackCodes = layout?.objects.filter((object) => object.type === "rack").map((object) => object.rackCode!) || [];
    return {
      warehouse: layoutRow ? {
        id: layoutRow.id,
        name: layoutRow.name,
        layout_version: layoutRow.layout_version,
        updated_at: layoutRow.updated_at,
        layout,
      } : null,
      stats: {
        total_packages: totalPackages,
        total_products: this.db.prepare("SELECT COALESCE(SUM(remaining_quantity), 0) AS count FROM warehouse_packages WHERE status IN ('PLACED','OPEN')").get()?.count || 0,
        total_locations: locations.length,
        occupied_locations: locations.filter((location) => Number(location.occupied_packages) > 0).length,
        empty_locations: locations.filter((location) => Number(location.occupied_packages) === 0 && Number(location.reserved_packages) === 0).length,
        reserved_packages: locations.reduce((sum, location) => sum + Number(location.reserved_packages || 0), 0),
        capacity_percent: totalCapacity ? Math.round((occupiedCapacity / totalCapacity) * 1000) / 10 : 0,
        active_receiving: Number((this.db.prepare("SELECT COUNT(*) AS count FROM inbound_batches WHERE receiving_state IN ('active','paused')").get() as any)?.count || 0),
        pending_picking: Number((this.db.prepare("SELECT COUNT(*) AS count FROM sales WHERE status IN ('Hazırlanıyor','Toplanıyor')").get() as any)?.count || 0),
        picked_today: Number((this.db.prepare("SELECT COUNT(*) AS count FROM pick_sessions WHERE date(completed_at, 'localtime') = date('now', 'localtime')").get() as any)?.count || 0),
        placed_today: Number((this.db.prepare("SELECT COUNT(*) AS count FROM warehouse_packages WHERE date(placed_at, 'localtime') = date('now', 'localtime')").get() as any)?.count || 0),
      },
      locations: locations.map((location) => ({
        id: location.id, code: location.code,
        rack_code: String(location.code).split("-K")[0],
        capacity: Number(location.package_capacity), occupied: Number(location.occupied_packages),
        reserved: Number(location.reserved_packages), available: Number(location.available_capacity),
      })),
      packages,
      data_quality: {
        layout_only_locations: layoutCodes.filter((code) => !dbCodeSet.has(code)),
        map_missing_locations: locations.map((location) => String(location.code)).filter((code) => !layoutCodeSet.has(code)),
        duplicate_rack_codes: rackCodes.filter((code, index) => rackCodes.indexOf(code) !== index),
        invalid_location_codes: locations.map((location) => String(location.code)).filter((code) => !isValidWarehouseLocationCode(code)),
      },
    };
  }

  listPackages(filters: { page: number; limit: number; query?: string; status?: string; location?: string; lot?: string }) {
    const where = ["1 = 1"];
    const params: unknown[] = [];
    if (filters.query) {
      where.push("(p.package_code LIKE ? OR line.sku_snapshot LIKE ? OR line.product_name_snapshot LIKE ? OR line.supplier_no_snapshot LIKE ?)");
      params.push(...Array(4).fill(`%${filters.query}%`));
    }
    if (filters.status) { where.push("p.status = ?"); params.push(filters.status); }
    if (filters.location) { where.push("location.code LIKE ?"); params.push(`%${filters.location}%`); }
    if (filters.lot) { where.push("line.lot_number LIKE ?"); params.push(`%${filters.lot}%`); }
    const sqlWhere = where.join(" AND ");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM warehouse_packages p JOIN inbound_batch_lines line ON line.id=p.batch_line_id LEFT JOIN warehouse_locations location ON location.id=p.current_location_id WHERE ${sqlWhere}`).get(...params) as any).count);
    const data = this.db.prepare(`SELECT p.id, p.package_code, p.status, p.package_number, p.total_packages,
      p.remaining_quantity AS quantity, p.placed_at, line.sku_snapshot AS sku, line.product_name_snapshot AS product_name,
      line.lot_number, line.package_weight_kg_snapshot AS weight, location.code AS location_code
      FROM warehouse_packages p JOIN inbound_batch_lines line ON line.id=p.batch_line_id
      LEFT JOIN warehouse_locations location ON location.id=p.current_location_id
      WHERE ${sqlWhere} ORDER BY datetime(p.created_at) DESC LIMIT ? OFFSET ?`)
      .all(...params, filters.limit, (filters.page - 1) * filters.limit);
    return { data, pagination: { page: filters.page, limit: filters.limit, total, total_pages: Math.max(1, Math.ceil(total / filters.limit)) } };
  }

  listMovements(limit = 200) {
    return this.db.prepare(`SELECT placement.id, placement.action AS event_type, placement.created_at,
      package.package_code, line.sku_snapshot AS sku, line.product_name_snapshot AS product_name,
      from_location.code AS from_location, to_location.code AS to_location, user.username AS actor_username
      FROM package_placements placement
      JOIN warehouse_packages package ON package.id=placement.package_id
      JOIN inbound_batch_lines line ON line.id=package.batch_line_id
      LEFT JOIN warehouse_locations from_location ON from_location.id=placement.from_location_id
      LEFT JOIN warehouse_locations to_location ON to_location.id=placement.to_location_id
      LEFT JOIN users user ON user.id=placement.actor_id
      ORDER BY datetime(placement.created_at) DESC LIMIT ?`).all(Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  listUserActivity(limit = 200) {
    return this.db.prepare(`SELECT id, action AS event_type, entity_type, entity_id, details,
      actor_username, user_id, created_at
      FROM activity_logs
      WHERE action LIKE 'WAREHOUSE_%'
        AND action NOT IN ('WAREHOUSE_API_USED','WAREHOUSE_API_AUTH_FAILED','WAREHOUSE_PERMISSION_DENIED')
      ORDER BY datetime(created_at) DESC LIMIT ?`).all(Math.max(1, Math.min(500, Math.trunc(limit))));
  }

  suggestLocation(packageIdValue?: string) {
    const packageId = clean(packageIdValue, 100);
    const pkg = packageId ? this.db.prepare("SELECT * FROM warehouse_packages WHERE id = ?").get(packageId) as any : null;
    if (packageId && !pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
    const row = this.db.prepare(`
      SELECT l.*, COUNT(p.id) AS occupied_packages,
             l.package_capacity - COUNT(p.id) AS available_capacity,
             SUM(CASE WHEN p.product_id = ? AND p.status IN ('PLACED','OPEN') THEN 1 ELSE 0 END) AS same_sku_packages
      FROM warehouse_locations l
      LEFT JOIN warehouse_packages p ON p.current_location_id = l.id AND p.status IN ('PLACED','OPEN')
      WHERE l.active = 1
      GROUP BY l.id HAVING COUNT(p.id) < l.package_capacity
      ORDER BY CASE WHEN SUM(CASE WHEN p.product_id = ? AND p.status IN ('PLACED','OPEN') THEN 1 ELSE 0 END) > 0 THEN 0 ELSE 1 END,
               CASE WHEN EXISTS (SELECT 1 FROM products preferred WHERE preferred.id = ? AND preferred.warehouse_location = l.code COLLATE NOCASE)
                          OR EXISTS (SELECT 1 FROM product_reserve_locations reserve WHERE reserve.product_id = ? AND reserve.location = l.code COLLATE NOCASE)
                    THEN 0 ELSE 1 END,
               same_sku_packages DESC, COUNT(p.id), l.code COLLATE NOCASE LIMIT 1
    `).get(pkg?.product_id || "", pkg?.product_id || "", pkg?.product_id || "", pkg?.product_id || "") as any;
    if (!row) throw new WarehouseServiceError(409, "NO_LOCATION_CAPACITY", "Kullanılabilir lokasyon kapasitesi yok.");
    if (pkg) {
      this.db.prepare("UPDATE warehouse_packages SET recommended_location_id = ?, recommended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(row.id, pkg.id);
    }
    return row;
  }

  getReceivingLocation(packageIdValue: string, actor?: WarehouseActor) {
    const packageId = clean(packageIdValue, 100);
    return this.db.transaction(() => {
      const pkg = this.db.prepare(`
        SELECT p.id, p.status, p.claimed_by, p.recommended_location_id, l.planned_location_snapshot,
               l.reserve_locations_snapshot, b.lot_number
        FROM warehouse_packages p
        JOIN inbound_batch_lines l ON l.id = p.batch_line_id
        JOIN inbound_batches b ON b.id = p.batch_id
        WHERE p.id = ?
      `).get(packageId) as any;
      if (!pkg) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Paket bulunamadı.");
      if (!pkg.lot_number) return this.suggestLocation(packageId);
      if (actor && pkg.claimed_by && pkg.claimed_by !== actor.id && !hasActorPermission(actor, "warehouse:manage_receiving_sessions")) {
        throw new WarehouseServiceError(409, "PACKAGE_OWNED_BY_ANOTHER_USER", "Bu paket başka bir kullanıcının devam eden mal kabul işidir.");
      }
      if (pkg.status !== "LABELED") throw new WarehouseServiceError(409, "PACKAGE_NOT_LABELED", "Yerleştirme rafı etiket basıldıktan sonra yüklenir.");
      const plannedCode = normalizeWarehouseLocationCode(pkg.planned_location_snapshot);
      if (!plannedCode) throw new WarehouseServiceError(409, "PLANNED_LOCATION_MISSING", "Bu ürün için master veride planlanan lokasyon bulunmuyor.");
      if (!isValidWarehouseLocationCode(plannedCode) && !this.findWarehouseLocation(plannedCode)) {
        throw new WarehouseServiceError(409, "PLANNED_LOCATION_NOT_FOUND", `${plannedCode} planlanan rafı depo lokasyonlarında bulunamadı. Master ürün lokasyonunu kontrol edin.`);
      }
      let reserves: string[] = [];
      try {
        const parsed = JSON.parse(String(pkg.reserve_locations_snapshot || "[]"));
        if (Array.isArray(parsed)) reserves = parsed.map(normalizeWarehouseLocationCode).filter(Boolean);
      } catch { reserves = []; }
      const candidates = [plannedCode, ...reserves.filter((code) => code !== plannedCode)];
      for (const code of candidates) {
        if (!this.findWarehouseLocation(code) && actor && isValidWarehouseLocationCode(code)) {
          this.syncReceivingLocation(code, actor, code === plannedCode);
        }
        const location = this.findWarehouseLocation(code);
        if (!location || !location.active) {
          if (code === plannedCode) {
            throw new WarehouseServiceError(409, "PLANNED_LOCATION_NOT_FOUND", `${plannedCode} planlanan rafı depo lokasyonlarında bulunamadı. Master ürün lokasyonunu kontrol edin.`);
          }
          continue;
        }
        const usage = this.locationUsage(location.id, packageId);
        const reservation = this.db.prepare("SELECT receiving_location_reserved_at FROM warehouse_packages WHERE id = ?").get(packageId) as any;
        const alreadyReservedHere = pkg.recommended_location_id === location.id && Boolean(reservation?.receiving_location_reserved_at);
        if (!alreadyReservedHere && usage.occupied + usage.reserved >= Number(location.package_capacity)) continue;
        this.db.prepare(`UPDATE warehouse_packages SET recommended_location_id = ?, recommended_at = CURRENT_TIMESTAMP,
          receiving_location_reserved_at = COALESCE(receiving_location_reserved_at, CURRENT_TIMESTAMP),
          receiving_last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(location.id, packageId);
        const reservedAfter = usage.reserved + (alreadyReservedHere ? 0 : 1);
        return {
          ...location,
          occupied_packages: usage.occupied,
          reserved_packages: reservedAfter,
          available_capacity: Math.max(0, Number(location.package_capacity) - usage.occupied - reservedAfter),
          planned_location: plannedCode,
          using_reserve: code !== plannedCode,
        };
      }
      throw new WarehouseServiceError(409, "PLANNED_LOCATION_FULL", `${plannedCode} planlanan lokasyonu dolu. Uygun rezerv lokasyon bulunamadı.`);
    }).immediate();
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
      const location = this.findWarehouseLocation(locationCode);
      if (!location) throw new WarehouseServiceError(404, "LOCATION_NOT_FOUND", "Aktif lokasyon bulunamadı.");
      if (!location.active) throw new WarehouseServiceError(404, "LOCATION_NOT_FOUND", "Aktif lokasyon bulunamadı.");
      if (pkg.status !== "LABELED") throw new WarehouseServiceError(409, "PACKAGE_NOT_LABELED", "Yerleştirmeden önce paket etiketi başarıyla basılmalıdır.");
      const receivingSession = this.db.prepare("SELECT lot_number FROM inbound_batches WHERE id = ?").get(pkg.batch_id) as any;
      const overrideReason = clean(input.override_reason, 1000);
      if (receivingSession?.lot_number && pkg.claimed_by !== actor.id && !hasActorPermission(actor, "warehouse:manage_receiving_sessions")) {
        throw new WarehouseServiceError(409, "PACKAGE_OWNED_BY_ANOTHER_USER", "Bu paket başka bir kullanıcının devam eden mal kabul işidir.");
      }
      if (!pkg.recommended_location_id && !clean(input.override_reason, 1000)) {
        if (receivingSession?.lot_number) pkg.recommended_location_id = (this.getReceivingLocation(pkg.id, actor) as any).id;
      }
      if (pkg.recommended_location_id && pkg.recommended_location_id !== location.id && !overrideReason) {
        const recommended = this.db.prepare("SELECT code FROM warehouse_locations WHERE id = ?").get(pkg.recommended_location_id) as any;
        throw new WarehouseServiceError(409, "WRONG_LOCATION", `Yanlış lokasyon. Paketi ${recommended?.code || "önerilen lokasyona"} yerleştirin.`);
      }
      const usage = this.locationUsage(location.id, pkg.id);
      if (usage.occupied + usage.reserved >= Number(location.package_capacity)) throw new WarehouseServiceError(409, "LOCATION_FULL", "Lokasyon kapasitesi dolu.");
      const lowerPending = this.db.prepare(`
        SELECT package_code FROM warehouse_packages
        WHERE batch_line_id = ? AND package_number < ?
          AND status NOT IN ('PLACED','OPEN','EMPTY','MISSING','DAMAGED','QUARANTINED','CANCELLED')
        ORDER BY package_number LIMIT 1
      `).get(pkg.batch_line_id, pkg.package_number) as any;
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
          receiving_location_reserved_at = NULL, receiving_last_activity_at = CURRENT_TIMESTAMP,
          receiving_device_id = NULL, placed_by_user_id = ?, placed_by_username = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(location.id, actor.id, actor.username, pkg.id);
      this.recordStockMovement(pkg, "INBOUND", pkg.planned_quantity, "package_placement", placementId, `place:${pkg.id}`, actor);
      this.db.prepare("UPDATE products SET central_stock = COALESCE(central_stock, 0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(pkg.planned_quantity, pkg.product_id);
      this.db.prepare("INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type) VALUES (?, ?, 'WAREHOUSE', ?, ?, 'IN')")
        .run(randomUUID(), pkg.product_id, pkg.planned_quantity, `Paket girişi: ${pkg.package_code}`);
      const sessionCompleted = this.refreshBatchStatus(pkg.batch_id);
      this.sessionEvent(pkg.batch_id, pkg.id, "PACKAGE_PLACED", actor, clean(input.device_id, 150), { location_code: location.code, quantity: pkg.planned_quantity, override_reason: overrideReason || null });
      if (sessionCompleted) {
        this.sessionEvent(pkg.batch_id, null, "SESSION_COMPLETED", actor, clean(input.device_id, 150));
        this.audit("WAREHOUSE_RECEIVING_COMPLETED", "inbound_batch", pkg.batch_id, { automatic: true }, actor);
      }
      this.audit("WAREHOUSE_PACKAGE_PLACED", "warehouse_package", pkg.id, { location_code: location.code, quantity: pkg.planned_quantity, override_reason: overrideReason || null }, actor);
      return { placement: this.db.prepare("SELECT * FROM package_placements WHERE id = ?").get(placementId), package: this.getPackage(pkg.id), idempotent: false };
    })();
  }

  releaseReceivingPackage(packageIdValue: string, actor: WarehouseActor, deviceId?: string) {
    const packageId = clean(packageIdValue, 100);
    return this.db.transaction(() => {
      const pkg = this.db.prepare(`
        SELECT p.*, b.lot_number FROM warehouse_packages p
        JOIN inbound_batches b ON b.id = p.batch_id WHERE p.id = ?
      `).get(packageId) as any;
      if (!pkg || !pkg.lot_number) throw new WarehouseServiceError(404, "PACKAGE_NOT_FOUND", "Mal kabul paketi bulunamadı.");
      if (!RECEIVING_ACTIVE_STATUSES.includes(pkg.status)) {
        throw new WarehouseServiceError(409, "PACKAGE_NOT_ACTIVE", "Paket serbest bırakılabilir aktif iş durumunda değil.");
      }
      this.db.prepare(`UPDATE warehouse_packages SET
        status = CASE WHEN status = 'CLAIMED' THEN 'EXPECTED' ELSE status END,
        claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL,
        receiving_device_id = NULL, receiving_work_started_at = NULL,
        receiving_last_activity_at = CURRENT_TIMESTAMP,
        receiving_location_reserved_at = NULL, recommended_location_id = NULL,
        recommended_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(packageId);
      this.sessionEvent(pkg.batch_id, pkg.id, "PACKAGE_CLAIM_RELEASED", actor, deviceId, { previous_user_id: pkg.claimed_by });
      this.audit("WAREHOUSE_PACKAGE_CLAIM_RELEASED", "warehouse_package", pkg.id, { previous_user_id: pkg.claimed_by }, actor);
      return this.getPackage(pkg.id);
    }).immediate();
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
      const usage = this.locationUsage(location.id, pkg.id);
      if (usage.occupied + usage.reserved >= Number(location.package_capacity)) throw new WarehouseServiceError(409, "LOCATION_FULL", "Lokasyon kapasitesi dolu veya Mal Kabul için rezerve edildi.");
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

  private findWarehouseLocation(codeValue: unknown) {
    const code = normalizeWarehouseLocationCode(codeValue);
    if (!code) return null;
    const locations = this.db.prepare("SELECT * FROM warehouse_locations ORDER BY active DESC, created_at, id").all() as any[];
    const matches = locations.filter((location) => normalizeWarehouseLocationCode(location.code) === code);
    const location = matches[0] || null;
    if (location && matches.length === 1 && location.code !== code) {
      this.db.prepare("UPDATE warehouse_locations SET code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(code, location.id);
      location.code = code;
    }
    return location;
  }

  private syncReceivingLocation(codeValue: unknown, actor: WarehouseActor, required: boolean): string | null {
    const code = normalizeWarehouseLocationCode(codeValue);
    if (!code) return null;
    const existing = this.findWarehouseLocation(code);
    if (existing) {
      if (!existing.active) {
        if (required) throw new WarehouseServiceError(409, "PLANNED_LOCATION_NOT_FOUND", `${code} planlanan rafı depo lokasyonlarında bulunamadı. Master ürün lokasyonunu kontrol edin.`);
        return null;
      }
      return code;
    }
    if (!isValidWarehouseLocationCode(code)) {
      if (required) throw new WarehouseServiceError(409, "PLANNED_LOCATION_NOT_FOUND", `${code} planlanan rafı depo lokasyonlarında bulunamadı. Master ürün lokasyonunu kontrol edin.`);
      return null;
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO warehouse_locations (id, code, package_capacity, notes, created_by)
      VALUES (?, ?, 4, 'Mal Kabul V2 master lokasyon senkronizasyonu', ?)
    `).run(id, code, actor.id);
    this.audit("WAREHOUSE_LOCATION_SYNCED_FROM_MASTER", "warehouse_location", id, { code, package_capacity: 4 }, actor);
    return code;
  }

  private locationUsage(locationId: string, excludePackageId = "") {
    const occupied = this.db.prepare(`
      SELECT COUNT(*) AS count FROM warehouse_packages
      WHERE current_location_id = ? AND status IN ('PLACED','OPEN')
    `).get(locationId) as any;
    const reserved = this.db.prepare(`
      SELECT COUNT(*) AS count FROM warehouse_packages
      WHERE recommended_location_id = ? AND receiving_location_reserved_at IS NOT NULL
        AND current_location_id IS NULL
        AND status IN ('CLAIMED','LABEL_QUEUED','LABELED','PRINT_FAILED')
        AND id != ?
    `).get(locationId, excludePackageId) as any;
    return { occupied: Number(occupied.count), reserved: Number(reserved.count) };
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
      UPDATE inbound_batches SET status = ?, receiving_state = CASE WHEN ? THEN 'completed' ELSE receiving_state END,
        completed_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'CANCELLED'
    `).run(complete ? "COMPLETED" : Number(counts.placed) > 0 ? "PLACING" : "RECEIVING", complete ? 1 : 0, complete ? 1 : 0, batchId);
    return complete;
  }

  private sessionEvent(batchId: string, packageId: string | null, eventType: string, actor: WarehouseActor, deviceId?: string, details: unknown = {}) {
    const session = this.db.prepare("SELECT lot_number FROM inbound_batches WHERE id = ?").get(batchId) as any;
    if (!session?.lot_number) return;
    this.db.prepare(`
      INSERT INTO inbound_session_events (id, batch_id, package_id, event_type, actor_id, actor_username, device_id, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), batchId, packageId, eventType, actor.id, actor.username, clean(deviceId, 150) || null, JSON.stringify(details || {}));
  }

  private audit(action: string, entityType: string, entityId: string, details: unknown, actor: WarehouseActor) {
    this.writeActivity(action, entityType, entityId, { ...(details as Record<string, unknown>), source: "warehouse_admin" }, actor.id);
  }
}

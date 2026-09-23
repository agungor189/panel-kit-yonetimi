import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { canonicalPayloadHash } from "../commands/commandFoundation.js";

export type PrintPurpose = "GOODS_RECEIPT_PACKAGE" | "LOCATION" | "SHIPPING";
export type ReprintReason = "DAMAGED_OUTPUT" | "LOST" | "PRINTER_ERROR" | "OTHER";
export const PRINT_STATUSES = ["QUEUED", "RENDERED", "SUBMITTED", "ACKNOWLEDGED", "PRINTED_CONFIRMED", "DELIVERY_UNKNOWN", "FAILED", "CANCELLED"] as const;
export const PRINTER_TARGET = { model: "Xprinter XP-470B", dpi: 203 } as const;

export class PrintingError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) { super(message); }
}

const required = (value: unknown, field: string, max = 500) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) throw new PrintingError("PRINT_VALIDATION_ERROR", `${field} is required.`);
  return normalized;
};
const optional = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max) || null;
const json = (value: unknown) => JSON.stringify(value);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export type TemplateSnapshot = {
  id: string; name: string; purpose: "goods_receipt" | "location"; version: number; contentHash: string;
  width: number; height: number; elements: Array<Record<string, unknown>>; isDefault?: boolean;
};

export class PrintingService {
  constructor(private readonly db: Database.Database) {}

  private validateTemplate(template: TemplateSnapshot, purpose: Exclude<PrintPurpose, "SHIPPING">) {
    if (!template || typeof template !== "object" || !Array.isArray(template.elements)) throw new PrintingError("TEMPLATE_SNAPSHOT_REQUIRED", "An immutable L template snapshot is required.");
    const expectedPurpose = purpose === "GOODS_RECEIPT_PACKAGE" ? "goods_receipt" : "location";
    const expectedSize = purpose === "GOODS_RECEIPT_PACKAGE" ? [100, 150] : [100, 50];
    const expectedBarcode = purpose === "GOODS_RECEIPT_PACKAGE" ? "{SKU}" : "{Lokasyon}";
    if (template.purpose !== expectedPurpose || template.width !== expectedSize[0] || template.height !== expectedSize[1]) {
      throw new PrintingError("TEMPLATE_CONTRACT_MISMATCH", `${purpose} template must be ${expectedSize.join("x")} mm.`);
    }
    if (!Number.isSafeInteger(template.version) || template.version < 1 || !/^[a-f0-9]{64}$/i.test(template.contentHash)) {
      throw new PrintingError("TEMPLATE_VERSION_INVALID", "Template version/content hash is invalid.");
    }
    const barcodes = template.elements.filter((element) => element.type === "barcode");
    if (barcodes.length !== 1 || barcodes[0].value !== expectedBarcode) {
      throw new PrintingError("BARCODE_CONTRACT_MISMATCH", `${purpose} requires one Code128 value ${expectedBarcode}.`);
    }
  }

  packageSnapshot(packageIdValue: string) {
    const packageId = required(packageIdValue, "packageId", 200);
    const current = this.db.prepare(`SELECT ep.*,p.sku,p.title,p.name_tr,p.name_en,p.material,p.form_code,p.product_series,p.size,p.weight_grams
      FROM warehouse_execution_packages ep JOIN products p ON p.id=ep.product_id WHERE ep.id=? OR ep.package_code=?`).get(packageId, packageId) as any;
    if (current) return {
      subjectId: current.id, subjectCode: current.package_code,
      payload: { Package_code: current.package_code, SKU: current.sku, Urun_adi: current.name_tr || current.name_en || current.title || current.sku,
        Urun_kodu: "", Supplier_no: "", Malzeme: current.material || "", Tip: current.form_code || current.product_series || "",
        Olcu: current.size || "", Parti_Lot: current.supplier_lot_code, Paket_ici_adet: String(current.initial_quantity_base_int),
        Paket_no: "1 / 1", Toplam_paket: "1", Stok_sayisi: String(current.initial_quantity_base_int),
        Urun_agirligi: current.weight_grams ? `${current.weight_grams} g` : "", Kutu_agirligi: current.weight_grams ? `${current.weight_grams} g` : "" },
    };
    const legacy = this.db.prepare(`SELECT wp.*,l.sku_snapshot,l.product_name_snapshot,l.lot_number,l.supplier_no_snapshot,l.material_snapshot,
      l.form_snapshot,l.series_snapshot,l.size_snapshot,l.unit_weight_g_snapshot,l.package_weight_kg_snapshot
      FROM warehouse_packages wp JOIN inbound_batch_lines l ON l.id=wp.batch_line_id WHERE wp.id=? OR wp.package_code=?`).get(packageId, packageId) as any;
    if (!legacy) throw new PrintingError("PACKAGE_NOT_FOUND", "Package was not found.", 404);
    return { subjectId: legacy.id, subjectCode: legacy.package_code, payload: {
      Package_code: legacy.package_code, SKU: legacy.sku_snapshot, Urun_adi: legacy.product_name_snapshot,
      Urun_kodu: legacy.supplier_no_snapshot || "", Supplier_no: legacy.supplier_no_snapshot || "", Malzeme: legacy.material_snapshot || "",
      Tip: legacy.form_snapshot || legacy.series_snapshot || "", Olcu: legacy.size_snapshot || "", Parti_Lot: legacy.lot_number || "",
      Paket_ici_adet: String(legacy.planned_quantity), Paket_no: `${legacy.package_number} / ${legacy.total_packages}`,
      Toplam_paket: String(legacy.total_packages), Stok_sayisi: String(Number(legacy.planned_quantity) * Number(legacy.total_packages)),
      Urun_agirligi: legacy.unit_weight_g_snapshot ? `${legacy.unit_weight_g_snapshot} g` : "",
      Kutu_agirligi: legacy.package_weight_kg_snapshot ? `${legacy.package_weight_kg_snapshot} kg` : "",
    } };
  }

  locationSnapshot(locationIdValue: string) {
    const locationId = required(locationIdValue, "locationId", 200);
    const location = this.db.prepare(`SELECT id,code FROM warehouse_location_slots WHERE (id=? OR code=?) AND active=1
      UNION ALL SELECT id,code FROM warehouse_locations WHERE (id=? OR code=?) AND active=1 LIMIT 1`).get(locationId, locationId, locationId, locationId) as any;
    if (!location) throw new PrintingError("LOCATION_NOT_FOUND", "Location was not found.", 404);
    return { subjectId: location.id, subjectCode: location.code, payload: { Lokasyon: location.code } };
  }

  queueTemplateJob(input: { purpose: "GOODS_RECEIPT_PACKAGE" | "LOCATION"; subjectId: string; subjectCode: string; payload: Record<string, unknown>;
    template: TemplateSnapshot; operationId: string; actorId: string; printerName?: string | null; originalJobId?: string | null }) {
    this.validateTemplate(input.template, input.purpose);
    return this.insertJob({ ...input, subjectType: input.purpose === "LOCATION" ? "warehouse_location" : "warehouse_package" });
  }

  queueShippingJob(input: { shipmentId: string; packageId: string; subjectCode: string; artifactReference: string; artifactSha256: string;
    artifactMediaType: string; artifact: Buffer; operationId: string; actorId: string; printerName?: string | null }) {
    if (!/^[a-f0-9]{64}$/i.test(input.artifactSha256) || sha256(input.artifact) !== input.artifactSha256) {
      throw new PrintingError("SHIPPING_ARTIFACT_HASH_MISMATCH", "Provider-native shipping label hash does not match.", 409);
    }
    return this.insertJob({ purpose: "SHIPPING", subjectType: "shipment_package", subjectId: input.packageId, subjectCode: input.subjectCode,
      payload: { shipmentId: input.shipmentId, packageId: input.packageId }, operationId: input.operationId, actorId: input.actorId,
      printerName: input.printerName, provider: "GELIVER", artifactReference: input.artifactReference,
      artifactSha256: input.artifactSha256, artifactMediaType: input.artifactMediaType, artifact: input.artifact });
  }

  private insertJob(input: any) {
    const operationId = required(input.operationId, "operationId", 200);
    const actorId = required(input.actorId, "actorId", 200);
    const requestHash = canonicalPayloadHash({ purpose: input.purpose, subjectId: input.subjectId, subjectCode: input.subjectCode,
      template: input.template ? { id: input.template.id, version: input.template.version, contentHash: input.template.contentHash } : null,
      artifactSha256: input.artifactSha256 || null, originalJobId: input.originalJobId || null,
      reprintReason: input.reprintReason || null, reprintExplanation: input.reprintExplanation || null });
    const existing = this.db.prepare("SELECT * FROM printing_jobs WHERE created_operation_id=?").get(operationId) as any;
    if (existing) {
      if (existing.request_hash !== requestHash || existing.created_by !== actorId) throw new PrintingError("IDEMPOTENCY_KEY_CONFLICT", "Operation key payload differs.", 409);
      return this.getJob(existing.id);
    }
    const id = randomUUID();
    const payloadJson = json(input.payload);
    const templateJson = input.template ? json(input.template) : null;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO printing_jobs (id,purpose,subject_type,subject_id,subject_code,original_job_id,request_hash,
        template_id,template_version,template_content_hash,template_snapshot_json,payload_snapshot_json,payload_snapshot_hash,
        provider,artifact_reference,artifact_sha256,artifact_media_type,artifact_blob,printer_name,created_operation_id,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.purpose, input.subjectType, input.subjectId, input.subjectCode,
        input.originalJobId || null, requestHash, input.template?.id || null, input.template?.version || null, input.template?.contentHash || null,
        templateJson, payloadJson, sha256(payloadJson), input.provider || null, input.artifactReference || null, input.artifactSha256 || null,
        input.artifactMediaType || null, input.artifact || null, optional(input.printerName, 160), operationId, actorId);
      this.event(id, null, null, "QUEUED", operationId, actorId, { explicitOperatorAction: true });
    }).immediate();
    return this.getJob(id);
  }

  reprint(input: { originalJobId: string; reason: ReprintReason; explanation?: string | null; operationId: string; actorId: string }) {
    const original = this.row(input.originalJobId);
    if (!["DAMAGED_OUTPUT", "LOST", "PRINTER_ERROR", "OTHER"].includes(input.reason)) throw new PrintingError("REPRINT_REASON_REQUIRED", "A valid reprint reason is required.");
    const explanation = optional(input.explanation, 1000);
    if (input.reason === "OTHER" && !explanation) throw new PrintingError("REPRINT_EXPLANATION_REQUIRED", "OTHER requires an explanation.");
    const payload = JSON.parse(original.payload_snapshot_json);
    const template = original.template_snapshot_json ? JSON.parse(original.template_snapshot_json) : null;
    return this.db.transaction(() => {
      const common = { purpose: original.purpose, subjectType: original.subject_type, subjectId: original.subject_id, subjectCode: original.subject_code,
        payload, operationId: input.operationId, actorId: input.actorId, printerName: original.printer_name, originalJobId: original.id,
        reprintReason: input.reason, reprintExplanation: explanation };
      const job = original.purpose === "SHIPPING"
        ? this.insertJob({ ...common, provider: original.provider, artifactReference: original.artifact_reference, artifactSha256: original.artifact_sha256,
            artifactMediaType: original.artifact_media_type, artifact: original.artifact_blob })
        : this.insertJob({ ...common, template });
      this.db.prepare(`INSERT OR IGNORE INTO printing_reprints (id,original_job_id,reprint_job_id,reason,explanation,operation_id,actor_id)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), original.id, job.id, input.reason, explanation, input.operationId, input.actorId);
      return this.getJob(job.id);
    }).immediate();
  }

  confirm(jobId: string, operationId: string, actorId: string) {
    const job = this.row(jobId);
    if (!["ACKNOWLEDGED", "DELIVERY_UNKNOWN"].includes(job.status)) throw new PrintingError("PRINT_CONFIRM_STATE_CONFLICT", "Only acknowledged or delivery-unknown jobs can be confirmed.", 409);
    this.transition(job.id, "PRINTED_CONFIRMED", operationId, actorId, { operatorConfirmed: true }, null, "confirmed_at=CURRENT_TIMESTAMP");
    return this.getJob(job.id);
  }

  cancel(jobId: string, operationId: string, actorId: string) {
    const job = this.row(jobId);
    if (!["QUEUED", "RENDERED", "FAILED"].includes(job.status)) throw new PrintingError("PRINT_CANCEL_STATE_CONFLICT", "Print job can no longer be cancelled.", 409);
    this.transition(job.id, "CANCELLED", operationId, actorId, {}, null, "cancelled_at=CURRENT_TIMESTAMP");
    return this.getJob(job.id);
  }

  claimNext(workerId: string, leaseSeconds = 90) {
    return this.db.transaction(() => {
      const job = this.db.prepare(`SELECT j.* FROM printing_jobs j
        WHERE j.status='QUEUED' AND NOT EXISTS (
          SELECT 1 FROM printing_attempts a WHERE a.job_id=j.id AND a.state='STARTED' AND datetime(a.lease_expires_at)>datetime('now')
        ) ORDER BY datetime(j.created_at),j.id LIMIT 1`).get() as any;
      if (!job) return null;
      const count = Number(this.db.prepare("SELECT COUNT(*) FROM printing_attempts WHERE job_id=?").pluck().get(job.id)) + 1;
      const attemptId = randomUUID(); const leaseToken = randomUUID();
      this.db.prepare(`INSERT INTO printing_attempts (id,job_id,attempt_number,attempt_identity,state,lease_token,lease_expires_at)
        VALUES (?,?,?,?,'STARTED',?,datetime('now',?))`).run(attemptId, job.id, count, `${job.id}:attempt:${count}`, leaseToken, `+${Math.max(30, leaseSeconds)} seconds`);
      return { job, attemptId, leaseToken, workerId };
    }).immediate();
  }

  mark(jobId: string, attemptId: string, to: "RENDERED" | "SUBMITTED" | "ACKNOWLEDGED" | "DELIVERY_UNKNOWN" | "FAILED", details: Record<string, unknown>, actorId: string) {
    const job = this.row(jobId); const attempt = this.db.prepare("SELECT * FROM printing_attempts WHERE id=? AND job_id=?").get(attemptId, jobId) as any;
    if (!attempt) throw new PrintingError("PRINT_ATTEMPT_NOT_FOUND", "Print attempt was not found.", 404);
    const allowed: Record<string, string[]> = {
      QUEUED: ["RENDERED", "FAILED"], RENDERED: ["SUBMITTED", "FAILED"], SUBMITTED: ["ACKNOWLEDGED", "DELIVERY_UNKNOWN", "FAILED"],
      ACKNOWLEDGED: ["DELIVERY_UNKNOWN", "FAILED"], DELIVERY_UNKNOWN: [], FAILED: [], CANCELLED: [], PRINTED_CONFIRMED: [],
    };
    if (!allowed[job.status]?.includes(to)) throw new PrintingError("PRINT_STATE_CONFLICT", `${job.status} cannot transition to ${to}.`, 409);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE printing_attempts SET state=?,rendered_sha256=COALESCE(?,rendered_sha256),spool_reference=COALESCE(?,spool_reference),
        error_code=COALESCE(?,error_code),error_message=COALESCE(?,error_message),completed_at=CASE WHEN ? IN ('DELIVERY_UNKNOWN','FAILED') THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=?`)
        .run(to, details.renderedSha256 || null, details.spoolReference || null, details.errorCode || null, details.errorMessage || null, to, attemptId);
      this.db.prepare("UPDATE printing_jobs SET status=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(to, details.errorCode || null, details.errorMessage || null, jobId);
      this.event(jobId, attemptId, job.status, to, `${attempt.attempt_identity}:${to}`, actorId, details);
    }).immediate();
    return this.getJob(jobId);
  }

  listJobs(limit = 100) {
    return (this.db.prepare("SELECT * FROM printing_jobs ORDER BY datetime(created_at) DESC,id DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as any[])
      .map((row) => this.view(row));
  }
  getJob(id: string) { return this.view(this.row(id)); }
  private row(id: string) {
    const row = this.db.prepare("SELECT * FROM printing_jobs WHERE id=?").get(required(id, "jobId", 200)) as any;
    if (!row) throw new PrintingError("PRINT_JOB_NOT_FOUND", "Print job was not found.", 404);
    return row;
  }
  private view(row: any) {
    const { artifact_blob: _artifactBlob, ...safeRow } = row;
    return { ...safeRow, payload_snapshot: JSON.parse(row.payload_snapshot_json),
      template_snapshot: row.template_snapshot_json ? JSON.parse(row.template_snapshot_json) : null,
      attempts: this.db.prepare("SELECT * FROM printing_attempts WHERE job_id=? ORDER BY attempt_number").all(row.id),
      reprint: this.db.prepare("SELECT * FROM printing_reprints WHERE reprint_job_id=?").get(row.id) || null,
      history: this.db.prepare("SELECT * FROM printing_events WHERE job_id=? ORDER BY event_index").all(row.id) };
  }
  private transition(jobId: string, to: string, operationId: string, actorId: string, details: unknown, attemptId: string | null, extraSql = "") {
    const job = this.row(jobId);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE printing_jobs SET status=?,updated_at=CURRENT_TIMESTAMP${extraSql ? `,${extraSql}` : ""} WHERE id=?`).run(to, jobId);
      this.event(jobId, attemptId, job.status, to, operationId, actorId, details);
    }).immediate();
  }
  private event(jobId: string, attemptId: string | null, from: string | null, to: string, operationId: string, actorId: string, details: unknown) {
    const eventIndex = Number(this.db.prepare("SELECT COALESCE(MAX(event_index),-1)+1 FROM printing_events WHERE job_id=?").pluck().get(jobId));
    this.db.prepare(`INSERT INTO printing_events (id,job_id,event_index,attempt_id,from_status,to_status,operation_id,actor_id,details_json)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), jobId, eventIndex, attemptId, from, to, operationId, actorId, json(details));
  }
}

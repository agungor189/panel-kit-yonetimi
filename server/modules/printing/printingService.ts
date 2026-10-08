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
const ACTIVE_REPRINT_STATUSES = ["QUEUED", "RENDERED", "SUBMITTED", "ACKNOWLEDGED", "DELIVERY_UNKNOWN"] as const;

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
    const expectedBarcode = purpose === "GOODS_RECEIPT_PACKAGE" ? "{Package_code}" : "{Lokasyon}";
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

  packageSnapshot(packageIdValue: string, observation?: { planVersion?: string; supplierLotCode?: string; quantityBaseInt?: number }): { subjectId: string; subjectCode: string; payload: Record<string, unknown> } {
    const packageId = required(packageIdValue, "packageId", 200);
    let current = this.db.prepare(`SELECT ep.*,p.supplier_code,p.sku,p.title,p.name_tr,p.name_en,p.material,p.form_code,p.product_series,p.size,p.weight_grams AS unit_weight_grams,p.product_type
      FROM warehouse_execution_packages ep JOIN products p ON p.id=ep.product_id WHERE ep.id=? OR ep.package_code=?`).get(packageId, packageId) as any;
    const plan = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='procurement_package_plan'").get()
      ? this.db.prepare('SELECT * FROM procurement_package_plan WHERE id=? OR package_code=?').get(current?.id || packageId, packageId) as any : null;
    if (!current && plan) {
      const workflow = this.db.prepare(`SELECT w.state,p.status FROM procurement_workflows w JOIN purchase_orders p ON p.id=w.purchase_order_id WHERE p.id=?`).get(plan.purchase_order_id) as any;
      if (workflow?.state !== 'RECEIPT_PENDING' || workflow.status !== 'APPROVED') throw new PrintingError('PACKAGE_PLAN_NOT_APPROVED', 'Paket planı mal kabul için onaylanmış olmalı.', 409);
      if (observation?.planVersion !== plan.plan_version) throw new PrintingError('PACKAGE_PLAN_STALE', 'Paket planı sürümü değişti.', 409);
      if (this.db.prepare('SELECT 1 FROM warehouse_goods_receipts WHERE purchase_line_id=?').get(plan.purchase_line_id)) throw new PrintingError('PACKAGE_NOT_RECEIVED', 'Bu satırın nihai kabulünde bulunmayan paket basılamaz.', 409);
      const quantity = observation?.quantityBaseInt ?? plan.quantity_base_int;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new PrintingError('PRINT_QUANTITY_INVALID', 'Etiket adedi pozitif tam sayı olmalı.');
      current = { id: plan.id, package_code: plan.package_code, purchase_order_id: plan.purchase_order_id,
        initial_quantity_base_int: quantity, target_quantity_base_int: plan.quantity_base_int,
        supplier_lot_code: required(observation?.supplierLotCode, 'supplierLotCode'), weight_grams: null };
    } else if (current && observation && (observation.quantityBaseInt !== undefined && observation.quantityBaseInt !== current.initial_quantity_base_int
      || observation.supplierLotCode !== undefined && observation.supplierLotCode !== current.supplier_lot_code
      || observation.planVersion !== undefined && observation.planVersion !== plan?.plan_version)) {
      throw new PrintingError('PRINT_OBSERVATION_CONFLICT', 'Kabul edilmiş paketin kayıtlı adet/lot/plan bilgisi kullanılmalı.', 409);
    }
    if (plan) {
      const product = JSON.parse(plan.product_snapshot_json);
      Object.assign(current, { sku: product.sku, title: product.title, name_tr: product.name_tr, name_en: product.name_en,
        supplier_code: product.supplier_code, form_code: product.profile_type, material: product.material, size: product.size, product_type: product.product_type, unit_weight_grams: product.mass_grams });
    }
    if (current) return {
      subjectId: current.id, subjectCode: current.package_code,
      payload: { Satin_alma_no: this.db.prepare('SELECT purchase_number FROM procurement_workflows WHERE purchase_order_id=?').pluck().get(current.purchase_order_id) || '', Package_code: current.package_code, SKU: current.sku, Urun_adi: current.name_tr || current.name_en || current.title || current.sku,
        ...(plan ? { Plan_version: plan.plan_version, Kaynak_koli: `${plan.source_group_ref} / ${plan.source_carton_id}`, Tur: current.product_type,
          Label_version: canonicalPayloadHash({ packageId: current.id, actual: current.initial_quantity_base_int, lot: current.supplier_lot_code, planned: current.target_quantity_base_int, plan: plan.plan_version }) } : {}),
        Urun_kodu: current.supplier_code || "", Supplier_no: current.supplier_code || "", Malzeme: current.material || "", Tip: current.form_code || current.product_series || "",
        Olcu: current.size || "", Parti_Lot: current.supplier_lot_code, Paket_ici_adet: String(current.initial_quantity_base_int),
        Paket_no: "1 / 1", Toplam_paket: "1", Stok_sayisi: String(current.initial_quantity_base_int),
        Urun_agirligi: current.unit_weight_grams ? `${current.unit_weight_grams} g` : "", Kutu_agirligi: current.weight_grams ? `${current.weight_grams} g` : "" },
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
    const payloadJson = json(input.payload);
    const payloadSnapshotHash = sha256(payloadJson);
    const templateJson = input.template ? json(input.template) : null;
    const printableSnapshotHash = canonicalPayloadHash({
      purpose: input.purpose,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectCode: input.subjectCode,
      template: input.template ? { id: input.template.id, version: input.template.version, contentHash: input.template.contentHash,
        snapshotHash: sha256(templateJson as string) } : null,
      payloadSnapshotHash,
      providerArtifact: input.artifactSha256 ? { provider: input.provider, reference: input.artifactReference,
        sha256: input.artifactSha256, mediaType: input.artifactMediaType } : null,
    });
    const reprintDedupeHash = input.originalJobId ? canonicalPayloadHash({ originalJobId: input.originalJobId, printableSnapshotHash,
      reason: input.reprintReason, explanation: input.reprintExplanation || null }) : null;
    const requestHash = canonicalPayloadHash({ purpose: input.purpose, subjectId: input.subjectId, subjectCode: input.subjectCode,
      template: input.template ? { id: input.template.id, version: input.template.version, contentHash: input.template.contentHash } : null,
      artifactSha256: input.artifactSha256 || null, originalJobId: input.originalJobId || null,
      reprintReason: input.reprintReason || null, reprintExplanation: input.reprintExplanation || null });
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM printing_jobs WHERE created_operation_id=?").get(operationId) as any;
      if (existing) {
        if (existing.request_hash !== requestHash || existing.created_by !== actorId || existing.printable_snapshot_hash !== printableSnapshotHash
          || (input.originalJobId && existing.reprint_dedupe_hash !== reprintDedupeHash)) {
          throw new PrintingError("IDEMPOTENCY_KEY_CONFLICT", "Operation key payload differs.", 409);
        }
        return { ...this.getJob(existing.id), logical_replay: true };
      }
      const packageRevision = input.purpose === 'GOODS_RECEIPT_PACKAGE' && !input.originalJobId;
      if (input.originalJobId && input.purpose === 'GOODS_RECEIPT_PACKAGE') this.assertCurrent(this.row(input.originalJobId), true);
      const currentRoots = packageRevision ? this.db.prepare(`SELECT * FROM printing_jobs WHERE purpose='GOODS_RECEIPT_PACKAGE'
        AND subject_id=? AND original_job_id IS NULL AND superseded_by_job_id IS NULL ORDER BY rowid DESC`).all(input.subjectId) as any[] : [];
      const logicalExisting = packageRevision ? (currentRoots.length === 1 && currentRoots[0].printable_snapshot_hash === printableSnapshotHash ? currentRoots[0] : null) : input.originalJobId
        ? this.db.prepare(`SELECT * FROM printing_jobs WHERE original_job_id IS NOT NULL AND reprint_dedupe_hash=?
            AND status IN (${ACTIVE_REPRINT_STATUSES.map(() => "?").join(",")}) ORDER BY datetime(created_at),id LIMIT 1`)
          .get(reprintDedupeHash, ...ACTIVE_REPRINT_STATUSES) as any
        : this.db.prepare("SELECT * FROM printing_jobs WHERE original_job_id IS NULL AND printable_snapshot_hash=? LIMIT 1")
          .get(printableSnapshotHash) as any;
      if (logicalExisting) return { ...this.getJob(logicalExisting.id), logical_replay: true };

      const priorJobs = packageRevision ? this.db.prepare(`SELECT * FROM printing_jobs WHERE purpose='GOODS_RECEIPT_PACKAGE'
        AND subject_id=? AND superseded_by_job_id IS NULL`).all(input.subjectId) as any[] : [];
      const replacementRequired = priorJobs.some(job => this.mayHaveBeenSubmitted(job) || (job.replacement_required && !job.replacement_acknowledged_at));
      const id = randomUUID();
      for (const prior of priorJobs) {
        this.db.prepare('UPDATE printing_jobs SET superseded_by_job_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(id, prior.id);
        const canCancel = !this.mayHaveBeenSubmitted(prior) && ['QUEUED','RENDERED','FAILED'].includes(prior.status);
        if (canCancel) {
          this.db.prepare("UPDATE printing_jobs SET status='CANCELLED',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(prior.id);
          this.db.prepare("UPDATE printing_attempts SET state='FAILED',completed_at=CURRENT_TIMESTAMP,error_code='PRINT_VERSION_SUPERSEDED' WHERE job_id=? AND completed_at IS NULL AND submission_started_at IS NULL").run(prior.id);
        }
        this.event(prior.id, null, prior.status, canCancel ? 'CANCELLED' : prior.status, `${operationId}:supersede`, actorId, { supersededByJobId: id, invalidated: true, mayHaveBeenSubmitted: this.mayHaveBeenSubmitted(prior) });
      }
      this.db.prepare(`INSERT INTO printing_jobs (id,purpose,subject_type,subject_id,subject_code,original_job_id,request_hash,
        template_id,template_version,template_content_hash,template_snapshot_json,payload_snapshot_json,payload_snapshot_hash,
        printable_snapshot_hash,reprint_dedupe_hash,provider,artifact_reference,artifact_sha256,artifact_media_type,artifact_blob,
        printer_name,created_operation_id,created_by,supersedes_job_id,replacement_required)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, input.purpose, input.subjectType, input.subjectId, input.subjectCode,
        input.originalJobId || null, requestHash, input.template?.id || null, input.template?.version || null, input.template?.contentHash || null,
        templateJson, payloadJson, payloadSnapshotHash, printableSnapshotHash, reprintDedupeHash, input.provider || null, input.artifactReference || null, input.artifactSha256 || null,
        input.artifactMediaType || null, input.artifact || null, optional(input.printerName, 160), operationId, actorId, currentRoots[0]?.id || null, replacementRequired ? 1 : 0);
      this.event(id, null, null, "QUEUED", operationId, actorId, { explicitOperatorAction: true, supersedesJobId: currentRoots[0]?.id || null, replacementRequired });
      return { ...this.getJob(id), logical_replay: false };
    }).immediate();
  }

  reprint(input: { originalJobId: string; reason: ReprintReason; explanation?: string | null; operationId: string; actorId: string }) {
    const original = this.row(input.originalJobId);
    if (!["DAMAGED_OUTPUT", "LOST", "PRINTER_ERROR", "OTHER"].includes(input.reason)) throw new PrintingError("REPRINT_REASON_REQUIRED", "A valid reprint reason is required.");
    const explanation = optional(input.explanation, 1000);
    if (input.reason === "OTHER" && !explanation) throw new PrintingError("REPRINT_EXPLANATION_REQUIRED", "OTHER requires an explanation.");
    const payload = JSON.parse(original.payload_snapshot_json);
    const template = original.template_snapshot_json ? JSON.parse(original.template_snapshot_json) : null;
    return this.db.transaction(() => {
      this.assertCurrent(this.row(original.id), true);
      const common = { purpose: original.purpose, subjectType: original.subject_type, subjectId: original.subject_id, subjectCode: original.subject_code,
        payload, operationId: input.operationId, actorId: input.actorId, printerName: original.printer_name, originalJobId: original.id,
        reprintReason: input.reason, reprintExplanation: explanation };
      const job = original.purpose === "SHIPPING"
        ? this.insertJob({ ...common, provider: original.provider, artifactReference: original.artifact_reference, artifactSha256: original.artifact_sha256,
            artifactMediaType: original.artifact_media_type, artifact: original.artifact_blob })
        : this.insertJob({ ...common, template });
      this.db.prepare(`INSERT OR IGNORE INTO printing_reprints (id,original_job_id,reprint_job_id,reason,explanation,operation_id,actor_id)
        VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), original.id, job.id, input.reason, explanation, input.operationId, input.actorId);
      return { ...this.getJob(job.id), logical_replay: job.logical_replay };
    }).immediate();
  }

  confirm(jobId: string, operationId: string, actorId: string) {
    const job = this.row(jobId);
    if (!["ACKNOWLEDGED", "DELIVERY_UNKNOWN"].includes(job.status)) throw new PrintingError("PRINT_CONFIRM_STATE_CONFLICT", "Only acknowledged or delivery-unknown jobs can be confirmed.", 409);
    this.transition(job.id, "PRINTED_CONFIRMED", operationId, actorId, { operatorConfirmed: true }, null, "confirmed_at=CURRENT_TIMESTAMP");
    return this.getJob(job.id);
  }

  cancel(jobId: string, operationId: string, actorId: string) {
    return this.db.transaction(() => {
      const job = this.row(jobId);
      if (this.mayHaveBeenSubmitted(job) || !['QUEUED','RENDERED','FAILED'].includes(job.status)) throw new PrintingError('PRINT_CANCEL_STATE_CONFLICT', 'Print job can no longer be cancelled.', 409);
      this.transition(job.id, 'CANCELLED', operationId, actorId, {}, null, 'cancelled_at=CURRENT_TIMESTAMP');
      return this.getJob(job.id);
    }).immediate();
  }

  claimNext(workerId: string, leaseSeconds = 90) {
    return this.db.transaction(() => {
      const job = this.db.prepare(`SELECT j.* FROM printing_jobs j
        WHERE j.status='QUEUED' AND j.superseded_by_job_id IS NULL
        AND (j.purpose<>'GOODS_RECEIPT_PACKAGE' OR (SELECT COUNT(*) FROM printing_jobs roots WHERE roots.purpose='GOODS_RECEIPT_PACKAGE' AND roots.subject_id=j.subject_id AND roots.original_job_id IS NULL AND roots.superseded_by_job_id IS NULL)=1)
        AND NOT (j.replacement_required=1 AND j.replacement_acknowledged_at IS NULL)
        AND (j.original_job_id IS NULL OR NOT EXISTS (SELECT 1 FROM printing_jobs root WHERE root.id=j.original_job_id
          AND (root.superseded_by_job_id IS NOT NULL OR (root.replacement_required=1 AND root.replacement_acknowledged_at IS NULL))))
        AND NOT EXISTS (
          SELECT 1 FROM printing_attempts a WHERE a.job_id=j.id AND a.state IN ('STARTED','RENDERED') AND a.completed_at IS NULL AND datetime(a.lease_expires_at)>datetime('now')
        ) ORDER BY datetime(j.created_at),j.id LIMIT 1`).get() as any;
      if (!job) return null;
      const count = Number(this.db.prepare("SELECT COUNT(*) FROM printing_attempts WHERE job_id=?").pluck().get(job.id)) + 1;
      const attemptId = randomUUID(); const leaseToken = randomUUID();
      this.db.prepare(`INSERT INTO printing_attempts (id,job_id,attempt_number,attempt_identity,state,lease_token,lease_expires_at)
        VALUES (?,?,?,?,'STARTED',?,datetime('now',?))`).run(attemptId, job.id, count, `${job.id}:attempt:${count}`, leaseToken, `+${Math.max(30, leaseSeconds)} seconds`);
      return { job, attemptId, leaseToken, workerId };
    }).immediate();
  }

  private assertCurrent(job: any, checkReplacement = false) {
    if (job.purpose !== 'GOODS_RECEIPT_PACKAGE') return;
    if (job.superseded_by_job_id) {
      const current = this.currentPackageJob(job.subject_id);
      throw new PrintingError('PRINT_VERSION_SUPERSEDED', `Geçersiz etiket sürümü; güncel işi kullanın: ${current?.id || job.superseded_by_job_id}`, 409);
    }
    if (this.packageRevisionAmbiguous(job.subject_id)) throw new PrintingError('PRINT_REVISION_AMBIGUOUS', 'Birden fazla eski etiket sürümü var; paket ekranından güncel içerikle yeni etiket isteyin.', 409);
    const root = job.original_job_id ? this.row(job.original_job_id) : job;
    if (root.superseded_by_job_id) this.assertCurrent(root, checkReplacement);
    if (checkReplacement && root.replacement_required && !root.replacement_acknowledged_at) throw new PrintingError('PRINT_REPLACEMENT_ACK_REQUIRED', 'Eski etiketi çıkar/değiştir; yeni gönderim için açık operatör onayı gerekli.', 409);
  }
  private packageRevisionAmbiguous(subjectId: string) {
    return Number(this.db.prepare("SELECT COUNT(*) FROM printing_jobs WHERE purpose='GOODS_RECEIPT_PACKAGE' AND subject_id=? AND original_job_id IS NULL AND superseded_by_job_id IS NULL").pluck().get(subjectId)) > 1;
  }
  private currentPackageJob(subjectId: string) {
    return this.db.prepare("SELECT * FROM printing_jobs WHERE purpose='GOODS_RECEIPT_PACKAGE' AND subject_id=? AND original_job_id IS NULL AND superseded_by_job_id IS NULL ORDER BY rowid DESC LIMIT 1").get(subjectId) as any;
  }
  private mayHaveBeenSubmitted(job: any) {
    return ['SUBMITTED','ACKNOWLEDGED','PRINTED_CONFIRMED','DELIVERY_UNKNOWN'].includes(job.status)
      || Boolean(this.db.prepare(`SELECT 1 FROM printing_attempts WHERE job_id=? AND (submission_started_at IS NOT NULL
        OR state IN ('SUBMITTED','ACKNOWLEDGED','DELIVERY_UNKNOWN') OR spool_reference IS NOT NULL
        OR (state='FAILED' AND rendered_sha256 IS NOT NULL AND COALESCE(error_code,'')<>'PRINT_VERSION_SUPERSEDED'))`).get(job.id));
  }
  private validLease(jobId: string, attemptId: string, leaseToken?: string, requireLive = true) {
    const attempt = this.db.prepare(`SELECT *, datetime(lease_expires_at)>datetime('now') AS lease_live FROM printing_attempts WHERE id=? AND job_id=?`).get(attemptId, jobId) as any;
    if (!attempt || !leaseToken || attempt.lease_token !== leaseToken || attempt.completed_at || (requireLive && !attempt.lease_live)) throw new PrintingError('PRINT_LEASE_INVALID', 'Print attempt lease is stale or missing.', 409);
    return attempt;
  }

  // Durable send fence, acquired under the same SQLite write lock as revision invalidation.
  // Once acquired, replacement cannot be acknowledged until this exact attempt resolves.
  beginSubmission(jobId: string, attemptId: string, leaseToken: string, actorId: string) {
    return this.db.transaction(() => {
      const job = this.row(jobId); this.assertCurrent(job, true);
      const attempt = this.validLease(jobId, attemptId, leaseToken);
      if (job.status !== 'RENDERED' || attempt.state !== 'RENDERED' || attempt.submission_started_at) throw new PrintingError('PRINT_SUBMISSION_CONFLICT', 'Print attempt is not eligible for submission.', 409);
      this.db.prepare('UPDATE printing_attempts SET submission_started_at=CURRENT_TIMESTAMP WHERE id=?').run(attemptId);
      this.event(jobId, attemptId, job.status, job.status, `${attempt.attempt_identity}:send-fence`, actorId, { submissionStarted: true });
    }).immediate();
  }

  acknowledgeReplacement(jobId: string, confirmed: boolean, operationId: string, actorId: string) {
    return this.db.transaction(() => {
      const job = this.row(jobId); this.assertCurrent(job);
      if (confirmed !== true) throw new PrintingError('PRINT_REPLACEMENT_ACK_REQUIRED', 'Eski etiketi çıkar/değiştir işlemi için açık onay gerekli.', 409);
      if (job.original_job_id || !job.replacement_required) throw new PrintingError('PRINT_REPLACEMENT_NOT_REQUIRED', 'Bu iş için etiket değiştirme onayı gerekmiyor.', 409);
      if (job.replacement_acknowledged_at) return this.getJob(jobId);
      const inFlight = this.db.prepare(`SELECT 1 FROM printing_attempts a JOIN printing_jobs j ON j.id=a.job_id
        WHERE j.purpose='GOODS_RECEIPT_PACKAGE' AND j.subject_id=? AND j.superseded_by_job_id IS NOT NULL
          AND a.submission_started_at IS NOT NULL AND a.completed_at IS NULL`).get(job.subject_id);
      // Expiry is not proof that a paused/crashed sender can no longer send. Fail closed.
      if (inFlight) throw new PrintingError('PRINT_SUBMISSION_IN_FLIGHT', 'Eski etiket gönderimi devam ediyor veya sonucu çözümlenmedi; gönderim bitmeden yeni baskı onaylanamaz.', 409);
      this.db.prepare('UPDATE printing_jobs SET replacement_acknowledged_at=CURRENT_TIMESTAMP,replacement_acknowledged_by=? WHERE id=?').run(actorId, jobId);
      this.event(jobId, null, job.status, job.status, operationId, actorId, { oldLabelRemovedOrReplaced: true });
      return this.getJob(jobId);
    }).immediate();
  }

  mark(jobId: string, attemptId: string, to: "RENDERED" | "SUBMITTED" | "ACKNOWLEDGED" | "DELIVERY_UNKNOWN" | "FAILED", details: Record<string, unknown>, actorId: string, leaseToken?: string) {
    return this.db.transaction(() => {
      const job = this.row(jobId);
      const raw = this.db.prepare('SELECT * FROM printing_attempts WHERE id=? AND job_id=?').get(attemptId, jobId) as any;
      const attempt = this.validLease(jobId, attemptId, leaseToken, !raw?.submission_started_at);
      if (!attempt.submission_started_at) this.assertCurrent(job, true);
      if (['SUBMITTED','ACKNOWLEDGED'].includes(to) && !attempt.submission_started_at) throw new PrintingError('PRINT_SUBMISSION_FENCE_REQUIRED', 'Submission fence is required.', 409);
      const allowed: Record<string, string[]> = {
        QUEUED: ['RENDERED','FAILED'], RENDERED: ['SUBMITTED','FAILED', ...(attempt.submission_started_at ? ['DELIVERY_UNKNOWN'] : [])],
        SUBMITTED: ['ACKNOWLEDGED','DELIVERY_UNKNOWN'], ACKNOWLEDGED: ['DELIVERY_UNKNOWN'], DELIVERY_UNKNOWN: [], FAILED: [], CANCELLED: [], PRINTED_CONFIRMED: [],
      };
      if (to === 'FAILED' && attempt.submission_started_at) throw new PrintingError('PRINT_DELIVERY_UNKNOWN', 'Send started; delivery must remain unknown.', 409);
      if (!allowed[job.status]?.includes(to)) throw new PrintingError('PRINT_STATE_CONFLICT', `${job.status} cannot transition to ${to}.`, 409);
      this.db.prepare(`UPDATE printing_attempts SET state=?,rendered_sha256=COALESCE(?,rendered_sha256),spool_reference=COALESCE(?,spool_reference),
        error_code=COALESCE(?,error_code),error_message=COALESCE(?,error_message),completed_at=CASE WHEN ? IN ('DELIVERY_UNKNOWN','FAILED') THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id=?`)
        .run(to, details.renderedSha256 || null, details.spoolReference || null, details.errorCode || null, details.errorMessage || null, to, attemptId);
      this.db.prepare('UPDATE printing_jobs SET status=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(to, details.errorCode || null, details.errorMessage || null, jobId);
      this.event(jobId, attemptId, job.status, to, `${attempt.attempt_identity}:${to}`, actorId, details);
      return this.getJob(jobId);
    }).immediate();
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
    const current = row.purpose === 'GOODS_RECEIPT_PACKAGE' ? this.currentPackageJob(row.subject_id) : null;
    const replacementBlocked = Boolean(current?.replacement_required && !current.replacement_acknowledged_at);
    return { ...safeRow, revision_ambiguous: row.purpose === 'GOODS_RECEIPT_PACKAGE' && this.packageRevisionAmbiguous(row.subject_id), current_job_id: current?.id || row.id, replacement_blocked: replacementBlocked,
      replacement_warning: replacementBlocked ? 'Eski etiketi çıkar/değiştir; yeni gönderim için açık operatör onayı gerekli.' : null,
      payload_snapshot: JSON.parse(row.payload_snapshot_json),
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

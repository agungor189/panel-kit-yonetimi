import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { initializeDatabase } from "../../db/initialize.js";
import { PrintingError, PrintingService, type TemplateSnapshot } from "./printingService.js";
import { startPrintQueueWorker } from "../../services/printQueueWorker.js";

const actorId = "print-operator";
const template = (purpose: "goods_receipt" | "location", version = 1): TemplateSnapshot => ({
  id: `${purpose}-template`, name: purpose, purpose, version, contentHash: String(version).padStart(64, "a").slice(-64),
  width: purpose === "goods_receipt" ? 100 : 100, height: purpose === "goods_receipt" ? 150 : 50,
  elements: [{ id: "barcode", type: "barcode", value: purpose === "goods_receipt" ? "{SKU}" : "{Lokasyon}" }],
});
const setup = () => {
  const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); initializeDatabase(db);
  db.prepare("INSERT INTO users (id,username,password_hash,role,is_active) VALUES (?,?,?,'admin',1)").run(actorId, "Printer", "hash");
  return { db, service: new PrintingService(db) };
};

test("queue is only print intent; exact template/payload snapshots are immutable and operation replay is safe", () => {
  const { db, service } = setup();
  const payload = { SKU: "SKU-ORIGINAL", Urun_adi: "Original" };
  const selectedTemplate = template("goods_receipt");
  const first = service.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", subjectId: "pkg-1", subjectCode: "PKG-1",
    payload, template: selectedTemplate, operationId: "print-op", actorId });
  const replay = service.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", subjectId: "pkg-1", subjectCode: "PKG-1",
    payload: { SKU: "SKU-ORIGINAL", Urun_adi: "Original" }, template: template("goods_receipt"), operationId: "print-op", actorId });
  assert.equal(first.id, replay.id);
  assert.equal(first.status, "QUEUED");
  assert.equal(first.attempts.length, 0);
  payload.SKU = "SKU-CHANGED"; selectedTemplate.name = "Changed current template";
  assert.equal(service.getJob(first.id).payload_snapshot.SKU, "SKU-ORIGINAL");
  assert.equal(service.getJob(first.id).template_snapshot.name, "goods_receipt");
  assert.throws(() => service.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", subjectId: "pkg-1", subjectCode: "PKG-1",
    payload: { SKU: "SKU-DIFFERENT", Urun_adi: "Original" }, template: template("goods_receipt"), operationId: "print-op", actorId }),
  (error: unknown) => error instanceof PrintingError && error.code === "IDEMPOTENCY_KEY_CONFLICT");
  assert.throws(() => service.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", subjectId: "pkg-2", subjectCode: "PKG-2",
    payload: { SKU: "OTHER" }, template: template("goods_receipt", 2), operationId: "print-op", actorId }),
  (error: unknown) => error instanceof PrintingError && error.code === "IDEMPOTENCY_KEY_CONFLICT");
  assert.throws(() => db.prepare("UPDATE printing_jobs SET payload_snapshot_json='{}' WHERE id=?").run(first.id), /immutable/i);
  db.close();
});

test("package/location contracts reject wrong size/barcode and there is no KIT purpose", () => {
  const { db, service } = setup();
  assert.throws(() => service.queueTemplateJob({ purpose: "LOCATION", subjectId: "loc", subjectCode: "A1-K1-P1",
    payload: { Lokasyon: "A1-K1-P1" }, template: template("goods_receipt"), operationId: "bad", actorId }), /100x50/);
  assert.throws(() => db.prepare(`INSERT INTO printing_jobs (id,purpose,subject_type,subject_id,subject_code,request_hash,payload_snapshot_json,
    payload_snapshot_hash,created_operation_id,created_by) VALUES ('kit','KIT','kit','kit','KIT',?,'{}',?,'kit-op',?)`).run("a".repeat(64), "b".repeat(64), actorId));
  db.close();
});

test("provider-native Geliver artifact/reference/hash are preserved without L redesign", () => {
  const { db, service } = setup(); const artifact = Buffer.from("%PDF-provider-native-geliver");
  const hash = createHash("sha256").update(artifact).digest("hex");
  const job = service.queueShippingJob({ shipmentId: "shipment-1", packageId: "ship-pkg-1", subjectCode: "GELIVER-1",
    artifactReference: "https://labels.geliver.test/native.pdf", artifactSha256: hash, artifactMediaType: "application/pdf",
    artifact, operationId: "shipping-print", actorId });
  assert.equal(job.provider, "GELIVER"); assert.equal(job.artifact_reference, "https://labels.geliver.test/native.pdf");
  assert.equal(job.artifact_sha256, hash); assert.equal(job.template_snapshot, null);
  db.close();
});

test("worker keeps render/spool/physical confirmation distinct and failed attempts remain auditable", async () => {
  const { db, service } = setup();
  const app = express(); app.use(express.json()); app.post("/api/v1/render", (_req, res) => res.type("application/pdf").send(Buffer.from("%PDF-rendered")));
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const job = service.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", subjectId: "pkg-1", subjectCode: "PKG-1",
    payload: { SKU: "SKU-1" }, template: template("goods_receipt"), operationId: "print-worker-op", actorId });
  const worker = startPrintQueueWorker(db, { rendererUrl: `http://127.0.0.1:${port}`, printerName: "XP-470B", autoStart: false,
    submitArtifact: async () => "request id is XP-470B-7" });
  assert.equal((await worker.runOnce()), true);
  assert.equal(service.getJob(job.id).status, "DELIVERY_UNKNOWN");
  assert.deepEqual(service.getJob(job.id).history.map((event: any) => event.to_status), ["QUEUED", "RENDERED", "SUBMITTED", "ACKNOWLEDGED", "DELIVERY_UNKNOWN"]);
  assert.equal(service.confirm(job.id, "confirm-op", actorId).status, "PRINTED_CONFIRMED");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const failed = service.queueTemplateJob({ purpose: "LOCATION", subjectId: "loc", subjectCode: "A1-K1-P1",
    payload: { Lokasyon: "A1-K1-P1" }, template: template("location"), operationId: "fail-op", actorId });
  const broken = startPrintQueueWorker(db, { rendererUrl: "http://127.0.0.1:1", printerName: "XP-470B", autoStart: false, logger: { info() {}, warn() {}, error() {} } });
  assert.equal((await broken.runOnce()), false);
  assert.equal(service.getJob(failed.id).status, "FAILED");
  assert.equal(service.getJob(failed.id).attempts[0].state, "FAILED");
  db.close();
});

test("reprint requires permission-layer reason semantics and stores immutable history linked to the original", () => {
  const { db, service } = setup();
  const original = service.queueTemplateJob({ purpose: "LOCATION", subjectId: "loc", subjectCode: "A1-K1-P1",
    payload: { Lokasyon: "A1-K1-P1" }, template: template("location"), operationId: "original", actorId });
  assert.throws(() => service.reprint({ originalJobId: original.id, reason: "OTHER", operationId: "bad-reprint", actorId }),
    (error: unknown) => error instanceof PrintingError && error.code === "REPRINT_EXPLANATION_REQUIRED");
  const reprint = service.reprint({ originalJobId: original.id, reason: "DAMAGED_OUTPUT", operationId: "reprint", actorId });
  assert.equal(reprint.original_job_id, original.id); assert.equal(reprint.reprint.reason, "DAMAGED_OUTPUT");
  assert.throws(() => db.prepare("UPDATE printing_reprints SET reason='LOST' WHERE reprint_job_id=?").run(reprint.id), /immutable/i);
  db.close();
});

test("repeated package Yazdır with different client operation ids converges to one original job", () => {
  const { db, service } = setup();
  const input = { purpose: "GOODS_RECEIPT_PACKAGE" as const, subjectId: "pkg-dedupe", subjectCode: "PKG-DEDUPE",
    payload: { SKU: "SKU-DEDUPE", Urun_adi: "Same immutable package" }, template: template("goods_receipt"), actorId };
  const first = service.queueTemplateJob({ ...input, operationId: "package-click-1" });
  const second = service.queueTemplateJob({ ...input, operationId: "package-click-2" });
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM printing_jobs WHERE original_job_id IS NULL AND purpose='GOODS_RECEIPT_PACKAGE'").pluck().get(), 1);
  db.close();
});

test("repeated location Yazdır with different client operation ids converges to one original job", () => {
  const { db, service } = setup();
  const input = { purpose: "LOCATION" as const, subjectId: "loc-dedupe", subjectCode: "A1-K1-P1",
    payload: { Lokasyon: "A1-K1-P1" }, template: template("location"), actorId };
  const first = service.queueTemplateJob({ ...input, operationId: "location-click-1" });
  const second = service.queueTemplateJob({ ...input, operationId: "location-click-2" });
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM printing_jobs WHERE original_job_id IS NULL AND purpose='LOCATION'").pluck().get(), 1);
  db.close();
});

test("repeated shipping-label Yazdır with different client operation ids converges to one original job", () => {
  const { db, service } = setup();
  const artifact = Buffer.from("%PDF-same-provider-native-label");
  const input = { shipmentId: "shipment-dedupe", packageId: "ship-pkg-dedupe", subjectCode: "GELIVER-DEDUPE",
    artifactReference: "https://labels.geliver.test/dedupe.pdf", artifactSha256: createHash("sha256").update(artifact).digest("hex"),
    artifactMediaType: "application/pdf", artifact, actorId };
  const first = service.queueShippingJob({ ...input, operationId: "shipping-click-1" });
  const second = service.queueShippingJob({ ...input, operationId: "shipping-click-2" });
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM printing_jobs WHERE original_job_id IS NULL AND purpose='SHIPPING'").pluck().get(), 1);
  db.close();
});

test("reprint double-click with different client operation ids converges while a later completed reprint remains possible", () => {
  const { db, service } = setup();
  const original = service.queueTemplateJob({ purpose: "LOCATION", subjectId: "loc-reprint", subjectCode: "B1-K1-P1",
    payload: { Lokasyon: "B1-K1-P1" }, template: template("location"), operationId: "reprint-original", actorId });
  const first = service.reprint({ originalJobId: original.id, reason: "PRINTER_ERROR", operationId: "reprint-click-1", actorId });
  const second = service.reprint({ originalJobId: original.id, reason: "PRINTER_ERROR", operationId: "reprint-click-2", actorId });
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM printing_reprints WHERE original_job_id=?").pluck().get(original.id), 1);
  service.cancel(first.id, "cancel-reprint", actorId);
  const later = service.reprint({ originalJobId: original.id, reason: "PRINTER_ERROR", operationId: "reprint-later", actorId });
  assert.notEqual(later.id, first.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM printing_reprints WHERE original_job_id=?").pluck().get(original.id), 2);
  db.close();
});

test("changed payload, template version, or provider artifact hash is never collapsed as the same printable snapshot", () => {
  const { db, service } = setup();
  const base = { purpose: "GOODS_RECEIPT_PACKAGE" as const, subjectId: "pkg-change", subjectCode: "PKG-CHANGE", actorId };
  const payloadOne = service.queueTemplateJob({ ...base, payload: { SKU: "SKU-1" }, template: template("goods_receipt", 1), operationId: "snapshot-payload-1" });
  const payloadTwo = service.queueTemplateJob({ ...base, payload: { SKU: "SKU-2" }, template: template("goods_receipt", 1), operationId: "snapshot-payload-2" });
  const templateTwo = service.queueTemplateJob({ ...base, payload: { SKU: "SKU-1" }, template: template("goods_receipt", 2), operationId: "snapshot-template-2" });
  assert.equal(new Set([payloadOne.id, payloadTwo.id, templateTwo.id]).size, 3);

  const artifactOne = Buffer.from("%PDF-provider-artifact-one");
  const artifactTwo = Buffer.from("%PDF-provider-artifact-two");
  const shippingBase = { shipmentId: "shipment-change", packageId: "ship-pkg-change", subjectCode: "GELIVER-CHANGE",
    artifactReference: "https://labels.geliver.test/change.pdf", artifactMediaType: "application/pdf", actorId };
  const shippingOne = service.queueShippingJob({ ...shippingBase, artifact: artifactOne,
    artifactSha256: createHash("sha256").update(artifactOne).digest("hex"), operationId: "snapshot-artifact-1" });
  const shippingTwo = service.queueShippingJob({ ...shippingBase, artifact: artifactTwo,
    artifactSha256: createHash("sha256").update(artifactTwo).digest("hex"), operationId: "snapshot-artifact-2" });
  assert.notEqual(shippingOne.id, shippingTwo.id);
  db.close();
});

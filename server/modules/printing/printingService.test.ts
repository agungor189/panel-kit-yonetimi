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

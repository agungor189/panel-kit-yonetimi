import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrintingService } from "../modules/printing/printingService.js";

type Logger = Pick<Console, "info" | "warn" | "error">;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const runLp = (printerName: string, filePath: string) => new Promise<string>((resolve, reject) => {
  execFile("lp", ["-d", printerName, filePath], { timeout: 30_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout || "").trim()));
});

export function startPrintQueueWorker(db: Database.Database, options: {
  rendererUrl?: string; rendererApiKey?: string; printerName?: string; intervalMs?: number;
  dryRun?: boolean; autoStart?: boolean; logger?: Logger; workerId?: string;
  submitArtifact?: (artifact: Buffer, job: any) => Promise<string>;
} = {}) {
  const rendererUrl = options.rendererUrl || process.env.LABEL_RENDERER_URL || "";
  const rendererApiKey = options.rendererApiKey || process.env.LABEL_RENDERER_API_KEY || "";
  const defaultPrinter = options.printerName || process.env.WAREHOUSE_PRINTER_NAME || "";
  const intervalMs = Math.max(500, Number(options.intervalMs || process.env.WAREHOUSE_PRINT_WORKER_INTERVAL_MS) || 2_000);
  const dryRun = options.dryRun ?? process.env.WAREHOUSE_PRINT_DRY_RUN === "true";
  const logger = options.logger || console;
  const workerId = options.workerId || "panel-print-worker";
  const printing = new PrintingService(db);
  if (!rendererUrl || (!defaultPrinter && !dryRun)) {
    logger.warn("[print-worker] disabled: LABEL_RENDERER_URL and WAREHOUSE_PRINTER_NAME are required");
    return { stop() {}, runOnce: async () => false };
  }

  const render = async (job: any) => {
    if (job.purpose === "SHIPPING") {
      const artifact = Buffer.from(job.artifact_blob || []);
      if (!artifact.length || sha256(artifact) !== job.artifact_sha256) throw Object.assign(new Error("Provider-native label artifact hash mismatch."), { code: "ARTIFACT_HASH_MISMATCH" });
      return artifact;
    }
    const response = await fetch(`${rendererUrl.replace(/\/$/, "")}/api/v1/render`, {
      method: "POST",
      headers: { Accept: "application/pdf", "Content-Type": "application/json", ...(rendererApiKey ? { "x-api-key": rendererApiKey } : {}) },
      body: JSON.stringify({
        purpose: job.purpose === "LOCATION" ? "location" : "goods_receipt",
        data: JSON.parse(job.payload_snapshot_json), templateId: job.template_id, templateVersion: job.template_version,
        templateContentHash: job.template_content_hash, templateSnapshot: JSON.parse(job.template_snapshot_json),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error(`Label renderer HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`), { code: "RENDERER_ERROR" });
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 4).toString() !== "%PDF") throw Object.assign(new Error("Renderer returned an invalid PDF."), { code: "INVALID_RENDER" });
    return pdf;
  };

  const submit = async (artifact: Buffer, job: any) => {
    if (options.submitArtifact) return options.submitArtifact(artifact, job);
    const directory = await mkdtemp(path.join(tmpdir(), "dsdst-print-"));
    const extension = String(job.artifact_media_type || "").toLowerCase().includes("zpl") ? "zpl" : "pdf";
    const filePath = path.join(directory, `${String(job.subject_code).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 100) || "label"}.${extension}`);
    try { await writeFile(filePath, artifact); return await runLp(job.printer_name || defaultPrinter, filePath); }
    finally { await rm(directory, { recursive: true, force: true }); }
  };

  let running = false;
  const runOnce = async () => {
    if (running) return false;
    running = true;
    const claimed = printing.claimNext(workerId);
    if (!claimed) { running = false; return false; }
    try {
      const artifact = await render(claimed.job);
      printing.mark(claimed.job.id, claimed.attemptId, "RENDERED", { renderedSha256: sha256(artifact), dryRun }, workerId);
      if (dryRun) return true;
      const spoolReference = await submit(artifact, claimed.job);
      printing.mark(claimed.job.id, claimed.attemptId, "SUBMITTED", { spoolReference }, workerId);
      printing.mark(claimed.job.id, claimed.attemptId, "ACKNOWLEDGED", { spoolReference }, workerId);
      printing.mark(claimed.job.id, claimed.attemptId, "DELIVERY_UNKNOWN", { spoolReference, reason: "NO_PHYSICAL_DELIVERY_SENSOR" }, workerId);
      logger.info(`[print-worker] submitted ${claimed.job.purpose}:${claimed.job.subject_code}; physical delivery remains unknown`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Print failed";
      const code = String((error as any)?.code || "PRINT_FAILED").slice(0, 100);
      printing.mark(claimed.job.id, claimed.attemptId, "FAILED", { errorCode: code, errorMessage: message }, workerId);
      logger.error(`[print-worker] ${claimed.job.purpose}:${claimed.job.subject_code} ${message}`);
      return false;
    } finally { running = false; }
  };
  const timer = options.autoStart === false ? null : setInterval(() => void runOnce(), intervalMs);
  timer?.unref();
  if (options.autoStart !== false) void runOnce();
  return { stop: () => { if (timer) clearInterval(timer); }, runOnce };
}

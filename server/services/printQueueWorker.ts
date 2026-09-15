import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Logger = Pick<Console, "info" | "warn" | "error">;

const runLp = (printerName: string, filePath: string) => new Promise<void>((resolve, reject) => {
  execFile("lp", ["-d", printerName, filePath], { timeout: 30_000 }, (error) => error ? reject(error) : resolve());
});

export function startPrintQueueWorker(db: Database.Database, options: {
  rendererUrl?: string;
  rendererApiKey?: string;
  printerName?: string;
  intervalMs?: number;
  dryRun?: boolean;
  autoStart?: boolean;
  logger?: Logger;
} = {}) {
  const rendererUrl = options.rendererUrl || process.env.LABEL_RENDERER_URL || "";
  const rendererApiKey = options.rendererApiKey || process.env.LABEL_RENDERER_API_KEY || "";
  const defaultPrinter = options.printerName || process.env.WAREHOUSE_PRINTER_NAME || "";
  const intervalMs = Math.max(500, Number(options.intervalMs || process.env.WAREHOUSE_PRINT_WORKER_INTERVAL_MS) || 2_000);
  const dryRun = options.dryRun ?? process.env.WAREHOUSE_PRINT_DRY_RUN === "true";
  const logger = options.logger || console;
  if (!rendererUrl || (!defaultPrinter && !dryRun)) {
    logger.warn("[warehouse-print-worker] disabled: LABEL_RENDERER_URL and WAREHOUSE_PRINTER_NAME are required");
    return { stop() {}, runOnce: async () => false };
  }

  let running = false;
  const audit = (action: string, currentJob: any, details: Record<string, unknown>) => {
    try {
      const user = db.prepare("SELECT username FROM users WHERE id = ?").get(currentJob.created_by) as any;
      db.prepare(`
        INSERT INTO activity_logs (id, action, entity_type, entity_id, details, user_id, actor_username)
        VALUES (?, ?, 'warehouse_package', ?, ?, ?, ?)
      `).run(randomUUID(), action, currentJob.package_id, JSON.stringify({ ...details, job_id: currentJob.id, source: "warehouse_print_worker" }), currentJob.created_by, user?.username || null);
    } catch (error) {
      logger.warn(`[warehouse-print-worker] audit failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };
  const sessionEvent = (eventType: string, currentJob: any, details: Record<string, unknown>) => {
    try {
      const context = db.prepare(`SELECT p.batch_id, b.lot_number, u.username
        FROM warehouse_packages p JOIN inbound_batches b ON b.id = p.batch_id
        LEFT JOIN users u ON u.id = ? WHERE p.id = ?`).get(currentJob.created_by, currentJob.package_id) as any;
      if (!context?.lot_number) return;
      db.prepare(`INSERT INTO inbound_session_events
        (id, batch_id, package_id, event_type, actor_id, actor_username, details)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), context.batch_id, currentJob.package_id, eventType, currentJob.created_by, context.username || null, JSON.stringify(details));
    } catch (error) {
      logger.warn(`[warehouse-print-worker] session event failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  };
  const runOnce = async () => {
    if (running) return false;
    running = true;
    let job: any;
    try {
      job = db.transaction(() => {
        const candidate = db.prepare(`
          SELECT j.*, p.package_code, p.package_number, p.total_packages, p.planned_quantity,
                 l.sku_snapshot, l.product_name_snapshot, l.lot_number, l.supplier_no_snapshot,
                 l.material_snapshot, l.size_snapshot, l.unit_weight_g_snapshot,
                 l.package_weight_kg_snapshot, t.template_json
          FROM print_jobs j
          JOIN warehouse_packages p ON p.id = j.package_id
          JOIN inbound_batch_lines l ON l.id = p.batch_line_id
          JOIN label_templates t ON t.id = j.template_id
          WHERE (j.status IN ('QUEUED','FAILED') OR (j.status = 'PROCESSING' AND datetime(j.claimed_at) <= datetime('now', '-5 minutes')))
            AND j.attempts < j.max_attempts
          ORDER BY datetime(j.created_at), j.id LIMIT 1
        `).get() as any;
        if (!candidate) return null;
        const changed = db.prepare(`
          UPDATE print_jobs SET status = 'PROCESSING', attempts = attempts + 1,
            claimed_at = CURRENT_TIMESTAMP, error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND (status IN ('QUEUED','FAILED') OR (status = 'PROCESSING' AND datetime(claimed_at) <= datetime('now', '-5 minutes')))
        `).run(candidate.id);
        return changed.changes === 1 ? { ...candidate, attempts: Number(candidate.attempts) + 1 } : null;
      }).immediate();
      if (!job) return false;

      const response = await fetch(`${rendererUrl.replace(/\/$/, "")}/api/v1/package-label/render`, {
        method: "POST",
        headers: {
          Accept: "application/pdf",
          "Content-Type": "application/json",
          ...(rendererApiKey ? { "x-api-key": rendererApiKey } : {}),
        },
        body: JSON.stringify({
          template: JSON.parse(job.template_json),
          product: {
            packageCode: job.package_code,
            sku: job.sku_snapshot,
            urunAdi: job.product_name_snapshot,
            urunKodu: job.supplier_no_snapshot || "",
            supplierNo: job.supplier_no_snapshot || "",
            malzeme: job.material_snapshot || "",
            olcu: job.size_snapshot || "",
            partiLot: job.lot_number || "",
            paketIciAdet: String(job.planned_quantity),
            paketNo: String(job.package_number),
            toplamPaket: String(job.total_packages),
            urunAgirligi: String(job.unit_weight_g_snapshot || ""),
            kutuAgirligi: String(job.package_weight_kg_snapshot || ""),
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Label renderer HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const pdf = Buffer.from(await response.arrayBuffer());
      if (pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("Label renderer geçersiz PDF döndürdü.");
      if (!dryRun) {
        const directory = await mkdtemp(path.join(tmpdir(), "dsdst-label-"));
        const filePath = path.join(directory, `${job.package_code}.pdf`);
        try {
          await writeFile(filePath, pdf);
          await runLp(job.printer_name || defaultPrinter, filePath);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      db.transaction(() => {
        db.prepare("UPDATE print_jobs SET status = 'PRINTED', printed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.id);
        db.prepare(`
          UPDATE warehouse_packages SET status = CASE
              WHEN ? IN ('PLACED','OPEN','EMPTY') THEN ?
              WHEN status = 'LABEL_QUEUED' THEN 'LABELED'
              ELSE status END,
            labeled_at = CURRENT_TIMESTAMP, print_count = print_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(job.package_status_before, job.package_status_before, job.package_id);
      })();
      audit("WAREHOUSE_LABEL_PRINTED", job, { package_code: job.package_code, attempts: job.attempts, dry_run: dryRun });
      sessionEvent("LABEL_PRINTED", job, { package_code: job.package_code, attempts: job.attempts, dry_run: dryRun });
      logger.info(`[warehouse-print-worker] printed ${job.package_code}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : "Print failed";
      if (job?.id) {
        db.transaction(() => {
          db.prepare("UPDATE print_jobs SET status = 'FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(message, job.id);
          const current = db.prepare("SELECT attempts, max_attempts FROM print_jobs WHERE id = ?").get(job.id) as any;
          if (Number(current?.attempts) >= Number(current?.max_attempts)) {
            if (!["PLACED", "OPEN", "EMPTY"].includes(job.package_status_before)) {
              db.prepare("UPDATE warehouse_packages SET status = 'PRINT_FAILED', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'LABEL_QUEUED'").run(job.package_id);
            }
          }
        })();
        audit("WAREHOUSE_LABEL_PRINT_FAILED", job, { package_code: job.package_code, attempts: job.attempts, error: message });
        sessionEvent("LABEL_PRINT_FAILED", job, { package_code: job.package_code, attempts: job.attempts, error: message });
      }
      logger.error(`[warehouse-print-worker] ${message}`);
      return false;
    } finally {
      running = false;
    }
  };

  const timer = options.autoStart === false ? null : setInterval(() => void runOnce(), intervalMs);
  timer?.unref();
  if (options.autoStart !== false) void runOnce();
  return { stop: () => { if (timer) clearInterval(timer); }, runOnce };
}

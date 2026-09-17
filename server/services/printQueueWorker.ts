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

  const renderPdf = async (purpose: string, data: Record<string, unknown>) => {
    const response = await fetch(`${rendererUrl.replace(/\/$/, "")}/api/v1/render`, {
      method: "POST",
      headers: {
        Accept: "application/pdf",
        "Content-Type": "application/json",
        ...(rendererApiKey ? { "x-api-key": rendererApiKey } : {}),
      },
      body: JSON.stringify({ purpose, data }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Label renderer HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("Label renderer geçersiz PDF döndürdü.");
    return pdf;
  };

  const submitPdf = async (pdf: Buffer, labelCode: string, printerName?: string | null) => {
    if (dryRun) return;
    const directory = await mkdtemp(path.join(tmpdir(), "dsdst-label-"));
    const safeCode = labelCode.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 100) || "label";
    const filePath = path.join(directory, `${safeCode}.pdf`);
    try {
      await writeFile(filePath, pdf);
      await runLp(printerName || defaultPrinter, filePath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

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
    let purposeJob: any;
    try {
      job = db.transaction(() => {
        const candidate = db.prepare(`
          SELECT j.*, p.package_code, p.package_number, p.total_packages, p.planned_quantity,
                 l.sku_snapshot, l.product_name_snapshot, l.lot_number, l.supplier_no_snapshot,
                 l.material_snapshot, l.form_snapshot, l.series_snapshot, l.size_snapshot, l.unit_weight_g_snapshot,
                 l.package_weight_kg_snapshot
          FROM print_jobs j
          JOIN warehouse_packages p ON p.id = j.package_id
          JOIN inbound_batch_lines l ON l.id = p.batch_line_id
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
      if (!job) {
        purposeJob = db.transaction(() => {
          const candidate = db.prepare(`
            SELECT * FROM label_print_jobs
            WHERE (status IN ('QUEUED','FAILED') OR (status = 'PROCESSING' AND datetime(claimed_at) <= datetime('now', '-5 minutes')))
              AND attempts < max_attempts
            ORDER BY datetime(created_at), id LIMIT 1
          `).get() as any;
          if (!candidate) return null;
          const changed = db.prepare(`
            UPDATE label_print_jobs SET status = 'PROCESSING', attempts = attempts + 1,
              claimed_at = CURRENT_TIMESTAMP, error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND (status IN ('QUEUED','FAILED') OR (status = 'PROCESSING' AND datetime(claimed_at) <= datetime('now', '-5 minutes')))
          `).run(candidate.id);
          return changed.changes === 1 ? { ...candidate, attempts: Number(candidate.attempts) + 1 } : null;
        }).immediate();
        if (!purposeJob) return false;
        const payload = JSON.parse(purposeJob.payload_json) as Record<string, unknown>;
        const pdf = await renderPdf(purposeJob.purpose, payload);
        await submitPdf(pdf, purposeJob.label_code, purposeJob.printer_name);
        db.prepare("UPDATE label_print_jobs SET status = 'PRINTED', printed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(purposeJob.id);
        logger.info(`[warehouse-print-worker] printed ${purposeJob.purpose}:${purposeJob.label_code}`);
        return true;
      }

      const pdf = await renderPdf("goods_receipt", {
        Package_code: job.package_code,
        SKU: job.sku_snapshot,
        Urun_adi: job.product_name_snapshot,
        Urun_kodu: job.supplier_no_snapshot || "",
        Supplier_no: job.supplier_no_snapshot || "",
        Malzeme: job.material_snapshot || "",
        Tip: job.form_snapshot || job.series_snapshot || "",
        Olcu: job.size_snapshot || "",
        Parti_Lot: job.lot_number || "",
        Paket_ici_adet: String(job.planned_quantity),
        Paket_no: `${job.package_number} / ${job.total_packages}`,
        Toplam_paket: String(job.total_packages),
        Stok_sayisi: String(Number(job.planned_quantity || 0) * Number(job.total_packages || 0)),
        Urun_agirligi: job.unit_weight_g_snapshot ? `${job.unit_weight_g_snapshot} g` : "",
        Kutu_agirligi: job.package_weight_kg_snapshot ? `${job.package_weight_kg_snapshot} kg` : "",
      });
      await submitPdf(pdf, job.package_code, job.printer_name);
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
      if (purposeJob?.id) {
        db.prepare("UPDATE label_print_jobs SET status = 'FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(message, purposeJob.id);
        logger.error(`[warehouse-print-worker] ${purposeJob.purpose}:${purposeJob.label_code} ${message}`);
      } else if (job?.id) {
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

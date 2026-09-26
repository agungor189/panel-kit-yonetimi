import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { importProductsFromCsvRows } from "../services/productCsvImport.js";

type Dependencies = {
  db: Database.Database;
  authorize: RequestHandler;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || "").trim();

export function createProductCsvImportRouter({ db, authorize }: Dependencies) {
  const router = express.Router();
  const commands = new CommandExecutor(db);

  router.use(authorize);

  router.post("/", (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
      const headers = Array.isArray(req.body?.headers) ? req.body.headers.map(String) : null;
      if (!rows || !headers) {
        return res.status(400).json({ error: "rows ve headers alanları zorunludur." });
      }

      const dryRun = req.body?.dry_run !== false;
      const sourceName = String(req.body?.source_name || "").trim() || "products.csv";
      const sourceHash = createHash("sha256").update(JSON.stringify({ headers, rows })).digest("hex");
      const importOptions = {
        apply: !dryRun,
        actorUsername: req.user?.username || "product-csv-import",
        sourceName,
        sourceHash,
      };

      // Preview is deliberately outside the command foundation: it validates
      // against current catalog state without creating any database record.
      if (dryRun) {
        return res.json(importProductsFromCsvRows(db, rows, headers, importOptions));
      }

      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "catalog.product.csv-import.v1",
        payload: { headers, rows, source_name: sourceName },
        actor: { human: { id: req.user!.id, name: req.user!.username } },
        authorization: { decision: "ALLOW", capability: "panel:write" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, () => {
        const report = importProductsFromCsvRows(db, rows, headers, importOptions);
        return {
          statusCode: report.validation_errors.length > 0 ? 422 : 200,
          body: report as any,
        };
      });

      return res.status(outcome.result.statusCode).json({
        ...outcome.result.body,
        idempotent: outcome.replayed,
      });
    } catch (error) {
      if (error instanceof CommandFoundationError) {
        return res.status(error.statusCode).json({
          success: false,
          error: { code: error.code, message: error.message },
        });
      }
      const message = error instanceof Error ? error.message : "Product CSV import failed.";
      return res.status(400).json({ error: message });
    }
  });

  return router;
}

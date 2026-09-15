/**
 * Product master CSV importer. Dry-run is the default.
 *
 *   npm run warehouse-import:dry-run -- --csv /path/to/products.csv
 *   ALLOW_WAREHOUSE_IMPORT=true npm run warehouse-import:dry-run -- --csv /path/to/products.csv --apply
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Papa from "papaparse";
import { applySchema } from "../server/db/schema.js";
import { runMigrations } from "../server/migrations/runner.js";
import { importProductsFromCsvRows } from "../server/services/productCsvImport.js";

type CsvRecord = Record<string, string>;

const optionValue = (name: string): string | null => {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
};

const apply = process.argv.includes("--apply");
const csvArgument = optionValue("--csv");
const dbArgument = optionValue("--db");

if (!csvArgument) {
  console.error("Usage: npm run warehouse-import:dry-run -- --csv /path/to/products.csv [--db /path/to/dsdst_panel.db] [--apply]");
  process.exit(1);
}
if (apply && process.env.ALLOW_WAREHOUSE_IMPORT !== "true") {
  console.error("Apply blocked: --apply also requires ALLOW_WAREHOUSE_IMPORT=true.");
  process.exit(1);
}

const csvPath = path.resolve(csvArgument);
const dbPath = path.resolve(dbArgument || process.env.DB_PATH || path.join(process.cwd(), "dsdst_panel.db"));
if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

const csvText = fs.readFileSync(csvPath, "utf8");
const parsed = Papa.parse<CsvRecord>(csvText, { header: true, skipEmptyLines: "greedy" });
if (parsed.errors.length > 0) {
  console.error(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    applied: false,
    validation_errors: parsed.errors.map((error) => ({
      row: typeof error.row === "number" ? error.row + 1 : undefined,
      field: "csv",
      code: error.code,
      message: error.message,
    })),
  }, null, 2));
  process.exit(2);
}

const db = new Database(dbPath, { readonly: !apply });
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
if (apply) {
  applySchema(db);
  runMigrations(db);
}

try {
  const report = importProductsFromCsvRows(db, parsed.data, parsed.meta.fields || [], {
    apply,
    actorUsername: "warehouse-import-script",
    sourceName: path.basename(csvPath),
    sourceHash: crypto.createHash("sha256").update(csvText).digest("hex"),
  });
  const output = JSON.stringify(report, null, 2);
  if (report.validation_errors.length > 0) console.error(output);
  else console.log(output);
  process.exitCode = report.validation_errors.length > 0 ? 2 : 0;
} finally {
  db.close();
}

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runMigrations } from "../server/migrations/runner.js";
import { parseLegacyWarehouseLayout } from "../server/services/warehouseLayout.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Kullanım: npm run warehouse-layout:import -- /tam/yol/depo-plani.json");
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "dsdst_panel.db");
const db = new Database(dbPath);
try {
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const raw = JSON.parse(fs.readFileSync(path.resolve(sourcePath), "utf8"));
  const layout = parseLegacyWarehouseLayout(raw);
  const actor = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  const result = db.transaction(() => {
    const current = db.prepare("SELECT layout_version FROM warehouse_layouts WHERE active = 1").get() as { layout_version: number } | undefined;
    const version = Number(current?.layout_version || 0) + 1;
    const id = randomUUID();
    db.prepare("UPDATE warehouse_layouts SET active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE active = 1").run(actor?.id || null);
    db.prepare(`INSERT INTO warehouse_layouts (id, name, layout_version, layout_json, active, created_by, updated_by)
      VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(id, layout.warehouse.name, version, JSON.stringify(layout), actor?.id || null, actor?.id || null);
    return { id, version };
  })();
  console.log(`Depo planı import edildi: ${layout.objects.length} fiziksel obje, sürüm ${result.version}, id ${result.id}`);
} finally {
  db.close();
}

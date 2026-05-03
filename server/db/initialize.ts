import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";
import { generateNormalizedFields } from "../utils/normalizeProductFields.js";
import { applySchema } from "./schema.js";
import { applySeed } from "./seed.js";

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function initializeDatabase(db: Database.Database): void {
  applySchema(db);
  runMigrations(db);
  backfillNormalizedProductFields(db);
  applySeed(db);
}

function backfillNormalizedProductFields(db: Database.Database): void {
  try {
    const unnormalizedProducts = db.prepare(`
      SELECT id, material, model, size, pipe_size, category, name
      FROM products
      WHERE normalized_material IS NULL OR normalized_pipe_size IS NULL
    `).all() as any[];

    if (unnormalizedProducts.length === 0) return;

    const updateProduct = db.prepare(`
      UPDATE products
      SET normalized_material=?,
          normalized_model=?,
          normalized_size=?,
          normalized_tube_type=?,
          normalized_pipe_size=?
      WHERE id=?
    `);

    db.transaction(() => {
      for (const product of unnormalizedProducts) {
        const fields = generateNormalizedFields(product);
        updateProduct.run(
          fields.normalized_material,
          fields.normalized_model,
          fields.normalized_size,
          fields.normalized_tube_type,
          fields.normalized_pipe_size,
          product.id
        );
      }
    })();

    console.log(`[DB] Backfilled normalized fields for ${unnormalizedProducts.length} product(s).`);
  } catch (err) {
    console.error("[DB] Normalized field backfill failed:", err);
  }
}

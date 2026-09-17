import type Database from "better-sqlite3";

export function createActiveExchangeRateReader(db: Database.Database) {
  return () => {
    const row = db.prepare(`
      SELECT rate
      FROM exchange_rates
      WHERE is_active = 1
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get() as { rate?: number } | undefined;
    return row?.rate || 0;
  };
}


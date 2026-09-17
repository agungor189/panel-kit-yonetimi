import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { createActiveExchangeRateReader } from "./exchangeRates.js";

test("finance module reads only the latest active exchange rate", () => {
  const db = new Database(":memory:");
  applySchema(db);
  const getActiveRate = createActiveExchangeRateReader(db);
  assert.equal(getActiveRate(), 0);
  db.prepare("INSERT INTO exchange_rates (id, base_currency, target_currency, rate, fetched_at, is_active) VALUES ('old', 'USD', 'TRY', 30, '2026-01-01', 1), ('new', 'USD', 'TRY', 40, '2026-02-01', 1), ('inactive', 'USD', 'TRY', 99, '2026-03-01', 0)").run();
  assert.equal(getActiveRate(), 40);
  db.close();
});


import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { applySchema } from "../../db/schema.js";
import { runMigrations } from "../../migrations/runner.js";
import { createActiveExchangeRateReader, ExchangeRateService } from "./exchangeRates.js";

test("finance module reads only the latest active exchange rate", () => {
  const db = new Database(":memory:");
  applySchema(db);
  const getActiveRate = createActiveExchangeRateReader(db);
  assert.equal(getActiveRate(), 0);
  db.prepare("INSERT INTO exchange_rates (id, base_currency, target_currency, rate, fetched_at, is_active) VALUES ('old', 'USD', 'TRY', 30, '2026-01-01', 1), ('new', 'USD', 'TRY', 40, '2026-02-01', 1), ('inactive', 'USD', 'TRY', 99, '2026-03-01', 0)").run();
  assert.equal(getActiveRate(), 40);
  db.close();
});

test("supported legacy upgrade preserves the active USD/TRY display rate as a rational current observation", () => {
  const db = new Database(":memory:");
  db.exec(fs.readFileSync(fileURLToPath(new URL("../../db/fixtures/panel-v53.sql", import.meta.url)), "utf8"));
  db.prepare(`INSERT INTO exchange_rates (id,base_currency,target_currency,rate,source,fetched_at,is_active)
    VALUES ('legacy-active','USD','TRY',40.25,'TCMB','2026-09-19T12:00:00.000Z',1)`).run();
  runMigrations(db);
  const current = new ExchangeRateService(db).getCurrentUsdTry();
  assert.equal(current?.numerator, 40_250_000);
  assert.equal(current?.denominator, 1_000_000);
  assert.equal(current?.source, "TCMB");
  assert.equal(db.prepare("SELECT actor_id FROM fx_rate_observations").pluck().get(), "system:legacy-fx-migration");
  db.close();
});

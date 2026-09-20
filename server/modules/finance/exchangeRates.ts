import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseDecimalRational, type Rational } from "./money.js";

export type FxSnapshot = Rational & {
  observationId: string | null;
  source: string;
  observedAt: string;
  direction: "USD_TO_TRY" | "TRY_TO_TRY";
};

export class ExchangeRateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeRateValidationError";
  }
}

const requiredText = (value: unknown, field: string, max = 200) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new ExchangeRateValidationError(`${field} is invalid.`);
  return text;
};

const isoTimestamp = (value: unknown, field: string) => {
  const text = requiredText(value, field, 50);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ExchangeRateValidationError(`${field} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
};

export class ExchangeRateService {
  constructor(private readonly db: Database.Database) {}

  recordCurrentUsdTry(input: { rate: string | number; source: string; changedAt: string; actorId: string; actorType?: "HUMAN" | "SYSTEM" }): FxSnapshot {
    const rate = parseDecimalRational(input.rate, "rate", 8);
    const source = requiredText(input.source, "source", 120);
    const observedAt = isoTimestamp(input.changedAt, "changedAt");
    const actorId = requiredText(input.actorId, "actorId");
    const actorType = input.actorType || "HUMAN";
    const observationId = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO fx_rate_observations
        (id,base_currency,quote_currency,rate_numerator,rate_denominator,source,observed_at,actor_id,actor_type)
        VALUES (?, 'USD', 'TRY', ?, ?, ?, ?, ?, ?)`)
        .run(observationId, rate.numerator, rate.denominator, source, observedAt, actorId, actorType);
      this.db.prepare(`INSERT INTO fx_current_rates (pair_key,observation_id,changed_at,changed_by)
        VALUES ('USD/TRY',?,?,?) ON CONFLICT(pair_key) DO UPDATE SET
          observation_id=excluded.observation_id,changed_at=excluded.changed_at,changed_by=excluded.changed_by`)
        .run(observationId, observedAt, actorId);
      // Compatibility projection for existing display/simulation paths. V2-06
      // accounting calculations never read the REAL value below.
      this.db.prepare("UPDATE exchange_rates SET is_active=0 WHERE base_currency='USD' AND target_currency='TRY' AND is_active=1").run();
      this.db.prepare(`INSERT INTO exchange_rates (id,base_currency,target_currency,rate,source,fetched_at,is_active)
        VALUES (?, 'USD', 'TRY', ?, ?, ?, 1)`)
        .run(`v2-fx:${observationId}`, rate.numerator / rate.denominator, source, observedAt);
    }).immediate();
    return { observationId, ...rate, source, observedAt, direction: "USD_TO_TRY" };
  }

  getCurrentUsdTry(): FxSnapshot | null {
    const row = this.db.prepare(`SELECT o.id,o.rate_numerator,o.rate_denominator,o.source,o.observed_at
      FROM fx_current_rates c JOIN fx_rate_observations o ON o.id=c.observation_id
      WHERE c.pair_key='USD/TRY'`).get() as any;
    return row ? {
      observationId: row.id,
      numerator: Number(row.rate_numerator),
      denominator: Number(row.rate_denominator),
      source: row.source,
      observedAt: row.observed_at,
      direction: "USD_TO_TRY",
    } : null;
  }

  snapshotFor(currency: string, at = new Date().toISOString()): FxSnapshot {
    if (currency === "TRY") return { observationId: null, numerator: 1, denominator: 1, source: "BASE_CURRENCY", observedAt: at, direction: "TRY_TO_TRY" };
    if (currency !== "USD") throw new ExchangeRateValidationError(`No accepted ${currency}/TRY FX source is configured.`);
    const current = this.getCurrentUsdTry();
    if (!current) throw new ExchangeRateValidationError("Current USD/TRY rate is required before a USD purchase can be created.");
    return current;
  }
}

export function createActiveExchangeRateReader(db: Database.Database) {
  return () => {
    const current = new ExchangeRateService(db).getCurrentUsdTry();
    if (current) return current.numerator / current.denominator;
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

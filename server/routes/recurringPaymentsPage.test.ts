import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import RecurringPayments from "../../src/components/RecurringPayments.js";
import type { Settings } from "../../src/types.js";
import { createRecurringPaymentsRouter } from "./recurringPaymentsRoutes.js";

test("Periyodikler renders when legacy settings omit expense categories", () => {
  assert.doesNotThrow(() => {
    renderToString(createElement(RecurringPayments, { settings: {} as Settings }));
  });
});

test("recurring payment calendar GET generates a missing occurrence once", async () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE recurring_payment_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      payment_type TEXT,
      amount REAL,
      currency TEXT,
      amount_try REAL,
      exchange_rate REAL,
      due_day INTEGER,
      due_month INTEGER,
      start_month INTEGER,
      week_day INTEGER,
      custom_interval_days INTEGER,
      frequency TEXT,
      start_date TEXT,
      end_date TEXT,
      auto_process INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE recurring_payment_occurrences (
      id TEXT PRIMARY KEY,
      recurring_payment_id TEXT,
      due_date TEXT,
      amount REAL,
      currency TEXT,
      exchange_rate REAL,
      amount_try REAL,
      status TEXT,
      UNIQUE(recurring_payment_id, due_date)
    );
  `);
  db.prepare(`
    INSERT INTO recurring_payment_plans (
      id, title, category, payment_type, amount, currency, amount_try,
      exchange_rate, due_day, frequency, start_date, auto_process, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("rent", "Rent", "Rent", "expense", 100, "TRY", 100, 1, 15, "monthly", "2026-01-01", 0, 1);

  const app = express();
  app.use("/api/recurring-payments", createRecurringPaymentsRouter(db));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const plans = await fetch(`http://127.0.0.1:${address.port}/api/recurring-payments`);
    assert.equal(plans.status, 200);
    assert.equal((await plans.json() as unknown[]).length, 1);

    for (let request = 0; request < 2; request += 1) {
      const calendar = await fetch(`http://127.0.0.1:${address.port}/api/recurring-payments/calendar?month=2026-09`);
      assert.equal(calendar.status, 200);
      assert.equal((await calendar.json() as unknown[]).length, 1);
    }

    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM recurring_payment_occurrences").get() as { count: number }).count,
      1,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});

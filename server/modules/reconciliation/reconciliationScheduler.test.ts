import assert from "node:assert/strict";
import test from "node:test";
import { nextDailyReconciliationAt } from "./reconciliationScheduler.js";

test("daily reconciliation is fixed to 03:00 Europe/Istanbul independent of process timezone", () => {
  assert.equal(nextDailyReconciliationAt(new Date("2026-09-22T23:59:59Z")).toISOString(), "2026-09-23T00:00:00.000Z");
  assert.equal(nextDailyReconciliationAt(new Date("2026-09-23T00:00:00Z")).toISOString(), "2026-09-24T00:00:00.000Z");
  assert.equal(nextDailyReconciliationAt(new Date("2026-09-23T00:00:01Z")).toISOString(), "2026-09-24T00:00:00.000Z");
  assert.equal(nextDailyReconciliationAt(new Date("2026-09-23T00:30:00Z"), "Europe/London").toISOString(), "2026-09-23T02:00:00.000Z");
});

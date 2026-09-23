import assert from "node:assert/strict";
import test from "node:test";
import { nextDailyReconciliationAt } from "./reconciliationScheduler.js";

test("daily reconciliation is scheduled for local 03:00 and rolls to the next day after cutoff", () => {
  const before = new Date(2026, 8, 23, 2, 59, 59);
  const sameDay = nextDailyReconciliationAt(before);
  assert.equal(sameDay.getFullYear(), 2026);
  assert.equal(sameDay.getMonth(), 8);
  assert.equal(sameDay.getDate(), 23);
  assert.equal(sameDay.getHours(), 3);
  assert.equal(sameDay.getMinutes(), 0);

  const after = new Date(2026, 8, 23, 3, 0, 1);
  const nextDay = nextDailyReconciliationAt(after);
  assert.equal(nextDay.getDate(), 24);
  assert.equal(nextDay.getHours(), 3);
  assert.equal(nextDay.getMinutes(), 0);
});

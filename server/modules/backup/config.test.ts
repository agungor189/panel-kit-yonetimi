import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_BACKUP_CONFIG, normalizeBackupConfig } from "./config.js";

test("backup config keeps safe bounds and defaults", () => {
  assert.deepEqual(normalizeBackupConfig(null), DEFAULT_BACKUP_CONFIG);
  assert.deepEqual(normalizeBackupConfig({
    enabled: false,
    run_at: "99:99",
    retention_days: 999,
    include_uploads: false,
    uploads_strategy: "unsafe",
    weekly_full_day: -5,
  }), {
    enabled: false,
    run_at: "03:00",
    retention_days: 30,
    include_uploads: false,
    uploads_strategy: "smart",
    weekly_full_day: 0,
  });
});


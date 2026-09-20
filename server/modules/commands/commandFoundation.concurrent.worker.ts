import Database from "better-sqlite3";
import { CommandExecutor } from "./commandFoundation.js";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("database path is required");

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

try {
  const executor = new CommandExecutor(db);
  const outcome = executor.execute({
    operationId: "concurrent-operation",
    commandType: "test.counter.concurrent.v1",
    payload: { amount: 1 },
    actor: {
      human: { id: "user-concurrent", name: "Concurrent User" },
      service: { id: "worker-service", name: "Worker Service" },
    },
    authorization: { decision: "ALLOW", capability: "test:increment" },
    correlationId: "corr-concurrent",
    requestId: "req-concurrent",
  }, () => {
    db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    return { statusCode: 200, body: { ok: true, committed: "one-result" } };
  });
  process.stdout.write(JSON.stringify(outcome));
} finally {
  db.close();
}

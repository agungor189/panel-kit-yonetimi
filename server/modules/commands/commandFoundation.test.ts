import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import {
  canonicalPayloadHash,
  CommandExecutor,
  CommandFoundationError,
  OperationConflictError,
} from "./commandFoundation.js";

const actor = {
  human: { id: "user-1", name: "Ayse Operator" },
  service: { id: "warehouse-service", name: "Warehouse BFF" },
};

const command = (operationId: string, payload: Record<string, unknown> = { amount: 1 }) => ({
  operationId,
  commandType: "test.counter.increment.v1",
  payload,
  actor,
  authorization: { decision: "ALLOW" as const, capability: "test:increment" },
  correlationId: "corr-1",
  requestId: "req-1",
  requestMetadata: { channel: "test" },
});

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  db.exec("CREATE TABLE command_test_effects (id TEXT PRIMARY KEY, effect_count INTEGER NOT NULL)");
  db.prepare("INSERT INTO command_test_effects (id, effect_count) VALUES ('counter', 0)").run();
  return { db, executor: new CommandExecutor(db) };
};

const count = (db: Database.Database, table: string) => Number(
  db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
);

test("canonical payload hashing is stable across object key order and rejects non-JSON numbers", () => {
  assert.equal(
    canonicalPayloadHash({ z: [3, { b: true, a: null }], a: "value" }),
    canonicalPayloadHash({ a: "value", z: [3, { a: null, b: true }] }),
  );
  assert.throws(() => canonicalPayloadHash({ amount: Number.NaN }), /finite JSON number/);
  assert.throws(() => canonicalPayloadHash({ missing: undefined }), /JSON-compatible/);
  assert.throws(() => canonicalPayloadHash(new Array(1)), /JSON-compatible/);
});

test("same operation and canonical payload creates one effect and replays the exact committed result", () => {
  const { db, executor } = setup();
  let executions = 0;
  const first = executor.execute(command("op-replay", { b: 2, a: 1 }), () => {
    executions += 1;
    db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
    return { statusCode: 201, body: { ok: true, nested: { id: "result-1", values: [1, 2] } } };
  });
  const replay = executor.execute(command("op-replay", { a: 1, b: 2 }), () => {
    executions += 1;
    return { statusCode: 500, body: { ok: false } };
  });

  assert.equal(executions, 1);
  assert.equal(db.prepare("SELECT effect_count FROM command_test_effects WHERE id = 'counter'").pluck().get(), 1);
  assert.deepEqual(replay.result, first.result);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(count(db, "command_operations"), 1);
  assert.equal(count(db, "command_audit_log"), 1);
  db.close();
});

test("same scoped key with a different payload conflicts without a second effect", () => {
  const { db, executor } = setup();
  executor.execute(command("op-conflict", { amount: 1 }), () => {
    db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
    return { statusCode: 200, body: { effect: 1 } };
  });

  assert.throws(
    () => executor.execute(command("op-conflict", { amount: 2 }), () => {
      db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
      return { statusCode: 200, body: { effect: 2 } };
    }),
    (error: unknown) => error instanceof OperationConflictError && error.statusCode === 409,
  );
  assert.equal(db.prepare("SELECT effect_count FROM command_test_effects WHERE id = 'counter'").pluck().get(), 1);
  assert.equal(count(db, "command_operations"), 1);
  assert.equal(count(db, "command_audit_log"), 1);
  db.close();
});

test("a command without an explicit allow decision fails before the handler", () => {
  const { db, executor } = setup();
  let called = false;
  const denied = { ...command("op-denied"), authorization: { decision: "DENY", capability: "test:increment" } };
  assert.throws(
    () => executor.execute(denied as any, () => {
      called = true;
      return { statusCode: 200, body: { ok: true } };
    }),
    (error: unknown) => error instanceof CommandFoundationError
      && error.statusCode === 403
      && error.code === "AUTHORIZATION_REQUIRED",
  );
  assert.equal(called, false);
  assert.equal(count(db, "command_operations"), 0);
  db.close();
});

test("transaction failure leaves no state, operation, audit or outbox and a retry commits once", () => {
  const { db, executor } = setup();
  let attempts = 0;
  assert.throws(() => executor.execute(command("op-retry"), (context) => {
    attempts += 1;
    db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
    context.addOutbox({
      topic: "test-effects",
      eventType: "test.effect.created.v1",
      aggregateType: "test_counter",
      aggregateId: "counter",
      payload: { counter: "counter", value: 1 },
    });
    throw new Error("simulated crash before commit");
  }), /simulated crash/);

  assert.equal(attempts, 1);
  assert.equal(db.prepare("SELECT effect_count FROM command_test_effects WHERE id = 'counter'").pluck().get(), 0);
  assert.equal(count(db, "command_operations"), 0);
  assert.equal(count(db, "command_audit_log"), 0);
  assert.equal(count(db, "command_outbox"), 0);

  const committed = executor.execute(command("op-retry"), (context) => {
    attempts += 1;
    db.prepare("UPDATE command_test_effects SET effect_count = effect_count + 1 WHERE id = 'counter'").run();
    context.addOutbox({
      topic: "test-effects",
      eventType: "test.effect.created.v1",
      aggregateType: "test_counter",
      aggregateId: "counter",
      payload: { counter: "counter", value: 1 },
    });
    return { statusCode: 202, body: { accepted: true } };
  });
  const replay = executor.execute(command("op-retry"), () => {
    throw new Error("replay must not execute the handler");
  });

  assert.equal(attempts, 2);
  assert.equal(db.prepare("SELECT effect_count FROM command_test_effects WHERE id = 'counter'").pluck().get(), 1);
  assert.deepEqual(replay.result, committed.result);
  assert.equal(count(db, "command_operations"), 1);
  assert.equal(count(db, "command_audit_log"), 1);
  assert.equal(count(db, "command_outbox"), 1);
  db.close();
});

test("audit stores separate human and service actors with bounded request metadata", () => {
  const { db, executor } = setup();
  executor.execute(command("op-audit", { secret_not_in_payload: "redacted-by-caller" }), () => ({
    statusCode: 200,
    body: { ok: true },
  }));

  const row = db.prepare(`SELECT operation_id, human_actor_id, human_actor_name,
    service_actor_id, service_actor_name, command_type, authorization_decision,
    capability, correlation_id, request_id, request_metadata_json, payload_hash,
    result_status_code FROM command_audit_log`).get() as Record<string, unknown>;
  assert.deepEqual(row, {
    operation_id: "op-audit",
    human_actor_id: "user-1",
    human_actor_name: "Ayse Operator",
    service_actor_id: "warehouse-service",
    service_actor_name: "Warehouse BFF",
    command_type: "test.counter.increment.v1",
    authorization_decision: "ALLOW",
    capability: "test:increment",
    correlation_id: "corr-1",
    request_id: "req-1",
    request_metadata_json: '{"channel":"test"}',
    payload_hash: canonicalPayloadHash({ secret_not_in_payload: "redacted-by-caller" }),
    result_status_code: 200,
  });
  db.close();
});

test("committed operation/audit and outbox payload are immutable while delivery state can advance", () => {
  const { db, executor } = setup();
  executor.execute(command("op-immutable"), (context) => {
    context.addOutbox({ topic: "test", eventType: "test.created.v1", payload: { value: 1 } });
    return { statusCode: 200, body: { ok: true } };
  });

  assert.throws(() => db.prepare("UPDATE command_operations SET result_status_code = 201").run(), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM command_audit_log").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE command_outbox SET payload_json = '{}' ").run(), /immutable/);
  db.prepare(`UPDATE command_outbox
    SET status = 'DELIVERED', attempt_count = 1, delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`).run();
  assert.deepEqual(
    db.prepare("SELECT status, attempt_count FROM command_outbox").get(),
    { status: "DELIVERED", attempt_count: 1 },
  );
  db.close();
});

test("concurrent processes using the same operation commit one effect and replay one result", async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-command-concurrency-"));
  const databasePath = path.join(temporaryDirectory, "panel.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initializeDatabase(db);
  db.exec("CREATE TABLE command_test_effects (id TEXT PRIMARY KEY, effect_count INTEGER NOT NULL)");
  db.prepare("INSERT INTO command_test_effects (id, effect_count) VALUES ('counter', 0)").run();
  db.close();

  const workerPath = new URL("./commandFoundation.concurrent.worker.ts", import.meta.url).pathname;
  const runWorker = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, databasePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${stderr}`));
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
    });
  });

  try {
    const [left, right] = await Promise.all([runWorker(), runWorker()]);
    assert.deepEqual(left.result, right.result);
    assert.deepEqual([left.replayed, right.replayed].sort(), [false, true]);
    const verified = new Database(databasePath, { readonly: true });
    assert.equal(verified.prepare("SELECT effect_count FROM command_test_effects WHERE id = 'counter'").pluck().get(), 1);
    assert.equal(count(verified, "command_operations"), 1);
    assert.equal(count(verified, "command_audit_log"), 1);
    verified.close();
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

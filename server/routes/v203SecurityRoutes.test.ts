import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import bcrypt from "bcrypt";
import Database from "better-sqlite3";
import { initializeDatabase } from "../db/initialize.js";
import { createApiKeyHasher } from "../modules/integrations/apiKeys.js";

const JWT_SECRET = "v2-03-route-test-jwt-secret-000000000000";
const HASH_SECRET = "v2-03-route-test-hash-secret-00000000000";
const ENCRYPTION_SECRET = "v2-03-route-test-encryption-secret-000000";
const SERVICE_KEY = "v2-03-route-service-expense-key";
let directory = "";
let dbPath = "";
let baseUrl = "";
let child: ChildProcess | undefined;
let childOutput = "";

type Session = { cookie?: string; bearer?: string; body: any };

const freePort = async () => new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const authHeaders = (session: Session, unsafe = false, origin = baseUrl) => ({
  ...(session.cookie ? { cookie: session.cookie } : {}),
  ...(session.bearer ? { authorization: `Bearer ${session.bearer}` } : {}),
  ...(unsafe ? { origin } : {}),
});

const login = async (username: string, password: string): Promise<Session> => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  const setCookie = response.headers.get("set-cookie") || "";
  return {
    cookie: setCookie ? setCookie.split(";", 1)[0] : undefined,
    bearer: typeof body.token === "string" ? body.token : undefined,
    body,
  };
};

const request = (pathName: string, session: Session, init: RequestInit = {}) => fetch(`${baseUrl}${pathName}`, {
  ...init,
  headers: { ...authHeaders(session, !["GET", "HEAD"].includes(init.method || "GET")), ...init.headers },
});

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dsdst-v203-routes-"));
  dbPath = path.join(directory, "panel.db");
  const db = new Database(dbPath);
  initializeDatabase(db);
  const insertUser = db.prepare(`
    INSERT INTO users (id, username, password_hash, role, permissions, must_change_password, is_active)
    VALUES (?, ?, ?, ?, ?, 0, 1)
  `);
  insertUser.run("admin", "admin", bcrypt.hashSync("admin-password", 4), "admin", "{}");
  insertUser.run("operator", "operator", bcrypt.hashSync("operator-password", 4), "user", JSON.stringify({ "panel:read": true, "panel:write": true, "finance:write": true }));
  insertUser.run("specialist", "specialist", bcrypt.hashSync("specialist-password", 4), "user", JSON.stringify({
    "panel:read": true, "panel:write": true, "integrations:admin": true, "backup:admin": true,
  }));
  db.prepare("INSERT INTO cash_accounts (id, name, currency, type, is_active) VALUES ('cash-1', 'Test Cash', 'TRY', 'cash', 1)").run();
  db.prepare("INSERT INTO exchange_rates (id, base_currency, target_currency, rate, source, is_active) VALUES ('rate-1', 'USD', 'TRY', 40, 'fixture', 1)").run();
  const hashApiKey = createApiKeyHasher(HASH_SECRET);
  db.prepare(`INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, status, permissions)
    VALUES ('expense-service', 'Expense service', 'expense', ?, 'test', 'active', ?)`)
    .run(hashApiKey(SERVICE_KEY), JSON.stringify(["expenses:write"]));
  db.close();

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DB_PATH: dbPath,
      BACKUP_DIR: path.join(directory, "backups"),
      JWT_SECRET,
      PANEL_API_HASH_SECRET: HASH_SECRET,
      ENCRYPTION_SECRET,
      ALLOWED_ORIGINS: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr?.on("data", (chunk) => { childOutput += String(chunk); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) assert.fail(`Panel test server exited early:\n${childOutput}`);
    try {
      if ((await fetch(`${baseUrl}/api/public/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Panel test server did not become healthy:\n${childOutput}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("Panel login uses an HttpOnly cookie and returns no browser-readable token", async () => {
  const session = await login("operator", "operator-password");
  assert.ok(session.cookie, "login must set a session cookie");
  assert.equal(session.body.token, undefined, "login JSON must not expose the session token");
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ username: "operator", password: "operator-password" }),
  });
  assert.match(response.headers.get("set-cookie") || "", /HttpOnly/i);
  assert.match(response.headers.get("set-cookie") || "", /SameSite=Strict/i);
  assert.match(response.headers.get("set-cookie") || "", /Secure/i);
});

test("real password reset, disable and authority-update routes revoke the old session", async () => {
  const admin = await login("admin", "admin-password");
  const beforeReset = await login("operator", "operator-password");
  assert.equal((await request("/api/users/operator/reset-password", admin, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "operator-password-2", must_change_password: false }),
  })).status, 200);
  assert.equal((await request("/api/auth/me", beforeReset)).status, 401);

  const beforeDisable = await login("operator", "operator-password-2");
  assert.equal((await request("/api/users/operator", admin, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ is_active: false }),
  })).status, 200);
  assert.equal((await request("/api/auth/me", beforeDisable)).status, 401);
  assert.equal((await request("/api/users/operator", admin, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ is_active: true }),
  })).status, 200);

  const beforeAuthorityChange = await login("operator", "operator-password-2");
  assert.equal((await request("/api/users/operator", admin, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "readonly", permissions: { "panel:read": true } }),
  })).status, 200);
  assert.equal((await request("/api/auth/me", beforeAuthorityChange)).status, 401);
  assert.equal((await request("/api/users/operator", admin, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "user", permissions: { "panel:read": true, "panel:write": true, "finance:write": true } }),
  })).status, 200);
});

test("high-impact routes honor their named capabilities instead of role name", async () => {
  const specialist = await login("specialist", "specialist-password");
  assert.equal((await request("/api/backup/status", specialist)).status, 200);
  assert.equal((await request("/api/integrations/trendyol/status", specialist)).status, 200);
});

test("generic service-only expense is denied, while human expense records an audit actor", async () => {
  const serviceOnly = await fetch(`${baseUrl}/api/public/expenses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": SERVICE_KEY },
    body: JSON.stringify({ amount: 10, cash_account_id: "cash-1", category: "Test" }),
  });
  assert.equal(serviceOnly.status, 403);

  const operator = await login("operator", "operator-password-2");
  const human = await request("/api/expenses", operator, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: 25, cash_account_id: "cash-1", category: "Human test", currency: "TRY" }),
  });
  assert.equal(human.status, 200);
  const body = await human.json() as any;
  const db = new Database(dbPath, { readonly: true });
  const audit = db.prepare("SELECT user_id, actor_username FROM activity_logs WHERE entity_type = 'expense' AND entity_id = ? ORDER BY created_at DESC LIMIT 1").get(body.id) as any;
  db.close();
  assert.equal(audit.user_id, "operator");
  assert.equal(audit.actor_username, "operator");
});

test("cookie-authenticated unsafe requests reject a cross-site origin", async () => {
  const specialist = await login("specialist", "specialist-password");
  assert.ok(specialist.cookie);
  const response = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: specialist.cookie!, origin: "https://attacker.example" },
    body: JSON.stringify({ company_name: "cross-site" }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as any).error.code, "CSRF_FORBIDDEN");

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.example" },
    body: JSON.stringify({ username: "specialist", password: "specialist-password" }),
  });
  assert.equal(loginResponse.status, 403);
  assert.equal((await loginResponse.json() as any).error.code, "CSRF_FORBIDDEN");
});

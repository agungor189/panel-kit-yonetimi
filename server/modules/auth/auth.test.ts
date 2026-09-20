import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import express from "express";
import jwt from "jsonwebtoken";
import { applySchema } from "../../db/schema.js";
import { createAuthModule, sanitizePermissions, userHasCapability } from "./index.js";

test("warehouse pick and receiving-session permissions survive backend sanitization", () => {
  assert.deepEqual(sanitizePermissions({
    "warehouse:pick_orders": true,
    "warehouse:manage_receiving_sessions": true,
    "warehouse:unknown": true,
  }), {
    "warehouse:pick_orders": true,
    "warehouse:manage_receiving_sessions": true,
  });
});

test("capability registry is explicit and admin does not receive unknown capabilities", () => {
  assert.equal(userHasCapability({ role: "admin", permissions: {} }, "backup:admin"), true);
  assert.equal(userHasCapability({ role: "admin", permissions: {} }, "future:dangerous"), false);
  assert.equal(userHasCapability({ role: "user", permissions: {} }, "panel:read"), false);
  assert.equal(userHasCapability({ role: "user", permissions: {} }, "panel:write"), false);
  assert.equal(userHasCapability({ role: "readonly", permissions: {} }, "panel:read"), false);
});

test("revocable sessions, live account state and scoped service identity fail closed", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  db.prepare(`INSERT INTO users (id, username, password_hash, role, permissions, must_change_password, is_active)
    VALUES (?, ?, ?, ?, ?, 0, 1)`)
    .run("operator", "operator", bcrypt.hashSync("password-1", 4), "user", JSON.stringify({ "panel:read": true, "panel:write": true }));
  db.prepare(`INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, status, permissions)
    VALUES ('warehouse-service', 'Warehouse', 'service', 'service-secret', 'cret', 'active', ?)`)
    .run(JSON.stringify(["auth:login", "auth:session:validate", "auth:session:revoke", "auth:password:change"]));
  db.prepare(`INSERT INTO panel_api_keys (id, name, key_prefix, key_hash, last4, status, permissions)
    VALUES ('second-service', 'Second valid service', 'second', 'second-secret', 'cret', 'active', ?)`)
    .run(JSON.stringify(["auth:session:validate"]));

  const secret = "test-jwt-secret-with-at-least-32-characters";
  const auth = createAuthModule({
    db,
    jwtSecret: secret,
    hashApiKey: (value) => value,
    logActivity() {},
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", auth.router);
  app.use("/api", auth.authenticateApi, auth.requireCompletedPasswordChange, auth.authorizeApi);
  app.get("/api/protected", (_req, res) => res.json({ ok: true }));
  app.post("/api/protected", (_req, res) => res.json({ ok: true }));
  app.get("/api/known-admin-capability", auth.requireCapability("backup:admin"), (_req, res) => res.json({ ok: true }));
  app.get("/api/unknown-admin-capability", auth.requireCapability("future:dangerous"), (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  type Credential = { cookie?: string; token?: string };
  const request = (path: string, credential?: Credential, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(credential?.cookie ? { cookie: credential.cookie } : {}),
      ...(credential?.token ? { authorization: `Bearer ${credential.token}` } : {}),
      ...(!["GET", "HEAD"].includes(init.method || "GET") ? { origin: base } : {}),
      ...init.headers,
    },
  });
  const login = async (service = false, password = "password-1") => {
    const response = await request(`/api/auth/${service ? "service/" : ""}login`, undefined, {
      method: "POST",
      headers: { "content-type": "application/json", ...(service ? { "x-api-key": "service-secret" } : {}) },
      body: JSON.stringify({ username: "operator", password }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    return service
      ? { token: body.token as string }
      : { cookie: (response.headers.get("set-cookie") || "").split(";", 1)[0] };
  };

  try {
    const valid = await login();
    assert.equal((await request("/api/protected", valid)).status, 200, "valid current session");
    assert.equal((await request("/api/protected", { cookie: "panel_session=fake-token" })).status, 401, "fake token");
    const expired = jwt.sign({ id: "operator", sid: "missing", epoch: 0 }, secret, { expiresIn: -1 });
    assert.equal((await request("/api/protected", { cookie: `panel_session=${expired}` })).status, 401, "expired token");

    const passwordToken = await login();
    const changed = await request("/api/auth/change-password", passwordToken, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_password: "password-1", new_password: "password-2" }),
    });
    assert.equal(changed.status, 200);
    const replacement = { cookie: (changed.headers.get("set-cookie") || "").split(";", 1)[0] };
    assert.equal((await request("/api/protected", passwordToken)).status, 401, "password change revokes old session");
    assert.equal((await request("/api/protected", replacement)).status, 200, "replacement session is current");

    const disabledToken = await login(false, "password-2");
    db.prepare("UPDATE users SET is_active = 0, session_epoch = session_epoch + 1 WHERE id = 'operator'").run();
    assert.equal((await request("/api/protected", disabledToken)).status, 401, "disabled user session");
    db.prepare("UPDATE users SET is_active = 1 WHERE id = 'operator'").run();

    const staleAuthority = await login(false, "password-2");
    assert.equal((await request("/api/protected", staleAuthority, { method: "POST" })).status, 200);
    db.prepare("UPDATE users SET role = 'readonly', permissions = '{}', session_epoch = session_epoch + 1 WHERE id = 'operator'").run();
    assert.equal((await request("/api/protected", staleAuthority, { method: "POST" })).status, 401, "authority change invalidates stale session");
    db.prepare("UPDATE users SET permissions = ? WHERE id = 'operator'").run(JSON.stringify({ "panel:read": true }));
    const readonlyCurrent = await login(false, "password-2");
    assert.equal((await request("/api/protected", readonlyCurrent)).status, 200);
    assert.equal((await request("/api/protected", readonlyCurrent, { method: "POST" })).status, 403, "readonly fails closed on write");
    db.prepare("UPDATE users SET role = 'user', permissions = ?, session_epoch = session_epoch + 1 WHERE id = 'operator'")
      .run(JSON.stringify({ "panel:read": true, "panel:write": true }));

    db.prepare("UPDATE users SET role = 'admin', permissions = ?, session_epoch = session_epoch + 1 WHERE id = 'operator'")
      .run(JSON.stringify({ "future:dangerous": true }));
    const adminSession = await login(false, "password-2");
    assert.equal((await request("/api/known-admin-capability", adminSession)).status, 200, "admin receives a defined capability");
    assert.equal((await request("/api/unknown-admin-capability", adminSession)).status, 403, "admin does not receive an unknown capability");
    db.prepare("UPDATE users SET role = 'user', permissions = ?, session_epoch = session_epoch + 1 WHERE id = 'operator'")
      .run(JSON.stringify({ "panel:read": true, "panel:write": true }));

    assert.equal((await request("/api/auth/service/me", undefined, { headers: { "x-api-key": "service-secret" } })).status, 401, "service-only action");
    const serviceToken = await login(true, "password-2");
    assert.equal((await request("/api/auth/service/me", serviceToken, { headers: { "x-api-key": "service-secret" } })).status, 200, "human plus scoped service");
    assert.equal((await request("/api/auth/service/me", serviceToken, { headers: { "x-api-key": "second-secret" } })).status, 401, "a second valid principal cannot replay another service session");
    assert.equal((await request("/api/auth/me", { cookie: `panel_session=${serviceToken.token}` })).status, 401, "service-bound human session cannot become a direct Panel session");
    assert.equal((await request("/api/auth/service/me", serviceToken, { headers: { "x-api-key": "wrong" } })).status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

test("auth module preserves login, current-user and protected API contracts", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 0)")
    .run("test-admin", "admin", bcrypt.hashSync("admin", 4), "admin");

  const activity: string[] = [];
  const auth = createAuthModule({
    db,
    jwtSecret: "test-jwt-secret-with-at-least-32-characters",
    hashApiKey: (value) => value,
    logActivity: (action) => activity.push(action),
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth/login", auth.loginLimiter);
  app.use("/api/auth", auth.router);
  app.use("/api", auth.authenticateApi, auth.requireCompletedPasswordChange, auth.authorizeApi);
  app.get("/api/protected", (req, res) => res.json({ username: req.user?.username }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: base },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as any;
    assert.equal(loginBody.token, undefined);
    const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.ok(cookie);

    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).user.username, "admin");

    const protectedResponse = await fetch(`${base}/api/protected`, { headers: { cookie } });
    assert.equal(protectedResponse.status, 200);
    assert.equal((await protectedResponse.json() as any).username, "admin");
    assert.ok(activity.includes("LOGIN_SUCCESS"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

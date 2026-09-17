import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { applySchema } from "../../db/schema.js";
import { applySeed } from "../../db/seed.js";
import { createAuthModule } from "./index.js";

test("auth module preserves login, current-user and protected API contracts", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  applySeed(db);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();

  const activity: string[] = [];
  const auth = createAuthModule({
    db,
    jwtSecret: "test-jwt-secret-with-at-least-32-characters",
    logActivity: (action) => activity.push(action),
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth/login", auth.loginLimiter);
  app.use("/api/auth", auth.router);
  app.use("/api", auth.authenticateApi, auth.requireCompletedPasswordChange, auth.protectWrites);
  app.get("/api/protected", (req, res) => res.json({ username: req.user?.username }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as any;
    assert.ok(loginBody.token);

    const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).user.username, "admin");

    const protectedResponse = await fetch(`${base}/api/protected`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
    assert.equal(protectedResponse.status, 200);
    assert.equal((await protectedResponse.json() as any).username, "admin");
    assert.ok(activity.includes("LOGIN_SUCCESS"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});


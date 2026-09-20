import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import express from "express";
import { applySchema } from "../db/schema.js";
import { createAuthModule } from "../modules/auth/index.js";

test("KNOWN BUSINESS RED: logout revokes the exact issued session", async () => {
  const db = new Database(":memory:");
  applySchema(db);
  db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, 0)")
    .run("test-admin", "admin", bcrypt.hashSync("admin", 4), "admin");
  const auth = createAuthModule({
    db,
    jwtSecret: "known-red-jwt-secret-with-at-least-32-characters",
    hashApiKey: (value) => value,
    logActivity() {},
    logger: { warn() {}, error() {} },
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", auth.router);
  app.use("/api", auth.authenticateApi);
  app.get("/api/protected", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json() as { token: string }).token;
    assert.equal((await fetch(`${baseUrl}/api/protected`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);
    assert.equal(
      (await fetch(`${baseUrl}/api/protected`, { headers: { authorization: `Bearer ${token}` } })).status,
      401,
      "the pre-logout token must be rejected by the backend",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
});

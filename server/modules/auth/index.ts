import bcrypt from "bcrypt";
import type Database from "better-sqlite3";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { parseUserPermissions, userHasCapability } from "./permissions.js";
import type { AuthenticatedUser } from "./types.js";

type ActivityWriter = (action: string, entityType: string, entityId: string, details?: unknown, userId?: string) => void;
type AuthLogger = {
  warn: (category: string, message: string, data?: unknown) => void;
  error: (category: string, message: string, error?: unknown) => void;
};
type AuthModuleDependencies = {
  db: Database.Database;
  jwtSecret: string;
  hashApiKey: (clearKey: string) => string;
  logActivity: ActivityWriter;
  logger: AuthLogger;
  allowedOrigins?: string[];
};
type SessionClaims = { id?: string; sid?: string; epoch?: number };
type ServicePrincipal = { id: string; name: string; scopes: string[] };
type AuthenticatedSession = { user: AuthenticatedUser; sessionId: string; servicePrincipalId: string | null };

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE = "panel_session";
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
const isSelfAuthenticatedRoute = (path: string) =>
  path.startsWith("/auth/") || path.startsWith("/public/") || path.startsWith("/warehouse/") || path.startsWith("/kit-catalog/") || path.startsWith("/catalog/") || path.startsWith("/kit-publications/");
const bearerToken = (req: Request) => {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
};
const cookieValue = (req: Request, name: string) => {
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(pair.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
};
const errorResponse = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });
const parseScopes = (raw: unknown): string[] => {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

export function createAuthModule({ db, jwtSecret, hashApiKey, logActivity, logger, allowedOrigins = [] }: AuthModuleDependencies) {
  const directSessionToken = (req: Request) => cookieValue(req, SESSION_COOKIE);
  const requireSameOrigin = (req: Request, res: Response): boolean => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
    if (req.headers["sec-fetch-site"] === "cross-site") {
      errorResponse(res, 403, "CSRF_FORBIDDEN", "Cross-site mutation reddedildi.");
      return false;
    }
    const origin = req.headers.origin;
    if (!origin) {
      errorResponse(res, 403, "CSRF_FORBIDDEN", "Mutation için Origin header zorunludur.");
      return false;
    }
    const forwardedProto = String(req.headers["x-forwarded-proto"] || req.protocol).split(",", 1)[0].trim();
    const expectedOrigin = `${forwardedProto}://${req.get("host")}`;
    if (origin !== expectedOrigin && !allowedOrigins.includes(origin)) {
      errorResponse(res, 403, "CSRF_FORBIDDEN", "Origin izinli değil.");
      return false;
    }
    return true;
  };
  const loadUserForAuth = (userId: string): { user?: AuthenticatedUser; disabled?: boolean } => {
    const row = db.prepare(`
      SELECT id, username, role, is_active, permissions, must_change_password, session_epoch
      FROM users WHERE id = ?
    `).get(userId) as any;
    if (!row) return {};
    if (row.is_active === 0) return { disabled: true };
    return { user: {
      id: row.id,
      username: row.username,
      role: row.role,
      permissions: parseUserPermissions(row.permissions),
      must_change_password: row.must_change_password === 1,
      session_epoch: Number(row.session_epoch || 0),
    } };
  };

  const authenticateServiceKey = (req: Request, requiredScope: string): ServicePrincipal | null => {
    const clearKey = req.headers["x-api-key"]?.toString();
    if (!clearKey) return null;
    const key = db.prepare(`
      SELECT id, name, status, permissions, allowed_ips, expires_at
      FROM panel_api_keys WHERE key_hash = ? AND deleted_at IS NULL
    `).get(hashApiKey(clearKey)) as any;
    if (!key || key.status !== "active") return null;
    if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return null;
    if (key.allowed_ips) {
      const allowed = String(key.allowed_ips).split(",").map((value) => value.trim()).filter(Boolean);
      if (!allowed.includes(req.ip)) return null;
    }
    const scopes = parseScopes(key.permissions);
    if (!scopes.includes(requiredScope)) return null;
    db.prepare("UPDATE panel_api_keys SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = ? WHERE id = ?").run(req.ip, key.id);
    return { id: key.id, name: key.name, scopes };
  };

  const requireService = (scope: string) => (req: Request, res: Response, next: NextFunction) => {
    const service = authenticateServiceKey(req, scope);
    if (!service) {
      logActivity("SERVICE_AUTH_FAILED", "service_principal", "unknown", { scope, path: req.path, ip: req.ip });
      return errorResponse(res, 401, "SERVICE_UNAUTHORIZED", "Geçerli ve kapsamlı service identity gerekli.");
    }
    req.servicePrincipal = service;
    return next();
  };

  const issueSession = (user: AuthenticatedUser, servicePrincipalId: string | null) => {
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
    db.prepare(`
      INSERT INTO user_sessions (id, user_id, session_epoch, service_principal_id, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, user.id, user.session_epoch, servicePrincipalId, expiresAt);
    return jwt.sign({ id: user.id, sid: sessionId, epoch: user.session_epoch }, jwtSecret, { expiresIn: SESSION_MAX_AGE_SECONDS });
  };

  const authenticateSessionToken = (token: string, expectedServicePrincipalId: string | null): AuthenticatedSession | null => {
    try {
      const decoded = jwt.verify(token, jwtSecret) as SessionClaims;
      if (!decoded.id || !decoded.sid || !Number.isInteger(decoded.epoch)) return null;
      const session = db.prepare(`
        SELECT s.id AS session_id, s.service_principal_id, s.session_epoch AS issued_epoch,
               u.id, u.username, u.role, u.permissions, u.must_change_password, u.is_active, u.session_epoch
        FROM user_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND datetime(s.expires_at) > datetime('now')
      `).get(decoded.sid, decoded.id) as any;
      if (!session || Number(session.is_active) !== 1) return null;
      if (Number(decoded.epoch) !== Number(session.session_epoch) || Number(session.issued_epoch) !== Number(session.session_epoch)) return null;
      if ((session.service_principal_id || null) !== expectedServicePrincipalId) return null;
      db.prepare("UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(session.session_id);
      return {
        sessionId: session.session_id,
        servicePrincipalId: session.service_principal_id || null,
        user: {
          id: session.id,
          username: session.username,
          role: session.role,
          permissions: parseUserPermissions(session.permissions),
          must_change_password: Number(session.must_change_password) === 1,
          session_epoch: Number(session.session_epoch),
        },
      };
    } catch {
      return null;
    }
  };

  const authenticateUserToken = (token: string, servicePrincipalId: string): AuthenticatedUser | null =>
    authenticateSessionToken(token, servicePrincipalId)?.user || null;

  const requireSession = (serviceBound: boolean) => (req: Request, res: Response, next: NextFunction) => {
    if (!serviceBound && !requireSameOrigin(req, res)) return;
    const token = serviceBound ? bearerToken(req) : directSessionToken(req);
    if (!token) return errorResponse(res, 401, "UNAUTHORIZED", "Token gerekli.");
    const expectedServiceId = serviceBound ? req.servicePrincipal?.id : null;
    if (serviceBound && !expectedServiceId) return errorResponse(res, 401, "SERVICE_UNAUTHORIZED", "Service identity gerekli.");
    const session = authenticateSessionToken(token, expectedServiceId || null);
    if (!session) return errorResponse(res, 401, "UNAUTHORIZED", "Oturum geçersiz, iptal edilmiş veya süresi dolmuş.");
    req.user = session.user;
    res.locals.authSession = session;
    return next();
  };

  const publicUser = (user: AuthenticatedUser) => ({
    id: user.id,
    username: user.username,
    role: user.role,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
  });

  const loginHandler = (serviceBound: boolean) => (req: Request, res: Response) => {
    if (!serviceBound && !requireSameOrigin(req, res)) return;
    try {
      const { username, password } = req.body;
      if (!username || !password) return errorResponse(res, 400, "VALIDATION_ERROR", "Kullanıcı adı ve şifre zorunludur.");
      const login = String(username).trim();
      const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE").get(login, login) as any;
      if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        logActivity("LOGIN_FAILED", "auth", row?.id || "unknown", { username, ip: req.ip, reason: row ? "wrong_password" : "user_not_found" });
        return errorResponse(res, 401, "AUTH_FAILED", "Geçersiz kullanıcı adı veya şifre.");
      }
      if (Number(row.is_active) !== 1) return errorResponse(res, 403, "ACCOUNT_DISABLED", "Bu hesap devre dışı bırakılmış.");
      const user = loadUserForAuth(row.id).user!;
      const serviceId = serviceBound ? req.servicePrincipal!.id : null;
      const token = db.transaction(() => {
        db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
        return issueSession(user, serviceId);
      })();
      logActivity("LOGIN_SUCCESS", "auth", row.id, { ip: req.ip, service_principal_id: serviceId }, row.id);
      if (serviceBound) return res.json({ success: true, token, user: publicUser(user) });
      res.cookie(SESSION_COOKIE, token, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS * 1000 });
      return res.json({ success: true, user: publicUser(user) });
    } catch (error: any) {
      logger.error("AUTH_ERROR", "Login failed", error);
      return errorResponse(res, 500, "INTERNAL_ERROR", error.message);
    }
  };

  const changePasswordHandler = (serviceBound: boolean) => (req: Request, res: Response) => {
    const currentSession = res.locals.authSession as AuthenticatedSession;
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return errorResponse(res, 400, "VALIDATION_ERROR", "Mevcut ve yeni şifre zorunludur.");
    if (String(new_password).length < 8) return errorResponse(res, 400, "VALIDATION_ERROR", "Yeni şifre en az 8 karakter olmalıdır.");
    const row = db.prepare("SELECT password_hash FROM users WHERE id = ? AND is_active = 1").get(currentSession.user.id) as any;
    if (!row || !bcrypt.compareSync(current_password, row.password_hash)) return errorResponse(res, 401, "AUTH_FAILED", "Mevcut şifre yanlış.");
    const newHash = bcrypt.hashSync(new_password, 10);
    const serviceId = serviceBound ? req.servicePrincipal!.id : null;
    const replacement = db.transaction(() => {
      db.prepare(`
        UPDATE users SET password_hash = ?, must_change_password = 0,
          session_epoch = session_epoch + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(newHash, currentSession.user.id);
      db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'password_changed' WHERE user_id = ? AND revoked_at IS NULL")
        .run(currentSession.user.id);
      const user = loadUserForAuth(currentSession.user.id).user!;
      return { token: issueSession(user, serviceId), user };
    })();
    logActivity("PASSWORD_CHANGED", "auth", currentSession.user.id, { ip: req.ip, service_principal_id: serviceId }, currentSession.user.id);
    if (serviceBound) {
      return res.json({ success: true, token: replacement.token, user: publicUser(replacement.user), message: "Şifre başarıyla değiştirildi." });
    }
    res.cookie(SESSION_COOKIE, replacement.token, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_SECONDS * 1000 });
    return res.json({ success: true, user: publicUser(replacement.user), message: "Şifre başarıyla değiştirildi." });
  };

  const logoutHandler = (req: Request, res: Response) => {
    const session = res.locals.authSession as AuthenticatedSession;
    db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'logout' WHERE id = ? AND revoked_at IS NULL")
      .run(session.sessionId);
    logActivity("LOGOUT", "auth", session.user.id, { ip: req.ip, service_principal_id: session.servicePrincipalId }, session.user.id);
    if (!session.servicePrincipalId) res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return res.json({ success: true, message: "Logged out" });
  };

  const router = express.Router();
  router.post("/login", loginHandler(false));
  router.get("/me", requireSession(false), (req, res) => res.json({ success: true, user: publicUser(req.user!) }));
  router.post("/logout", requireSession(false), logoutHandler);
  router.post("/change-password", requireSession(false), changePasswordHandler(false));
  router.post("/service/login", requireService("auth:login"), loginHandler(true));
  router.get("/service/me", requireService("auth:session:validate"), requireSession(true), (req, res) => res.json({ success: true, user: publicUser(req.user!) }));
  router.post("/service/logout", requireService("auth:session:revoke"), requireSession(true), logoutHandler);
  router.post("/service/change-password", requireService("auth:password:change"), requireSession(true), changePasswordHandler(true));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { success: false, error: { code: "TOO_MANY_REQUESTS", message: "Çok fazla başarısız giriş denemesi. 15 dakika sonra tekrar deneyin." } },
  });

  const authenticateApi = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path)) return next();
    if (!requireSameOrigin(req, res)) return;
    const token = directSessionToken(req);
    const session = token ? authenticateSessionToken(token, null) : null;
    if (!session) {
      if (token) logger.warn("AUTH_ERROR", "Session verification failed", { ip: req.ip });
      return errorResponse(res, 401, "UNAUTHORIZED", "Oturum geçersiz veya süresi dolmuş.");
    }
    req.user = session.user;
    res.locals.authSession = session;
    return next();
  };

  const requireCompletedPasswordChange = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path)) return next();
    if (req.user?.must_change_password) return errorResponse(res, 403, "PASSWORD_CHANGE_REQUIRED", "Devam etmeden önce şifrenizi değiştirmeniz gerekiyor.");
    return next();
  };

  const requireCapability = (capability: string) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !userHasCapability(req.user, capability)) {
      logActivity("CAPABILITY_DENIED", "capability", capability, { method: req.method, path: req.path, ip: req.ip }, req.user?.id);
      return errorResponse(res, 403, "FORBIDDEN", `Bu işlem için ${capability} capability gerekli.`);
    }
    return next();
  };

  const authorizeApi = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path)) return next();
    const capability = ["GET", "HEAD", "OPTIONS"].includes(req.method) ? "panel:read" : "panel:write";
    return requireCapability(capability)(req, res, next);
  };

  const protectWrites = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path) || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    return requireCapability("panel:write")(req, res, next);
  };

  return {
    router,
    loginLimiter,
    authenticateApi,
    authenticateUserToken,
    authorizeApi,
    requireCompletedPasswordChange,
    protectWrites,
    requireAdmin: requireCapability("identity:admin"),
    requireCapability,
    loadUserForAuth,
  };
}

export { CAPABILITY_REGISTRY, parseUserPermissions, sanitizePermissions, userHasCapability, validUserRoles } from "./permissions.js";
export type { AuthenticatedUser } from "./types.js";

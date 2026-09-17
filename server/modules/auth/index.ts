import bcrypt from "bcrypt";
import type Database from "better-sqlite3";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { parseUserPermissions } from "./permissions.js";
import type { AuthenticatedUser } from "./types.js";

type ActivityWriter = (
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown,
  userId?: string,
) => void;

type AuthLogger = {
  warn: (category: string, message: string, data?: unknown) => void;
  error: (category: string, message: string, error?: unknown) => void;
};

type AuthModuleDependencies = {
  db: Database.Database;
  jwtSecret: string;
  logActivity: ActivityWriter;
  logger: AuthLogger;
};

const isSelfAuthenticatedRoute = (path: string) =>
  path.startsWith("/auth/") ||
  path.startsWith("/public/") ||
  path.startsWith("/warehouse/") ||
  path.startsWith("/kit-catalog/");

export function createAuthModule({ db, jwtSecret, logActivity, logger }: AuthModuleDependencies) {
  const loadUserForAuth = (userId: string): { user?: AuthenticatedUser; disabled?: boolean } => {
    const dbUser = db.prepare(`
      SELECT id, username, role, is_active, permissions, must_change_password
      FROM users
      WHERE id = ?
    `).get(userId) as any;

    if (!dbUser) return {};
    if (dbUser.is_active === 0) return { disabled: true };

    return {
      user: {
        id: dbUser.id,
        username: dbUser.username,
        role: dbUser.role,
        permissions: parseUserPermissions(dbUser.permissions),
        must_change_password: dbUser.must_change_password === 1,
      },
    };
  };

  const router = express.Router();
  router.post("/login", (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Kullanıcı adı ve şifre zorunludur." } });
      }

      const login = String(username).trim();
      const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE").get(login, login) as any;
      if (!user) {
        logActivity("LOGIN_FAILED", "auth", "unknown", { username, ip: req.ip, reason: "user_not_found" });
        return res.status(401).json({ success: false, error: { code: "AUTH_FAILED", message: "Geçersiz kullanıcı adı veya şifre." } });
      }

      if (user.is_active === 0) {
        return res.status(403).json({ success: false, error: { code: "ACCOUNT_DISABLED", message: "Bu hesap devre dışı bırakılmış." } });
      }

      if (!bcrypt.compareSync(password, user.password_hash)) {
        logActivity("LOGIN_FAILED", "auth", user.id, { username, ip: req.ip, reason: "wrong_password" });
        return res.status(401).json({ success: false, error: { code: "AUTH_FAILED", message: "Geçersiz kullanıcı adı veya şifre." } });
      }

      db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
      logActivity("LOGIN_SUCCESS", "auth", user.id, { username, ip: req.ip }, user.id);
      const token = jwt.sign({ id: user.id }, jwtSecret, { expiresIn: "12h" });
      return res.json({
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          must_change_password: user.must_change_password === 1,
        },
      });
    } catch (error: any) {
      logger.error("AUTH_ERROR", "Login failed", error);
      return res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: error.message } });
    }
  });

  router.post("/change-password", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Token gerekli." } });
    }
    try {
      const decoded = jwt.verify(authHeader.split(" ")[1], jwtSecret) as { id: string };
      const { current_password, new_password } = req.body;
      if (!current_password || !new_password) {
        return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Mevcut ve yeni şifre zorunludur." } });
      }
      if (new_password.length < 8) {
        return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Yeni şifre en az 8 karakter olmalıdır." } });
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(decoded.id) as any;
      if (!user) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Kullanıcı bulunamadı." } });
      if (user.is_active === 0) {
        return res.status(403).json({ success: false, error: { code: "USER_DISABLED", message: "Bu hesap devre dışı bırakılmış." } });
      }
      if (!bcrypt.compareSync(current_password, user.password_hash)) {
        return res.status(401).json({ success: false, error: { code: "AUTH_FAILED", message: "Mevcut şifre yanlış." } });
      }

      const newHash = bcrypt.hashSync(new_password, 10);
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(newHash, user.id);
      logActivity("PASSWORD_CHANGED", "auth", user.id, { ip: req.ip }, user.id);
      return res.json({ success: true, message: "Şifre başarıyla değiştirildi." });
    } catch {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Geçersiz token." } });
    }
  });

  router.post("/logout", (_req, res) => res.json({ success: true, message: "Logged out" }));

  router.get("/me", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "No token" } });
    }
    try {
      const decoded = jwt.verify(authHeader.split(" ")[1], jwtSecret) as { id: string };
      const authUser = loadUserForAuth(decoded.id);
      if (authUser.disabled) {
        return res.status(403).json({ success: false, error: { code: "USER_DISABLED", message: "Bu hesap devre dışı bırakılmış." } });
      }
      if (!authUser.user) {
        return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid user" } });
      }
      return res.json({ success: true, user: authUser.user });
    } catch {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } });
    }
  });

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

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const decoded = jwt.verify(authHeader.split(" ")[1], jwtSecret) as { id: string };
        const authUser = loadUserForAuth(decoded.id);
        if (authUser.disabled) {
          return res.status(403).json({ success: false, error: { code: "USER_DISABLED", message: "Bu hesap devre dışı bırakılmış." } });
        }
        if (!authUser.user) {
          return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid user." } });
        }
        req.user = authUser.user;
        return next();
      } catch (error: any) {
        logger.warn("AUTH_ERROR", "JWT verification failed", { message: error.message, ip: req.ip });
        return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid or expired token." } });
      }
    }

    const apiKeyHeader = req.headers["x-api-key"] || (authHeader && !authHeader.startsWith("Bearer ") ? authHeader : undefined);
    const settingsApiKey = db.prepare("SELECT value FROM settings WHERE key='api_key'").get() as any;
    if (settingsApiKey?.value && apiKeyHeader === settingsApiKey.value) {
      req.user = {
        id: "legacy-api-key",
        username: "legacy-api-key",
        role: "api_key",
        permissions: {},
        must_change_password: false,
      };
      return next();
    }
    return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized access." } });
  };

  const requireCompletedPasswordChange = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path)) return next();
    const user = req.user;
    if (!user || user.role === "api_key") return next();
    if (user.must_change_password) {
      return res.status(403).json({
        success: false,
        error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Devam etmeden önce şifrenizi değiştirmeniz gerekiyor." },
      });
    }
    return next();
  };

  const protectWrites = (req: Request, res: Response, next: NextFunction) => {
    if (isSelfAuthenticatedRoute(req.path) || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.user?.role === "readonly" || req.user?.role === "api_key") {
      return res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Bu kimlik bilgisi yazma işlemleri için yetkili değil." },
      });
    }
    return next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user || user.role !== "admin") {
      logActivity("FORBIDDEN_ACCESS", "system", req.path, { method: req.method, ip: req.ip }, user?.id);
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Bu işlem için admin yetkisi gereklidir." } });
    }
    return next();
  };

  return {
    router,
    loginLimiter,
    authenticateApi,
    requireCompletedPasswordChange,
    protectWrites,
    requireAdmin,
    loadUserForAuth,
  };
}

export { parseUserPermissions, sanitizePermissions, validUserRoles } from "./permissions.js";
export type { AuthenticatedUser } from "./types.js";

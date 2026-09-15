import type Database from "better-sqlite3";
import type { NextFunction, Request, Response } from "express";

type AuthDependencies = {
  db: Database.Database;
  hashApiKey: (clearKey: string) => string;
  logActivity: (action: string, entityType: string, entityId: string, details?: unknown) => void;
};

export function createPanelApiAuth({ db, hashApiKey, logActivity }: AuthDependencies) {
  return (requiredPermission?: string) => (req: Request, res: Response, next: NextFunction) => {
    const apiKeyHeader = req.headers["x-api-key"]?.toString();
    if (!apiKeyHeader) {
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "x-api-key header is required" } });
    }

    const hashedKey = hashApiKey(apiKeyHeader);
    const keyData = db.prepare("SELECT * FROM panel_api_keys WHERE key_hash = ? AND deleted_at IS NULL").get(hashedKey) as any;
    if (!keyData) {
      logActivity("PANEL_API_AUTH_FAILED", "system", "auth", { reason: "Invalid key", userIp: req.ip, userAgent: req.headers["user-agent"] });
      return res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
    }

    if (keyData.status !== "active") {
      logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: `Key status is ${keyData.status}`, userIp: req.ip });
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: `API key is ${keyData.status}` } });
    }

    if (keyData.expires_at && new Date(keyData.expires_at).getTime() < Date.now()) {
      logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "Key expired", userIp: req.ip });
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "API key has expired" } });
    }

    if (keyData.allowed_ips) {
      const allowedIps = keyData.allowed_ips.split(",").map((ip: string) => ip.trim());
      if (!allowedIps.includes(req.ip)) {
        logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "IP not allowed", userIp: req.ip });
        return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "IP not allowed" } });
      }
    }

    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(keyData.permissions || "[]");
      permissions = Array.isArray(parsed) ? parsed : [];
    } catch {
      permissions = [];
    }
    if (requiredPermission && !permissions.includes(requiredPermission)) {
      logActivity("PANEL_API_AUTH_FAILED", "system", keyData.id, { reason: "Missing permission", requiredPermission, userIp: req.ip });
      return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Insufficient permissions" } });
    }

    db.prepare("UPDATE panel_api_keys SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = ? WHERE id = ?").run(req.ip, keyData.id);
    req.panelApiKey = { id: keyData.id, name: keyData.name, permissions };
    next();
  };
}

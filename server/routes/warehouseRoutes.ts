import express from "express";
import Database from "better-sqlite3";
import { WarehouseService, WarehouseServiceError } from "../services/warehouseService.js";

type WarehouseRouterDependencies = {
  db: Database.Database;
  hashApiKey: (clearKey: string) => string;
  logActivity: (
    action: string,
    entityType: string,
    entityId: string,
    details?: unknown,
    actorId?: string,
  ) => void;
};

const permissionsFor = (rawPermissions: unknown): string[] => {
  try {
    const parsed = typeof rawPermissions === "string" ? JSON.parse(rawPermissions) : rawPermissions;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

const errorResponse = (res: express.Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

export function createWarehouseRouter({ db, hashApiKey, logActivity }: WarehouseRouterDependencies) {
  const router = express.Router();
  const service = new WarehouseService(db, logActivity);

  const authenticate = (requiredPermissions: string | string[]) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const clearKey = req.headers["x-api-key"]?.toString();
    if (!clearKey) {
      return errorResponse(res, 401, "UNAUTHORIZED", "x-api-key header is required");
    }

    const keyHash = hashApiKey(clearKey);
    const key = db.prepare(`
      SELECT id, name, status, permissions, allowed_ips, expires_at
      FROM panel_api_keys
      WHERE key_hash = ? AND deleted_at IS NULL
    `).get(keyHash) as any;

    if (!key) {
      logActivity("WAREHOUSE_API_AUTH_FAILED", "system", "warehouse_api", {
        reason: "invalid_key",
        user_ip: req.ip,
      });
      return errorResponse(res, 401, "UNAUTHORIZED", "Invalid API key");
    }

    if (key.status !== "active") {
      logActivity("WAREHOUSE_API_AUTH_FAILED", "system", key.id, {
        reason: "inactive_key",
        user_ip: req.ip,
      });
      return errorResponse(res, 403, "FORBIDDEN", "API key is not active");
    }

    if (key.expires_at && new Date(key.expires_at).getTime() < Date.now()) {
      logActivity("WAREHOUSE_API_AUTH_FAILED", "system", key.id, {
        reason: "expired_key",
        user_ip: req.ip,
      });
      return errorResponse(res, 403, "FORBIDDEN", "API key has expired");
    }

    if (key.allowed_ips) {
      const allowedIps = String(key.allowed_ips).split(",").map((ip) => ip.trim()).filter(Boolean);
      if (!allowedIps.includes(req.ip)) {
        logActivity("WAREHOUSE_API_AUTH_FAILED", "system", key.id, {
          reason: "ip_not_allowed",
          user_ip: req.ip,
        });
        return errorResponse(res, 403, "FORBIDDEN", "IP not allowed");
      }
    }

    const permissions = permissionsFor(key.permissions);
    const required = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];
    const missingPermissions = required.filter((permission) => !permissions.includes(permission));
    if (missingPermissions.length > 0) {
      logActivity("WAREHOUSE_API_AUTH_FAILED", "system", key.id, {
        reason: "missing_permission",
        required_permissions: required,
        user_ip: req.ip,
      });
      return errorResponse(res, 403, "FORBIDDEN", "Insufficient permissions");
    }

    db.prepare(`
      UPDATE panel_api_keys
      SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = ?
      WHERE id = ?
    `).run(req.ip, key.id);

    req.panelApiKey = { id: key.id, name: key.name, permissions };
    next();
  };

  const auditRead = (req: express.Request) => {
    if (!req.panelApiKey) return;
    logActivity("WAREHOUSE_API_USED", "warehouse_api", req.panelApiKey.id, {
      method: req.method,
      path: req.path,
      user_ip: req.ip,
    }, req.panelApiKey.id);
  };

  router.get("/orders", authenticate("read:warehouse_orders"), (req, res) => {
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
    const result = service.listPickableOrders({ page, limit });
    auditRead(req);
    res.json({ success: true, data: result.orders, pagination: result.pagination });
  });

  router.get("/orders/:id", authenticate("read:warehouse_orders"), (req, res) => {
    const order = service.getOrder(req.params.id);
    if (!order) return errorResponse(res, 404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
    auditRead(req);
    res.json({ success: true, data: order });
  });

  router.get(
    "/orders/:id/pick-plan",
    authenticate(["read:warehouse_orders", "read:products", "read:bom"]),
    (req, res) => {
      const pickPlan = service.buildPickPlan(req.params.id);
      if (!pickPlan) return errorResponse(res, 404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
      auditRead(req);
      res.json({ success: true, data: pickPlan });
    },
  );

  router.get("/scan/:code", authenticate("read:products"), (req, res) => {
    const code = String(req.params.code || "").trim();
    if (!code) return errorResponse(res, 400, "INVALID_CODE", "Barkod veya SKU zorunludur.");
    const product = service.scanProduct(code);
    if (!product) return errorResponse(res, 404, "PRODUCT_NOT_FOUND", "Ürün bulunamadı.");
    auditRead(req);
    res.json({ success: true, data: product });
  });

  router.post("/orders/:id/start", authenticate("write:warehouse_status"), (req, res) => {
    try {
      const result = service.startPicking(req.params.id, req.panelApiKey!.id);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      if (error instanceof WarehouseServiceError) {
        return errorResponse(res, error.statusCode, error.code, error.message);
      }
      throw error;
    }
  });

  router.post("/orders/:id/complete", authenticate("write:warehouse_status"), (req, res) => {
    try {
      const result = service.completePicking(req.params.id, req.panelApiKey!.id);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      if (error instanceof WarehouseServiceError) {
        return errorResponse(res, error.statusCode, error.code, error.message);
      }
      throw error;
    }
  });

  return router;
}

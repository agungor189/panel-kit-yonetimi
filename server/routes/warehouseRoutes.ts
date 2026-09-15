import express from "express";
import path from "node:path";
import Database from "better-sqlite3";
import { WarehousePicker, WarehouseService, WarehouseServiceError } from "../services/warehouseService.js";

type WarehouseUser = WarehousePicker & {
  role: string;
  must_change_password: boolean;
};

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
  authenticateUserToken: (token: string) => WarehouseUser | null;
  uploadsDir: string;
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

export function createWarehouseRouter({
  db,
  hashApiKey,
  logActivity,
  authenticateUserToken,
  uploadsDir,
}: WarehouseRouterDependencies) {
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

  const requireWarehouseUser = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      return errorResponse(res, 401, "UNAUTHORIZED", "Oturum gerekli.");
    }

    const user = authenticateUserToken(authorization.slice("Bearer ".length));
    if (!user) return errorResponse(res, 401, "UNAUTHORIZED", "Oturum geçersiz veya süresi dolmuş.");
    if (user.must_change_password) {
      return errorResponse(res, 403, "PASSWORD_CHANGE_REQUIRED", "Önce panel üzerinden şifrenizi değiştirin.");
    }
    if (user.role === "readonly") {
      return errorResponse(res, 403, "FORBIDDEN", "Bu kullanıcı depo işlemi yapamaz.");
    }

    res.locals.warehouseUser = user;
    next();
  };

  const handleServiceError = (res: express.Response, error: unknown) => {
    if (error instanceof WarehouseServiceError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    throw error;
  };

  const queryText = (value: unknown, maxLength = 120) => {
    const source = Array.isArray(value) ? value[0] : value;
    return typeof source === "string" ? source.trim().slice(0, maxLength) : "";
  };

  const queryDate = (value: unknown) => {
    const source = queryText(value, 40);
    return source && Number.isFinite(new Date(source).getTime()) ? source : undefined;
  };

  router.get("/orders", authenticate("read:warehouse_orders"), (req, res) => {
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
    const result = service.listPickableOrders({ page, limit });
    auditRead(req);
    res.json({ success: true, data: result.orders, pagination: result.pagination });
  });

  router.get(
    "/pick-history",
    authenticate("read:warehouse_orders"),
    requireWarehouseUser,
    (req, res) => {
      const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
      const allowedStatuses = new Set(["WAITING", "PICKING", "PICKED", "PACKING", "PACKED", "SHIPPED", "CANCELLED"]);
      const requestedStatus = queryText(req.query.status, 20).toUpperCase();
      const result = service.listPickHistory({
        page,
        limit,
        dateFrom: queryDate(req.query.date_from),
        dateTo: queryDate(req.query.date_to),
        summaryFrom: queryDate(req.query.summary_from),
        summaryTo: queryDate(req.query.summary_to),
        pickerUserId: queryText(req.query.picker_user_id, 80) || undefined,
        sku: queryText(req.query.sku) || undefined,
        productName: queryText(req.query.product_name) || undefined,
        orderNumber: queryText(req.query.order_number) || undefined,
        status: allowedStatuses.has(requestedStatus) ? requestedStatus : undefined,
      });
      auditRead(req);
      res.json({
        success: true,
        data: result.sessions,
        pagination: result.pagination,
        summary: result.today_summary,
        filters: { users: result.users },
      });
    },
  );

  router.get(
    "/pick-history/:id",
    authenticate("read:warehouse_orders"),
    requireWarehouseUser,
    (req, res) => {
      const history = service.getPickHistory(req.params.id);
      if (!history) return errorResponse(res, 404, "PICK_SESSION_NOT_FOUND", "Toplama kaydı bulunamadı.");
      auditRead(req);
      res.json({ success: true, data: history });
    },
  );

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

  router.get(
    "/products/:id/image",
    authenticate("read:products"),
    (req, res) => {
      const storedPath = service.getProductImagePath(req.params.id);
      if (!storedPath) return errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");

      const relativePath = storedPath.replace(/^[/\\]+uploads[/\\]+/i, "").replace(/^[/\\]+/, "");
      const root = path.resolve(uploadsDir);
      const absolutePath = path.resolve(root, relativePath);
      if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
        return errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");
      }
      auditRead(req);
      return res.sendFile(absolutePath, (error) => {
        if (error && !res.headersSent) errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");
      });
    },
  );

  router.post("/orders/:id/start", authenticate("write:warehouse_status"), requireWarehouseUser, (req, res) => {
    try {
      const result = service.startPicking(req.params.id, res.locals.warehouseUser);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  router.post("/orders/:id/verify-pick", authenticate("write:warehouse_status"), requireWarehouseUser, (req, res) => {
    const productId = String(req.body?.product_id || "").trim();
    const code = String(req.body?.code || "").trim();
    if (!productId || !code) {
      return errorResponse(res, 400, "VALIDATION_ERROR", "product_id ve code zorunludur.");
    }
    try {
      const result = service.verifyPick(req.params.id, productId, code, res.locals.warehouseUser);
      res.json({ success: true, data: result });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  router.post(
    "/orders/:id/pick-items/:productId/complete",
    authenticate("write:warehouse_status"),
    requireWarehouseUser,
    (req, res) => {
      if (req.body?.picked_quantity === undefined) {
        return errorResponse(res, 400, "VALIDATION_ERROR", "picked_quantity zorunludur.");
      }
      try {
        const result = service.completePickItem(
          req.params.id,
          req.params.productId,
          req.body.picked_quantity,
          res.locals.warehouseUser,
        );
        res.json({ success: true, data: result });
      } catch (error) {
        return handleServiceError(res, error);
      }
    },
  );

  router.post("/orders/:id/complete", authenticate("write:warehouse_status"), requireWarehouseUser, (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : null;
    try {
      const result = service.completePicking(req.params.id, res.locals.warehouseUser, note);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  return router;
}

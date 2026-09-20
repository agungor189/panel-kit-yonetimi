import express from "express";
import Database from "better-sqlite3";
import { WarehousePicker, WarehouseService, WarehouseServiceError } from "../services/warehouseService.js";
import { normalizeWarehouseLocationCode, WarehouseAdminService, type WarehouseActor } from "../services/warehouseAdminService.js";
import { resolveStoredUpload } from "../services/uploadSecurity.js";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";

type WarehouseUser = WarehousePicker & {
  role: string;
  permissions: Record<string, unknown>;
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
  authenticateUserToken: (token: string, servicePrincipalId: string) => WarehouseUser | null;
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

export const userHasWarehousePermission = (user: Pick<WarehouseUser, "role" | "permissions">, permission: string) => {
  if (user.role === "admin") return true;
  const direct = user.permissions?.[permission];
  if (direct === true) return true;
  const warehouse = user.permissions?.warehouse;
  const shortName = permission.replace(/^warehouse:/, "");
  return Boolean(warehouse && typeof warehouse === "object" && (warehouse as Record<string, unknown>)[shortName] === true);
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
  const adminService = new WarehouseAdminService(db, logActivity, {
    claimLeaseSeconds: Number(process.env.WAREHOUSE_CLAIM_LEASE_SECONDS) || undefined,
  });
  const commandExecutor = new CommandExecutor(db);

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

    if (!req.panelApiKey) return errorResponse(res, 401, "SERVICE_UNAUTHORIZED", "Service identity gerekli.");
    const user = authenticateUserToken(authorization.slice("Bearer ".length), req.panelApiKey.id);
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

  const requireWarehousePermission = (permission: string) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = res.locals.warehouseUser as WarehouseUser | undefined;
    if (!user || !userHasWarehousePermission(user, permission)) {
      logActivity("WAREHOUSE_PERMISSION_DENIED", "warehouse_permission", permission, {
        path: req.path,
        method: req.method,
        required_permission: permission,
      }, user?.id);
      return errorResponse(res, 403, "FORBIDDEN", `Bu işlem için ${permission} yetkisi gerekli.`);
    }
    next();
  };
  const requireAnyWarehousePermission = (permissions: string[]) => (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const user = res.locals.warehouseUser as WarehouseUser | undefined;
    if (!user || !permissions.some((permission) => userHasWarehousePermission(user, permission))) {
      return errorResponse(res, 403, "FORBIDDEN", `Bu işlem için şu yetkilerden biri gerekli: ${permissions.join(", ")}.`);
    }
    next();
  };

  const actor = (res: express.Response) => res.locals.warehouseUser as WarehouseActor;

  const handleServiceError = (res: express.Response, error: unknown) => {
    if (error instanceof WarehouseServiceError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error instanceof CommandFoundationError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    throw error;
  };

  const requestHeader = (req: express.Request, name: string) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const operationIdFromRequest = (req: express.Request) => String(
    req.body?.idempotency_key || requestHeader(req, "idempotency-key") || "",
  ).trim();

  const commandRequest = (
    req: express.Request,
    res: express.Response,
    commandType: string,
    capability: string,
    payload: Record<string, unknown>,
  ) => ({
    operationId: operationIdFromRequest(req),
    commandType,
    payload,
    actor: {
      human: { id: actor(res).id, name: actor(res).username },
      service: req.panelApiKey ? { id: req.panelApiKey.id, name: req.panelApiKey.name } : undefined,
    },
    authorization: { decision: "ALLOW" as const, capability },
    correlationId: requestHeader(req, "x-correlation-id"),
    requestId: requestHeader(req, "x-request-id"),
    requestMetadata: { method: req.method, route: req.route?.path || req.path },
  });

  const queryText = (value: unknown, maxLength = 120) => {
    const source = Array.isArray(value) ? value[0] : value;
    return typeof source === "string" ? source.trim().slice(0, maxLength) : "";
  };

  const queryDate = (value: unknown) => {
    const source = queryText(value, 40);
    return source && Number.isFinite(new Date(source).getTime()) ? source : undefined;
  };

  router.get("/orders", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
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
    requireAnyWarehousePermission(["warehouse:pick_orders", "warehouse:view_analytics"]),
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
    requireAnyWarehousePermission(["warehouse:pick_orders", "warehouse:view_analytics"]),
    (req, res) => {
      const history = service.getPickHistory(req.params.id);
      if (!history) return errorResponse(res, 404, "PICK_SESSION_NOT_FOUND", "Toplama kaydı bulunamadı.");
      auditRead(req);
      res.json({ success: true, data: history });
    },
  );

  router.get("/orders/:id", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    const order = service.getOrder(req.params.id);
    if (!order) return errorResponse(res, 404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
    auditRead(req);
    res.json({ success: true, data: order });
  });

  router.get(
    "/orders/:id/pick-plan",
    authenticate(["read:warehouse_orders", "read:products", "read:bom"]),
    requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"),
    (req, res) => {
      const pickPlan = service.buildPickPlan(req.params.id);
      if (!pickPlan) return errorResponse(res, 404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
      auditRead(req);
      res.json({ success: true, data: pickPlan });
    },
  );

  router.get("/scan/:code", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
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
    requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"),
    (req, res) => {
      const storedPath = service.getProductImagePath(req.params.id);
      if (!storedPath) return errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");

      const resolved = resolveStoredUpload(uploadsDir, storedPath);
      if (resolved.status !== "resolved") {
        return errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");
      }
      auditRead(req);
      return res.sendFile(resolved.absolutePath, (error) => {
        if (error && !res.headersSent) errorResponse(res, 404, "IMAGE_NOT_FOUND", "Ürün görseli bulunamadı.");
      });
    },
  );

  router.post("/orders/:id/start", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    try {
      const result = service.startPicking(req.params.id, res.locals.warehouseUser);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  router.post("/orders/:id/verify-pick", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
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
    requireWarehousePermission("warehouse:pick_orders"),
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

  router.post("/orders/:id/complete", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : null;
    try {
      const result = service.completePicking(req.params.id, res.locals.warehouseUser, note);
      res.json({ success: true, data: result.order, idempotent: result.idempotent });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  // Warehouse Admin — the Panel database remains the sole source of truth.
  router.get("/admin/batches", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (_req, res) => {
    res.json({ success: true, data: adminService.listBatches() });
  });
  router.post("/admin/batches", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.status(201).json({ success: true, data: adminService.createBatch(req.body || {}, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/batches/:id", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.getBatch(req.params.id) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/batches/:id/import/preview", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.previewImport(req.params.id, req.body?.rows) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/batches/:id/import/apply", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.applyImport(req.params.id, req.body?.rows, String(req.body?.preview_hash || ""), actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });

  router.get("/admin/receiving/lots/:lot", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    try { res.json({ success: true, data: adminService.getLot(req.params.lot) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/receiving/sessions", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (_req, res) => {
    res.json({ success: true, data: adminService.listReceivingSessions() });
  });
  router.post("/admin/receiving/sessions", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    try { res.status(201).json({ success: true, data: adminService.startReceivingSession(String(req.body?.lot_number || ""), actor(res), String(req.body?.device_id || ""), String(req.body?.supplier_code || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/receiving/sessions/:id", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.getReceivingSession(req.params.id, { includeAdminDetail: userHasWarehousePermission(actor(res), "warehouse:manage_receiving_sessions") }) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/receiving/my-active-package", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (_req, res) => {
    try { res.json({ success: true, data: adminService.getMyActiveReceivingPackage(actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/receiving/sessions/:id/my-active-package", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.getMyActiveReceivingPackage(actor(res), req.params.id) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/receiving/sessions/:id/my-packages", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.listMyReceivingPackages(req.params.id, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/receiving/sessions/:id/state", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    const state = String(req.body?.state || "") as "active" | "paused" | "cancelled";
    if (!["active", "paused", "cancelled"].includes(state)) return errorResponse(res, 400, "VALIDATION_ERROR", "Geçerli session state zorunludur.");
    try { res.json({ success: true, data: adminService.setReceivingState(req.params.id, state, actor(res), String(req.body?.device_id || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/receiving/sessions/:id/complete", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    const currentActor = actor(res);
    try { res.json({ success: true, data: adminService.completeReceivingSession(req.params.id, req.body?.force_reason, currentActor, String(req.body?.device_id || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });

  router.post("/admin/packages/claim-next", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:print_labels", "warehouse:receive"]), (req, res) => {
    try { res.json({ success: true, data: adminService.claimNextPackage(String(req.body?.supplier_code || ""), actor(res), String(req.body?.session_id || ""), String(req.body?.device_id || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/packages/by-code/:code", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:receive", "warehouse:print_labels", "warehouse:place_packages", "warehouse:move_stock", "warehouse:count_stock"]), (req, res) => {
    try { res.json({ success: true, data: adminService.getPackageByCode(req.params.code) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/packages/:id/print", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:print_labels", "warehouse:receive"]), (req, res) => {
    try {
      const result = adminService.queuePrint(req.params.id, req.body || {}, actor(res));
      res.json({ success: true, data: result, idempotent: result.idempotent });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/packages/:id/release-receiving", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    try { res.json({ success: true, data: adminService.releaseReceivingPackage(req.params.id, actor(res), String(req.body?.device_id || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/print-jobs", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (req, res) => {
    res.json({ success: true, data: adminService.listPrintJobs(Number(req.query.limit) || 100) });
  });

  router.get("/admin/locations", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:manage_locations", "warehouse:place_packages", "warehouse:move_stock"]), (_req, res) => {
    res.json({ success: true, data: adminService.listLocations() });
  });
  router.post("/admin/locations/:id/print", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:manage_locations", "warehouse:print_labels"]), (req, res) => {
    try {
      const input = req.body || {};
      const operationId = operationIdFromRequest(req);
      const printerName = String(input.printer_name ?? "").trim().slice(0, 160) || null;
      const outcome = commandExecutor.execute(commandRequest(
        req,
        res,
        "warehouse.location-label.queue.v1",
        "warehouse:print_labels|warehouse:manage_locations",
        { location_id: req.params.id, printer_name: printerName },
      ), () => {
        const result = adminService.queueLocationPrint(req.params.id, { ...input, idempotency_key: operationId }, actor(res));
        return { statusCode: 200, body: { success: true, data: result, idempotent: result.idempotent } };
      });
      res.status(outcome.result.statusCode).json(outcome.result.body);
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/warehouse-map", authenticate(["read:products", "read:warehouse_orders"]), requireWarehouseUser, requireWarehousePermission("warehouse:view_map"), (_req, res) => {
    res.json({ success: true, data: adminService.getWarehouseMap() });
  });
  router.get("/admin/layouts/placement", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_map"), (_req, res) => {
    res.json({ success: true, data: adminService.getPlacementLayout() });
  });
  router.post("/admin/layouts/placement/preview", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try { res.json({ success: true, data: adminService.previewPlacementLayout(req.body || {}) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/layouts/placement/apply", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try { res.status(201).json({ success: true, data: adminService.applyPlacementLayout(req.body || {}, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/layouts/import-legacy", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try { res.status(201).json({ success: true, data: adminService.importLegacyLayout(req.body, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/packages", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_analytics"), (req, res) => {
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
    const result = adminService.listPackages({ page, limit, query: queryText(req.query.query), status: queryText(req.query.status), location: queryText(req.query.location), lot: queryText(req.query.lot), dateFrom: queryDate(req.query.date_from), dateTo: queryDate(req.query.date_to) });
    res.json({ success: true, data: result.data, pagination: result.pagination });
  });
  router.get("/admin/movements", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:view_analytics"), (req, res) => {
    res.json({ success: true, data: adminService.listMovements(Number(req.query.limit) || 200) });
  });
  router.get("/admin/user-activity", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:view_analytics"), (req, res) => {
    res.json({ success: true, data: adminService.listUserActivity(Number(req.query.limit) || 200) });
  });
  router.get("/admin/locations/suggestion", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:place_packages", "warehouse:receive"]), (req, res) => {
    try { res.json({ success: true, data: adminService.suggestLocation(queryText(req.query.package_id, 100)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/packages/:id/receiving-location", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try { res.json({ success: true, data: adminService.getReceivingLocation(req.params.id, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/locations", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try { res.status(201).json({ success: true, data: adminService.createLocation(req.body || {}, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/placements", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:place_packages", "warehouse:receive"]), (req, res) => {
    const currentActor = actor(res);
    if (req.body?.override_reason && !userHasWarehousePermission(currentActor, "warehouse:move_stock")) {
      return errorResponse(res, 403, "FORBIDDEN", "Sıra atlama için warehouse:move_stock yetkisi gerekli.");
    }
    try {
      const result = adminService.placePackage(String(req.body?.package_code || ""), String(req.body?.location_code || ""), req.body || {}, currentActor);
      res.json({ success: true, data: result, idempotent: result.idempotent });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/moves", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    try {
      const input = req.body || {};
      const operationId = operationIdFromRequest(req);
      const packageCode = String(input.package_code || "").trim().toLocaleUpperCase("tr-TR");
      const locationCode = normalizeWarehouseLocationCode(input.location_code);
      const outcome = commandExecutor.execute(commandRequest(
        req,
        res,
        "warehouse.package.move.v1",
        "warehouse:move_stock",
        { package_code: packageCode, location_code: locationCode },
      ), () => {
        const result = adminService.movePackage(packageCode, locationCode, { ...input, idempotency_key: operationId }, actor(res));
        return { statusCode: 200, body: { success: true, data: result, idempotent: result.idempotent } };
      });
      res.status(outcome.result.statusCode).json(outcome.result.body);
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/stock-counts", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:count_stock"), (req, res) => {
    try {
      const result = adminService.countPackage(String(req.body?.package_code || ""), req.body?.counted_quantity, req.body || {}, actor(res));
      res.json({ success: true, data: result, idempotent: result.idempotent });
    } catch (error) { return handleServiceError(res, error); }
  });

  router.get("/admin/label-templates", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:edit_label_templates"), (_req, res) => {
    res.json({ success: true, data: adminService.listTemplates() });
  });
  router.post("/admin/label-templates", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:edit_label_templates"), (req, res) => {
    try { res.json({ success: true, data: adminService.saveTemplate(req.body || {}, actor(res)) }); }
    catch (error) { return handleServiceError(res, error); }
  });

  return router;
}

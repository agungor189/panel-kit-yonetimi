import express from "express";
import Database from "better-sqlite3";
import { WarehousePicker, WarehouseService, WarehouseServiceError } from "../services/warehouseService.js";
import { WarehouseAdminService, type WarehouseActor } from "../services/warehouseAdminService.js";
import { resolveStoredUpload } from "../services/uploadSecurity.js";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { UOM_DEFINITIONS, UOM_REGISTRY_VERSION } from "../modules/catalog/uom.js";
import { InventoryService, InventoryValidationError } from "../modules/inventory/inventoryService.js";
import { ReturnsService, ReturnsValidationError } from "../modules/returns/returnsService.js";
import {
  FailClosedGeliverTransport,
  GELIVER_TRANSPORT_CONTRACT,
  ShipmentService,
  ShipmentValidationError,
} from "../modules/shipping/shipmentService.js";
import { GeliverFlowService, GeliverSdkTransport } from "../modules/shipping/geliverFlowService.js";
import { WarehouseExecutionError, WarehouseExecutionService, type WarehouseTopologyInput } from "../modules/warehouse/warehouseExecutionService.js";
import { PrintingError, PrintingService, type TemplateSnapshot, type ReprintReason } from "../modules/printing/printingService.js";
import { ReconciliationService } from "../modules/reconciliation/reconciliationService.js";

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
  const catalogService = new CatalogService(db);
  const inventoryService = new InventoryService(db);
  const shipmentService = new ShipmentService(db);
  const failClosedGeliverTransport = new FailClosedGeliverTransport();
  const geliverTransport = GeliverSdkTransport.fromEnvironment();
  const geliverService = new GeliverFlowService(db, geliverTransport, {
    senderAddressId: geliverTransport.senderAddressId,
    sourceIdentifier: geliverTransport.sourceIdentifier,
  });
  const returnsService = new ReturnsService(db);
  const executionService = new WarehouseExecutionService(db);
  const printingService = new PrintingService(db);
  const reconciliationService = new ReconciliationService(db);

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
    if (error instanceof InventoryValidationError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error instanceof ShipmentValidationError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error instanceof PrintingError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error instanceof ReturnsValidationError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error instanceof WarehouseExecutionError) {
      return errorResponse(res, error.statusCode, error.code, error.message);
    }
    if (error && typeof error === "object" && ("status" in error || "code" in error)) {
      return errorResponse(res, 502, "GELIVER_PROVIDER_ERROR", "Geliver request failed; reconcile the durable operation before retry.");
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

  const executeWarehouseCommand = (
    req: express.Request,
    res: express.Response,
    capability: string,
    commandType: string,
    payload: Record<string, unknown>,
    handler: (context: { addOutbox(message: { topic: string; eventType: string; payload: unknown; aggregateType?: string; aggregateId?: string }): void }) => unknown,
  ) => {
    const outcome = commandExecutor.execute<any>(commandRequest(req, res, commandType, capability, payload), (context) => ({
      statusCode: 200,
      body: { success: true, contract: "dsdst.warehouse-execution.v1", data: handler(context) },
    }));
    return res.status(outcome.result.statusCode).json({ ...outcome.result.body, idempotent: outcome.replayed });
  };

  router.get("/execution/topology", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_map"), (req, res) => {
    try { auditRead(req); return res.json({ success: true, contract: "dsdst.warehouse-topology.v1", data: executionService.getTopology() }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/topology", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try {
      const payload = { topology: req.body?.topology ?? null };
      return executeWarehouseCommand(req, res, "warehouse:manage_locations", "warehouse.topology.configure.v1", payload, (context) => {
        const data = executionService.configureTopology(payload.topology as WarehouseTopologyInput);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.topology.configured.v1", aggregateType: "warehouse_topology", aggregateId: data.id, payload: { topology_id: data.id, config_hash: data.configHash } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/execution/settings", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_map"), (req, res) => {
    auditRead(req); return res.json({ success: true, contract: "dsdst.warehouse-settings.v1", data: executionService.getSettings() });
  });
  router.post("/execution/settings", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_locations"), (req, res) => {
    try {
      const payload = { watchThresholdPct: req.body?.watchThresholdPct ?? null, prepareThresholdPct: req.body?.prepareThresholdPct ?? null, heavyPackageThresholdGrams: req.body?.heavyPackageThresholdGrams ?? null };
      return executeWarehouseCommand(req, res, "warehouse:manage_locations", "warehouse.settings.configure.v1", payload, (context) => {
        const data = executionService.configureSettings(payload as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.settings.configured.v1", aggregateType: "warehouse_settings", aggregateId: "default", payload: data });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/receipts/excess-approvals", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("inventory:receive"), (req, res) => {
    try {
      const payload = { approvalId: req.body?.approvalId ?? null, costSnapshotId: req.body?.costSnapshotId ?? null, maximumAcceptedQuantityBaseInt: req.body?.maximumAcceptedQuantityBaseInt ?? null, reason: req.body?.reason ?? null, approvedAt: req.body?.approvedAt ?? null };
      return executeWarehouseCommand(req, res, "inventory:receive", "warehouse.goods-receipt.excess-approve.v1", payload, (context) => {
        const data = executionService.approveExcess({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.goods-receipt.excess-approved.v1", aggregateType: "warehouse_excess_approval", aggregateId: data.id, payload: { approval_id: data.id, cost_snapshot_id: data.costSnapshotId } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/receipts", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:receive"), (req, res) => {
    try {
      const { idempotency_key: _idempotencyKey, ...payload } = req.body || {};
      return executeWarehouseCommand(req, res, "inventory:receive", "warehouse.goods-receipt.accept.v1", payload, (context) => {
        const data = executionService.receiveGoods({ ...payload, operationId: operationIdFromRequest(req) });
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.goods-receipt.accepted.v1", aggregateType: "warehouse_goods_receipt", aggregateId: data.id, payload: { receipt_id: data.id, product_id: data.productId, inventory_lot_id: data.inventoryLotId, accepted_quantity_base_int: data.acceptedQuantityBaseInt } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/execution/packages/:id", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:receive", "warehouse:place_packages", "warehouse:move_stock", "warehouse:count_stock"]), (req, res) => {
    try { auditRead(req); return res.json({ success: true, contract: "dsdst.warehouse-package.v1", data: executionService.getPackage(req.params.id) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/packages/:id/identity", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:receive", "warehouse:print_labels"]), (req, res) => {
    try {
      const payload = { packageId: req.params.id, labelIdentity: req.body?.labelIdentity ?? null };
      return executeWarehouseCommand(req, res, "warehouse:print_labels", "warehouse.package.identify.v1", payload, (context) => {
        const data = executionService.identifyPackage(payload as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.package.identified.v1", aggregateType: "warehouse_package", aggregateId: data.id, payload: { package_id: data.id, label_identity: data.labelIdentity } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/execution/packages/:id/suggestion", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:receive", "warehouse:place_packages", "warehouse:move_stock"]), (req, res) => {
    try { auditRead(req); return res.json({ success: true, contract: "dsdst.warehouse-placement-suggestion.v1", data: executionService.suggestLocation(req.params.id) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/packages/:id/place", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:place_packages"), (req, res) => {
    try {
      const payload = { packageId: req.params.id, destinationCode: req.body?.destinationCode ?? null, scannedDestinationCode: req.body?.scannedDestinationCode ?? null, placedAt: req.body?.placedAt ?? null };
      return executeWarehouseCommand(req, res, "warehouse:place_packages", "warehouse.package.place.v1", payload, (context) => {
        const data = executionService.placePackage({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.package.placed.v1", aggregateType: "warehouse_package", aggregateId: data.package.id, payload: { package_id: data.package.id, destination_code: data.destination.code } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/packages/:id/move", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    try {
      const payload = { packageId: req.params.id, destinationCode: req.body?.destinationCode ?? null, scannedDestinationCode: req.body?.scannedDestinationCode ?? null, movedAt: req.body?.movedAt ?? null };
      return executeWarehouseCommand(req, res, "warehouse:move_stock", "warehouse.package.move.v1", payload, (context) => {
        const data = executionService.movePackage({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.package.moved.v1", aggregateType: "warehouse_package", aggregateId: data.package.id, payload: { package_id: data.package.id, destination_code: data.destination.code } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/replenishments/prepare", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    try {
      const payload = { productId: req.body?.productId ?? null };
      return executeWarehouseCommand(req, res, "warehouse:move_stock", "warehouse.replenishment.prepare.v1", payload, (context) => {
        const data = executionService.prepareReplenishment({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: `warehouse.replenishment.${String(data.state).toLowerCase()}.v1`, aggregateType: "warehouse_replenishment", aggregateId: data.id ?? data.lotId, payload: { product_id: data.productId, lot_id: data.lotId, state: data.state } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/execution/replenishments", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    try {
      auditRead(req);
      return res.json({ success: true, contract: "dsdst.warehouse-replenishment-tasks.v1", data: executionService.listReplenishmentTasks() });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/replenishments/:id/complete", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    try {
      const payload = { taskId: req.params.id, scannedSourcePackageCode: req.body?.scannedSourcePackageCode ?? null, destinationCode: req.body?.destinationCode ?? null, scannedDestinationCode: req.body?.scannedDestinationCode ?? null, movedAt: req.body?.movedAt ?? null };
      return executeWarehouseCommand(req, res, "warehouse:move_stock", "warehouse.replenishment.complete.v1", payload, (context) => {
        const data = executionService.completeReplenishment({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.replenishment.completed.v1", aggregateType: "warehouse_replenishment", aggregateId: data.id, payload: { task_id: data.id, lot_id: data.lotId } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/discrepancies", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:count_stock"), (req, res) => {
    try {
      const { idempotency_key: _idempotencyKey, ...payload } = req.body || {};
      return executeWarehouseCommand(req, res, "warehouse:count_stock", "warehouse.stock-discrepancy.report.v1", payload, (context) => {
        const data = executionService.reportDiscrepancy({ ...payload, operationId: operationIdFromRequest(req) });
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.stock-discrepancy.reported.v1", aggregateType: "warehouse_discrepancy", aggregateId: data.id, payload: { discrepancy_id: data.id, lot_id: data.lotId } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/counts", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:count_stock"), (req, res) => {
    try {
      const { idempotency_key: _idempotencyKey, ...payload } = req.body || {};
      return executeWarehouseCommand(req, res, "warehouse:count_stock", "warehouse.stock-count.record.v1", payload, (context) => {
        const data = executionService.recordCount({ ...payload, operationId: operationIdFromRequest(req) });
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.stock-count.recorded.v1", aggregateType: "warehouse_stock_count", aggregateId: data.id, payload: { count_id: data.id, package_id: data.packageId, status: data.status } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/execution/counts/:id/approve", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("inventory:correct"), (req, res) => {
    try {
      const payload = { countId: req.params.id, approvalReference: req.body?.approvalReference ?? null, approvedAt: req.body?.approvedAt ?? null };
      return executeWarehouseCommand(req, res, "inventory:correct", "warehouse.stock-count.approve.v1", payload, (context) => {
        const data = executionService.approveCount({ ...payload, operationId: operationIdFromRequest(req) } as any);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.stock-count.approved.v1", aggregateType: "warehouse_stock_count", aggregateId: data.id, payload: { count_id: data.id, difference_base_int: data.differenceBaseInt } });
        return data;
      });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.get("/execution/products/:id/reconciliation", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_analytics"), (req, res) => {
    try { auditRead(req); return res.json({ success: true, contract: "dsdst.warehouse-reconciliation.v1", data: executionService.getReconciliation(req.params.id) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/reconciliation", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:view_analytics"), (req, res) => {
    auditRead(req);
    return res.json({ success: true, contract: "dsdst.reconciliation.warehouse.v1", data: reconciliationService.listFindings({ status: "OPEN", domain: "INVENTORY", affectedType: "SKU" }) });
  });

  router.get("/catalog/products", authenticate("read:products"), requireWarehouseUser, (req, res) => {
    const requested = typeof req.query.catalog_type === "string" ? req.query.catalog_type : undefined;
    const type = requested && ["product", "profile", "connector", "cap", "wheel", "complementary"].includes(requested)
      ? requested as "product" | "profile" | "connector" | "cap" | "wheel" | "complementary"
      : undefined;
    auditRead(req);
    res.json({ success: true, contract: "dsdst.catalog-product.v1", data: catalogService.listProducts(type) });
  });

  router.get("/catalog/uoms", authenticate("read:products"), requireWarehouseUser, (req, res) => {
    auditRead(req);
    res.json({
      success: true,
      contract: "dsdst.catalog-uom.v1",
      data: {
        registry_version: UOM_REGISTRY_VERSION,
        units: UOM_DEFINITIONS.map((unit) => ({ code: unit.code, dimension: unit.dimension, base_quantum: unit.baseQuantum, quantity_scale: unit.quantityScale, registry_version: UOM_REGISTRY_VERSION })),
      },
    });
  });

  router.get("/inventory/products/:id/availability", authenticate("read:products"), requireWarehouseUser,
    requireAnyWarehousePermission(["warehouse:receive", "warehouse:pick_orders", "warehouse:view_analytics"]), (req, res) => {
      try {
        auditRead(req);
        return res.json({ success: true, contract: "dsdst.inventory-availability.v1", data: inventoryService.getProductAvailability(req.params.id) });
      } catch (error) { return handleServiceError(res, error); }
    });
  router.get("/inventory/reservations/:id/fulfillment", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
      try {
        auditRead(req);
        return res.json({ success: true, contract: "dsdst.inventory-fulfillment.v1", data: inventoryService.getFulfillmentState(req.params.id) });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/inventory/receipts", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("warehouse:receive"), (req, res) => {
      try {
        const payload = {
          receiptId: req.body?.receiptId ?? null,
          costSnapshotId: req.body?.costSnapshotId ?? null,
          receivedAt: req.body?.receivedAt ?? null,
          location: req.body?.location ?? null,
        };
        const outcome = commandExecutor.execute(commandRequest(req, res, "inventory.receipt.approve.v1", "inventory:receive", payload), (context) => {
          const data = inventoryService.receiveCostedLot({ ...payload, operationId: operationIdFromRequest(req) } as any);
          context.addOutbox({ topic: "inventory", eventType: "inventory.receipt.posted.v1", aggregateType: "inventory_lot", aggregateId: data.lot.id, payload: { lot_id: data.lot.id, product_id: data.lot.productId, quantity_base_int: data.lot.receivedQuantityBaseInt } });
          return { statusCode: 201, body: { success: true, contract: "dsdst.inventory-receipt.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  for (const transition of ["pick", "pack"] as const) {
    router.post(`/inventory/reservations/:id/${transition}`, authenticate("write:warehouse_status"), requireWarehouseUser,
      requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
        try {
          const payload = { reservationId: req.params.id, at: req.body?.at ?? null };
          const commandType = `inventory.reservation.${transition}.v1`;
          const outcome = commandExecutor.execute(commandRequest(req, res, commandType, "warehouse:pick_orders", payload), (context) => {
            if (transition === "pick") {
              const data = inventoryService.markPicked({ reservationId: req.params.id, pickedAt: req.body?.at, operationId: operationIdFromRequest(req) });
              context.addOutbox({ topic: "inventory", eventType: "inventory.reservation.picked.v1", aggregateType: "reservation", aggregateId: data.id, payload: { reservation_id: data.id } });
              return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-reservation.v1", data } };
            }
            const data = shipmentService.packAndPrepare({ reservationId: req.params.id, packedAt: req.body?.at,
              operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
            context.addOutbox({ topic: "shipping", eventType: "shipping.preparation.created.v1", aggregateType: "shipment",
              aggregateId: data.shipment.id, payload: { reservation_id: data.reservation.id, shipment_id: data.shipment.id } });
            return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
          });
          return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
        } catch (error) { return handleServiceError(res, error); }
      });
  }

  router.post("/inventory/reservations/:id/dispatch", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:dispatch"), (req, res) => {
      return errorResponse(res, 409, "PHYSICAL_HANDOFF_REQUIRED",
        "Inventory dispatch is closed; confirm physical carrier handoff through /shipping/shipments/:id/handoff.");
    });

  router.get("/shipping/provider-contracts/geliver", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"), (_req, res) =>
      res.json({ success: true, contract: "dsdst.carrier-provider-contract.v2", data: geliverService.contract() }));

  router.get("/shipping/shipments/:id", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
      try {
        auditRead(req);
        return res.json({ success: true, contract: "dsdst.shipment.v1", data: shipmentService.getShipment(req.params.id) });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.get("/shipping/reservations/:id/shipment", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
      try {
        auditRead(req);
        return res.json({ success: true, contract: "dsdst.shipment.v1", data: shipmentService.getShipmentForReservation(req.params.id) });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/packages", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), (req, res) => {
      const payload = { shipmentId: req.params.id, packages: req.body?.packages ?? null };
      try {
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.packages.define.v1", "shipping:manage", payload), (context) => {
          const data = shipmentService.definePackages({ shipmentId: req.params.id, packages: req.body?.packages,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
          context.addOutbox({ topic: "shipping", eventType: "shipping.packages.defined.v1", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, package_count: data.length } });
          return { statusCode: 201, body: { success: true, contract: "dsdst.shipment-packages.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/carrier-selection", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), (req, res) => {
      const payload = { shipmentId: req.params.id, ...req.body };
      try {
        if (geliverTransport.enabled) throw new ShipmentValidationError("LIVE_GELIVER_OFFER_REQUIRED", "Select a live Geliver offer; manual carrier/service/quote input is disabled.", 409);
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.carrier.select.v1", "shipping:manage", payload), (context) => {
          const data = shipmentService.selectCarrier({ ...req.body, shipmentId: req.params.id,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
          context.addOutbox({ topic: "shipping", eventType: "shipping.carrier.selected.v1", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, provider: data.carrierSelection.provider,
              carrier: data.carrierSelection.carrierCode, service: data.carrierSelection.serviceCode } });
          return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/booking", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), (req, res) => {
      const payload = { shipmentId: req.params.id, requestedAt: req.body?.requestedAt ?? null };
      try {
        if (geliverTransport.enabled) throw new ShipmentValidationError("LIVE_GELIVER_OFFER_REQUIRED", "Use the verified Geliver offer acceptance flow.", 409);
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.booking.request.v1", "shipping:manage", payload), (context) => {
          const data = shipmentService.requestBooking({ shipmentId: req.params.id, operationId: operationIdFromRequest(req),
            actor: { id: actor(res).id, name: actor(res).username }, requestedAt: req.body?.requestedAt });
          context.addOutbox({ topic: "carrier", eventType: "shipping.geliver.booking.requested.v1", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, booking_job_ids: data.jobs.map((job) => job.id),
              transport_enabled: GELIVER_TRANSPORT_CONTRACT.enabled } });
          return { statusCode: 202, body: { success: true, contract: "dsdst.shipment-booking.v1", data,
            providerTransport: { ...GELIVER_TRANSPORT_CONTRACT, verifiedCapabilities: [...GELIVER_TRANSPORT_CONTRACT.verifiedCapabilities] } } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/geliver/offers", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), async (req, res) => {
      const payload = { shipmentId: req.params.id, recipient: req.body?.recipient ?? null };
      try {
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.geliver.create-request.v2", "shipping:manage", payload), (context) => {
          const jobs = geliverService.prepareCreateJobs({ shipmentId: req.params.id, recipient: req.body?.recipient,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
          context.addOutbox({ topic: "carrier", eventType: "shipping.geliver.create.requested.v2", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, job_ids: jobs.map((job) => job.id) } });
          return { statusCode: 202, body: { success: true, contract: "dsdst.geliver-live-offers.v2", data: { jobs } } };
        });
        for (const job of (outcome.result.body as any).data.jobs) await geliverService.processCreateJob(job.id);
        const data = await geliverService.refreshShipment(req.params.id);
        return res.json({ success: true, contract: "dsdst.geliver-live-offers.v2", data, idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/geliver/refresh", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), async (req, res) => {
      try { const data = await geliverService.refreshShipment(req.params.id); shipmentService.publishV212TrackingRefresh(req.params.id);
        return res.json({ success: true, contract: "dsdst.geliver-shipment-refresh.v2", data }); }
      catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/geliver/offers/:offerId/accept", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), async (req, res) => {
      const payload = { shipmentId: req.params.id, offerId: req.params.offerId };
      try {
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.geliver.offer.accept-request.v2", "shipping:manage", payload), (context) => {
          const job = geliverService.selectOffer({ shipmentId: req.params.id, offerId: req.params.offerId,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
          context.addOutbox({ topic: "carrier", eventType: "shipping.geliver.offer.accept.requested.v2", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, accept_job_id: job.id, offer_id: req.params.offerId } });
          return { statusCode: 202, body: { success: true, contract: "dsdst.geliver-offer-accept.v2", data: { job } } };
        });
        await geliverService.processAcceptJob((outcome.result.body as any).data.job.id);
        return res.json({ success: true, contract: "dsdst.shipment.v1", data: shipmentService.getShipment(req.params.id), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/cancel", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:manage"), async (req, res) => {
      const payload = { shipmentId: req.params.id, reason: req.body?.reason ?? null, cancelledAt: req.body?.cancelledAt ?? null };
      try {
        if (geliverTransport.enabled) {
          const intent = commandExecutor.execute(commandRequest(req, res, "shipping.geliver.cancel-request.v2", "shipping:manage", payload), (context) => {
            context.addOutbox({ topic: "carrier", eventType: "shipping.geliver.cancel.requested.v2", aggregateType: "shipment",
              aggregateId: req.params.id, payload: { shipment_id: req.params.id } });
            return { statusCode: 202, body: { success: true, contract: "dsdst.geliver-cancel.v2", data: { shipmentId: req.params.id } } };
          });
          await geliverService.cancelBeforeHandoff({ shipmentId: req.params.id, reason: req.body?.reason,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username }, cancelledAt: req.body?.cancelledAt });
          return res.json({ success: true, contract: "dsdst.shipment.v1", data: shipmentService.getShipment(req.params.id), idempotent: intent.replayed });
        }
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.cancel.v1", "shipping:manage", payload), (context) => {
          const data = shipmentService.cancelBeforeHandoff({ shipmentId: req.params.id, reason: req.body?.reason,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username },
            transport: failClosedGeliverTransport, cancelledAt: req.body?.cancelledAt });
          context.addOutbox({ topic: "shipping", eventType: "shipping.cancelled.v1", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, state: data.state } });
          return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/shipping/shipments/:id/handoff", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("shipping:dispatch"), (req, res) => {
      const payload = { shipmentId: req.params.id, handedOffAt: req.body?.handedOffAt ?? null,
        handoffEvidence: req.body?.handoffEvidence ?? null, actualCharge: req.body?.actualCharge ?? null };
      try {
        const outcome = commandExecutor.execute(commandRequest(req, res, "shipping.handoff.confirm.v1", "shipping:dispatch", payload), (context) => {
          const data = shipmentService.confirmHandoff({ shipmentId: req.params.id, handedOffAt: req.body?.handedOffAt,
            handoffEvidence: req.body?.handoffEvidence, actualCharge: req.body?.actualCharge,
            operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } });
          for (const event of data.outbox) context.addOutbox(event);
          context.addOutbox({ topic: "shipping", eventType: "shipping.dispatched.v1", aggregateType: "shipment",
            aggregateId: req.params.id, payload: { shipment_id: req.params.id, reservation_id: data.shipment.reservationId } });
          return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data: data.shipment } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/inventory/reservations/:id/discrepancies", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("warehouse:count_stock"), (req, res) => {
      try {
        const payload = { reservationId: req.params.id, lotId: req.body?.lotId ?? null, locationId: req.body?.locationId ?? null, reason: req.body?.reason ?? null };
        const outcome = commandExecutor.execute(commandRequest(req, res, "inventory.stock-discrepancy.report.v1", "warehouse:count_stock", payload), (context) => {
          const data = inventoryService.reportStockDiscrepancy({ ...payload, operationId: operationIdFromRequest(req) } as any);
          context.addOutbox({ topic: "inventory", eventType: "inventory.stock-discrepancy.reported.v1", aggregateType: "reservation", aggregateId: req.params.id, payload: { reservation_id: req.params.id, lot_id: payload.lotId } });
          return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-fulfillment.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.get("/returns", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:accept_returns"), (req, res) => {
      auditRead(req);
      return res.json({ success: true, contract: "dsdst.warehouse-return-acceptance.v1", data: returnsService.listApprovedReturns() });
    });

  router.get("/returns/:id", authenticate("read:warehouse_orders"), requireWarehouseUser,
    requireWarehousePermission("warehouse:accept_returns"), (req, res) => {
      try {
        auditRead(req);
        return res.json({ success: true, contract: "dsdst.warehouse-return-acceptance.v1", data: returnsService.getReturn(req.params.id) });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.post("/returns/:id/receipts", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("warehouse:accept_returns"), (req, res) => {
      const payload = { returnId: req.params.id, lines: req.body?.lines ?? null, receivedAt: req.body?.receivedAt ?? null };
      try {
        const outcome = commandExecutor.execute(commandRequest(req, res, "returns.receipt.inspect.v1", "warehouse:accept_returns", payload), (context) => {
          const data = returnsService.receiveReturn({ ...payload, operationId: operationIdFromRequest(req), actor: { id: actor(res).id, name: actor(res).username } } as any);
          context.addOutbox({ topic: "returns", eventType: "returns.receipt.inspected.v1", aggregateType: "return", aggregateId: data.id,
            payload: { return_id: data.id, inspection_complete: data.inspection.complete, return_loss_try_minor: data.returnLossTryMinor } });
          return { statusCode: 201, body: { success: true, contract: "dsdst.warehouse-return-acceptance.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
    });

  router.get("/orders", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
    const result = service.listPickableOrders({ page, limit });
    auditRead(req);
    res.json({ success: true, data: result.orders, pagination: result.pagination });
  });

  router.post("/shipping/shipments/:id/packages/:packageId/print", authenticate("write:warehouse_status"), requireWarehouseUser,
    requireWarehousePermission("warehouse:print_labels"), async (req, res) => {
      try {
        const label = db.prepare(`SELECT l.label_url,l.label_file_type,l.artifact_sha256,b.provider_shipment_id
          FROM geliver_label_observations l JOIN geliver_booking_facts b ON b.provider_shipment_id=l.provider_shipment_id
          WHERE b.shipment_id=? AND b.package_id=? ORDER BY datetime(l.observed_at) DESC,l.id DESC LIMIT 1`)
          .get(req.params.id, req.params.packageId) as any;
        if (!label?.label_url || !label?.artifact_sha256) throw new PrintingError("SHIPPING_LABEL_NOT_READY", "Provider-native Geliver label is not ready.", 409);
        const artifact = Buffer.from(await geliverTransport.downloadLabel(label.label_url));
        const payload = { shipmentId: req.params.id, packageId: req.params.packageId, artifactReference: label.label_url,
          artifactSha256: label.artifact_sha256, printerName: req.body?.printer_name ?? null };
        const outcome = commandExecutor.execute(commandRequest(req, res, "printing.shipping.queue.v1", "warehouse:print_labels", payload), (context) => {
          const data = printingService.queueShippingJob({ ...payload, subjectCode: label.provider_shipment_id,
            artifactMediaType: label.label_file_type || "application/pdf", artifact, operationId: operationIdFromRequest(req), actorId: actor(res).id });
          if (!data.logical_replay) context.addOutbox({ topic: "printing", eventType: "printing.job.queued.v1", aggregateType: "print_job", aggregateId: data.id, payload: { job_id: data.id, purpose: data.purpose } });
          return { statusCode: 201, body: { success: true, contract: "dsdst.print-job.v1", data } };
        });
        return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
      } catch (error) { return handleServiceError(res, error); }
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


  router.get("/orders/:id/reservation", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    try {
      const reservation = db.prepare(`
        SELECT id,order_id,status,shipment_id
        FROM inventory_reservations
        WHERE order_id=?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(req.params.id) as {
        id: string;
        order_id: string;
        status: string;
        shipment_id: string | null;
      } | undefined;

      if (!reservation) {
        return errorResponse(
          res,
          404,
          "RESERVATION_NOT_FOUND",
          "Sipariş için stok rezervasyonu bulunamadı.",
        );
      }

      return res.json({
        success: true,
        data: {
          id: reservation.id,
          orderId: reservation.order_id,
          status: reservation.status,
          shipmentId: reservation.shipment_id || null,
        },
      });
    } catch (error) {
      return handleServiceError(res, error);
    }
  });

  router.post("/orders/:id/complete", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:pick_orders"), (req, res) => {
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : null;
    try {
      const result = db.transaction(() => {
        const completed = service.completePicking(req.params.id, res.locals.warehouseUser, note);

        const reservation = db.prepare(`
          SELECT id,status
          FROM inventory_reservations
          WHERE order_id=?
          ORDER BY created_at DESC
          LIMIT 1
        `).get(req.params.id) as { id: string; status: string } | undefined;

        if (reservation?.status === "ACTIVE") {
          inventoryService.markPicked({
            reservationId: reservation.id,
            operationId: `warehouse-pick-complete:${req.params.id}`,
          });
        } else if (
          reservation &&
          !["PICKED", "PACKED", "DISPATCHED"].includes(reservation.status)
        ) {
          throw new InventoryValidationError(
            "RESERVATION_STATE_CONFLICT",
            `Warehouse picking completed but inventory reservation is ${reservation.status}.`,
            409,
          );
        }

        return completed;
      })();

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
  router.get("/admin/packages/:id/print-preview", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:print_labels", "warehouse:receive"]), (req, res) => {
    try { res.json({ success: true, data: { purpose: "GOODS_RECEIPT_PACKAGE", ...printingService.packageSnapshot(req.params.id) } }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/packages/:id/print", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:print_labels", "warehouse:receive"]), (req, res) => {
    try {
      const template = req.body?.template_snapshot as TemplateSnapshot;
      const snapshot = printingService.packageSnapshot(req.params.id);
      const payload = { packageId: snapshot.subjectId, templateId: template?.id ?? null, templateVersion: template?.version ?? null,
        templateContentHash: template?.contentHash ?? null, printerName: req.body?.printer_name ?? null };
      const outcome = commandExecutor.execute(commandRequest(req, res, "printing.goods-receipt-package.queue.v1", "warehouse:print_labels", payload), (context) => {
        const data = printingService.queueTemplateJob({ purpose: "GOODS_RECEIPT_PACKAGE", ...snapshot, template,
          operationId: operationIdFromRequest(req), actorId: actor(res).id, printerName: req.body?.printer_name });
        if (!data.logical_replay) context.addOutbox({ topic: "printing", eventType: "printing.job.queued.v1", aggregateType: "print_job", aggregateId: data.id, payload: { job_id: data.id, purpose: data.purpose } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.print-job.v1", data } };
      });
      res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/packages/:id/release-receiving", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:manage_receiving_sessions"), (req, res) => {
    try { res.json({ success: true, data: adminService.releaseReceivingPackage(req.params.id, actor(res), String(req.body?.device_id || "")) }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.get("/admin/print-jobs", authenticate("read:warehouse_orders"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (req, res) => {
    res.json({ success: true, contract: "dsdst.print-job.v1", data: printingService.listJobs(Number(req.query.limit) || 100) });
  });
  router.post("/admin/print-jobs/:id/reprint", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (req, res) => {
    try {
      const payload = { originalJobId: req.params.id, reason: req.body?.reason ?? null, explanation: req.body?.explanation ?? null };
      const outcome = commandExecutor.execute(commandRequest(req, res, "printing.job.reprint.v1", "warehouse:print_labels", payload), (context) => {
        const data = printingService.reprint({ originalJobId: req.params.id, reason: req.body?.reason as ReprintReason,
          explanation: req.body?.explanation, operationId: operationIdFromRequest(req), actorId: actor(res).id });
        if (!data.logical_replay) context.addOutbox({ topic: "printing", eventType: "printing.job.reprint-queued.v1", aggregateType: "print_job", aggregateId: data.id,
          payload: { job_id: data.id, original_job_id: req.params.id, reason: req.body?.reason } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.print-job.v1", data } };
      });
      res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
    } catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/print-jobs/:id/confirm", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (req, res) => {
    try {
      const payload = { jobId: req.params.id, physicalConfirmation: true };
      const outcome = commandExecutor.execute(commandRequest(req, res, "printing.job.confirm.v1", "warehouse:print_labels", payload), () => ({
        statusCode: 200, body: { success: true, contract: "dsdst.print-job.v1",
          data: printingService.confirm(req.params.id, operationIdFromRequest(req), actor(res).id) },
      }));
      res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
    } catch (error) { return handleServiceError(res, error); }
  });

  router.get("/admin/locations", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:manage_locations", "warehouse:place_packages", "warehouse:move_stock"]), (_req, res) => {
    res.json({ success: true, data: adminService.listLocations() });
  });
  router.get("/admin/locations/:id/print-preview", authenticate("read:products"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:manage_locations", "warehouse:print_labels"]), (req, res) => {
    try { res.json({ success: true, data: { purpose: "LOCATION", ...printingService.locationSnapshot(req.params.id) } }); }
    catch (error) { return handleServiceError(res, error); }
  });
  router.post("/admin/locations/:id/print", authenticate("write:warehouse_status"), requireWarehouseUser, requireAnyWarehousePermission(["warehouse:manage_locations", "warehouse:print_labels"]), (req, res) => {
    try {
      const input = req.body || {};
      const operationId = operationIdFromRequest(req);
      const printerName = String(input.printer_name ?? "").trim().slice(0, 160) || null;
      const template = input.template_snapshot as TemplateSnapshot;
      const snapshot = printingService.locationSnapshot(req.params.id);
      const capability = userHasWarehousePermission(actor(res), "warehouse:print_labels")
        ? "warehouse:print_labels"
        : "warehouse:manage_locations";
      const outcome = commandExecutor.execute(commandRequest(
        req,
        res,
        "warehouse.location-label.queue.v1",
        capability,
        { location_id: snapshot.subjectId, printer_name: printerName, template_id: template?.id ?? null,
          template_version: template?.version ?? null, template_content_hash: template?.contentHash ?? null },
      ), (context) => {
        const data = printingService.queueTemplateJob({ purpose: "LOCATION", ...snapshot, template, operationId,
          actorId: actor(res).id, printerName });
        if (!data.logical_replay) context.addOutbox({ topic: "printing", eventType: "printing.job.queued.v1", aggregateType: "print_job", aggregateId: data.id, payload: { job_id: data.id, purpose: data.purpose } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.print-job.v1", data } };
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
    return errorResponse(res, 410, "V2_WAREHOUSE_EXECUTION_REQUIRED", "Legacy placement is closed; use /execution/packages/:id/place.");
  });
  router.post("/admin/moves", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:move_stock"), (req, res) => {
    return errorResponse(res, 410, "V2_WAREHOUSE_EXECUTION_REQUIRED", "Legacy movement is closed; use /execution/packages/:id/move.");
  });
  router.post("/admin/stock-counts", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:count_stock"), (req, res) => {
    return errorResponse(res, 410, "V2_WAREHOUSE_EXECUTION_REQUIRED", "Legacy count mutation is closed; use /execution/counts.");
  });

  router.get("/admin/label-templates", authenticate("read:products"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (_req, res) => {
    return errorResponse(res, 410, "LABEL_TEMPLATE_AUTHORITY_MOVED", "Label Printer is the sole template/version authority.");
  });
  router.post("/admin/label-templates", authenticate("write:warehouse_status"), requireWarehouseUser, requireWarehousePermission("warehouse:print_labels"), (_req, res) => {
    return errorResponse(res, 410, "LABEL_TEMPLATE_AUTHORITY_MOVED", "Panel does not edit label templates; use Label Printer.");
  });

  return router;
}

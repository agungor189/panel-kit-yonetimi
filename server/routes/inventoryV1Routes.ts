import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { InventoryService, InventoryValidationError } from "../modules/inventory/inventoryService.js";
import { ProfileCutInventoryService } from "../modules/inventory/profileCutInventoryService.js";
import { SalesFinancialService, SalesFinancialValidationError } from "../modules/sales/salesFinancialService.js";

type Dependencies = {
  db: Database.Database;
  authorizeRead: RequestHandler;
  authorizeReceipt: RequestHandler;
  authorizeReserve: RequestHandler;
  authorizeRelease: RequestHandler;
  authorizeWarehouse: RequestHandler;
  authorizeDispatch: RequestHandler;
  authorizeCorrection: RequestHandler;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || req.headers["idempotency-key"] || "").trim();

const sendError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError || error instanceof InventoryValidationError || error instanceof SalesFinancialValidationError) {
    return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  }
  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT")) {
    return res.status(409).json({ success: false, error: { code: "INVENTORY_IDENTITY_CONFLICT", message: "Inventory identity already exists." } });
  }
  throw error;
};

export function createInventoryV1Router(dependencies: Dependencies) {
  const router = express.Router();
  const inventory = new InventoryService(dependencies.db);
  const profileCuts = new ProfileCutInventoryService(dependencies.db);
  const salesFinancials = new SalesFinancialService(dependencies.db);
  const commands = new CommandExecutor(dependencies.db);
  const execute = (req: express.Request, capability: string, commandType: string, payload: unknown, handler: Parameters<CommandExecutor["execute"]>[1]) => commands.execute({
    operationId: operationId(req),
    commandType,
    payload,
    actor: { human: { id: req.user!.id, name: req.user!.username } },
    authorization: { decision: "ALLOW", capability },
    correlationId: req.headers["x-correlation-id"]?.toString(),
    requestId: req.headers["x-request-id"]?.toString(),
  }, handler);
  const send = (res: express.Response, outcome: ReturnType<CommandExecutor["execute"]>) =>
    res.status(outcome.result.statusCode).json({ ...(outcome.result.body as Record<string, unknown>), idempotent: outcome.replayed });

  router.get("/products/:id/availability", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.inventory-availability.v1", data: inventory.getProductAvailability(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });
  router.get("/products/:id/reconciliation", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.inventory-reconciliation.v1", data: inventory.getProductReconciliation(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });
  router.get("/reservations/:id", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.inventory-reservation.v1", data: inventory.getReservation(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });
  router.get("/reservations/:id/fulfillment", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.inventory-fulfillment.v1", data: inventory.getFulfillmentState(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });

  router.post("/receipts", dependencies.authorizeReceipt, (req, res) => {
    try {
      const payload = req.body || {};
      const outcome = execute(req, "inventory:receive", "inventory.receipt.approve.v1", payload, (context) => {
        const data = inventory.receiveCostedLot({ ...payload, operationId: operationId(req) });
        context.addOutbox({ topic: "inventory", eventType: "inventory.receipt.posted.v1", aggregateType: "inventory_lot", aggregateId: data.lot.id, payload: { lot_id: data.lot.id, product_id: data.lot.productId, quantity_base_int: data.lot.receivedQuantityBaseInt } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.inventory-receipt.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/orders/:orderId/reservation", dependencies.authorizeReserve, (req, res) => {
    try {
      const payload = { orderId: req.params.orderId, reservationId: req.body?.reservationId ?? null, lines: req.body?.lines ?? null, profileCutPlans: req.body?.profileCutPlans ?? null, createdAt: req.body?.createdAt ?? null };
      const outcome = execute(req, "inventory:reserve", "inventory.order.reserve.v1", payload, (context) => {
        const data = inventory.reserveOrder({ ...payload, operationId: operationId(req) });
        context.addOutbox({ topic: "inventory", eventType: "inventory.order.reserved.v1", aggregateType: "reservation", aggregateId: data.id, payload: { reservation_id: data.id, order_id: data.orderId } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.inventory-reservation.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/reservations/:id/profile-cuts/execute", dependencies.authorizeWarehouse, (req, res) => {
    try {
      const payload = { reservationId: req.params.id, executedAt: req.body?.executedAt ?? null };
      const outcome = execute(req, "warehouse:pick_orders", "inventory.profile-cuts.execute.v1", payload, (context) => {
        const data = profileCuts.executeReservationCuts({ reservationId: req.params.id, operationId: operationId(req), actorId: req.user!.id, executedAt: req.body?.executedAt });
        context.addOutbox({ topic: "inventory", eventType: "inventory.profile-cuts.executed.v1", aggregateType: "reservation", aggregateId: req.params.id, payload: { reservation_id: req.params.id, execution_count: data.executions.length } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.profile-cut-execution.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/reservations/:id/release", dependencies.authorizeRelease, (req, res) => {
    try {
      const payload = { reservationId: req.params.id, reason: req.body?.reason ?? null, releasedAt: req.body?.releasedAt ?? null };
      const outcome = execute(req, "inventory:release", "inventory.reservation.release.v1", payload, (context) => {
        const data = inventory.releaseReservation({ ...payload, operationId: operationId(req) });
        context.addOutbox({ topic: "inventory", eventType: "inventory.reservation.released.v1", aggregateType: "reservation", aggregateId: data.id, payload: { reservation_id: data.id, order_id: data.orderId } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-reservation.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  for (const transition of ["pick", "pack"] as const) {
    router.post(`/reservations/:id/${transition}`, dependencies.authorizeWarehouse, (req, res) => {
      try {
        const payload = { reservationId: req.params.id, at: req.body?.at ?? null };
        const commandType = `inventory.reservation.${transition}.v1`;
        const outcome = execute(req, "warehouse:pick_orders", commandType, payload, (context) => {
          const data = transition === "pick"
            ? inventory.markPicked({ reservationId: req.params.id, pickedAt: req.body?.at, operationId: operationId(req) })
            : inventory.markPacked({ reservationId: req.params.id, packedAt: req.body?.at, operationId: operationId(req) });
          context.addOutbox({ topic: "inventory", eventType: `${commandType.replace(".v1", "ed.v1")}`, aggregateType: "reservation", aggregateId: data.id, payload: { reservation_id: data.id } });
          return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-reservation.v1", data } };
        });
        return send(res, outcome);
      } catch (error) { return sendError(error, res); }
    });
  }

  router.post("/reservations/:id/dispatch", dependencies.authorizeDispatch, (req, res) => {
    try {
      const payload = { reservationId: req.params.id, shipmentId: req.body?.shipmentId ?? null, dispatchedAt: req.body?.dispatchedAt ?? null };
      const outcome = execute(req, "shipping:dispatch", "inventory.reservation.dispatch.v1", payload, (context) => {
        const data = inventory.dispatchReservation({ ...payload, operationId: operationId(req) });
        const financial = salesFinancials.finalizeDispatch({
          reservationId: req.params.id,
          operationId: operationId(req),
          actor: { id: req.user!.id, name: req.user!.username },
          finalizedAt: req.body?.dispatchedAt,
        });
        context.addOutbox({ topic: "inventory", eventType: "inventory.shipment.dispatched.v1", aggregateType: "reservation", aggregateId: data.id, payload: { reservation_id: data.id, shipment_id: data.shipmentId } });
        if (financial && financial.state !== "LEGACY_UNSNAPSHOTTED") {
          context.addOutbox({ topic: "sales-finance", eventType: "sales.cogs.finalized.v1", aggregateType: "sale", aggregateId: financial.saleId, payload: { sale_id: financial.saleId, reservation_id: data.id, cogs_base_try_minor: financial.totals.actualCogsTryMinor } });
        }
        return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-dispatch.v1", data: { ...data, financialState: financial?.state ?? null } } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/reservations/:id/discrepancies", dependencies.authorizeWarehouse, (req, res) => {
    try {
      const payload = { reservationId: req.params.id, lotId: req.body?.lotId ?? null, locationId: req.body?.locationId ?? null, reason: req.body?.reason ?? null };
      const outcome = execute(req, "warehouse:count_stock", "inventory.stock-discrepancy.report.v1", payload, (context) => {
        const data = inventory.reportStockDiscrepancy({ ...payload, operationId: operationId(req) });
        context.addOutbox({ topic: "inventory", eventType: "inventory.stock-discrepancy.reported.v1", aggregateType: "reservation", aggregateId: req.params.id, payload: { reservation_id: req.params.id, lot_id: payload.lotId } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-fulfillment.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/lots/:id/corrections", dependencies.authorizeCorrection, (req, res) => {
    try {
      const payload = { lotId: req.params.id, ...req.body };
      const outcome = execute(req, "inventory:correct", "inventory.lot.correct.v1", payload, (context) => {
        const data = inventory.correctLot({ ...payload, operationId: operationId(req) });
        context.addOutbox({ topic: "inventory", eventType: "inventory.lot.corrected.v1", aggregateType: "inventory_lot", aggregateId: req.params.id, payload: { lot_id: req.params.id, delta_base_int: data.deltaBaseInt, approval_reference: data.approvalReference } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.inventory-correction.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  return router;
}

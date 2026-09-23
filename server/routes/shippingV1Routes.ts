import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import {
  FailClosedGeliverTransport,
  GELIVER_TRANSPORT_CONTRACT,
  ShipmentService,
  ShipmentValidationError,
} from "../modules/shipping/shipmentService.js";

type Dependencies = {
  db: Database.Database;
  authorizeRead: RequestHandler;
  authorizePrepare: RequestHandler;
  authorizeManage: RequestHandler;
  authorizeDispatch: RequestHandler;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || req.headers["idempotency-key"] || "").trim();
const actor = (req: express.Request) => ({ id: req.user!.id, name: req.user!.username });

const sendError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError || error instanceof ShipmentValidationError) {
    return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  }
  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT")) {
    return res.status(409).json({ success: false, error: { code: "SHIPMENT_IDENTITY_CONFLICT", message: "Shipment identity already exists." } });
  }
  throw error;
};

export function createShippingV1Router(dependencies: Dependencies) {
  const router = express.Router();
  const service = new ShipmentService(dependencies.db);
  const commands = new CommandExecutor(dependencies.db);
  const failClosedTransport = new FailClosedGeliverTransport();
  const execute = (req: express.Request, capability: string, commandType: string, payload: unknown, handler: Parameters<CommandExecutor["execute"]>[1]) => commands.execute({
    operationId: operationId(req), commandType, payload, actor: { human: actor(req) },
    authorization: { decision: "ALLOW", capability }, correlationId: req.headers["x-correlation-id"]?.toString(),
    requestId: req.headers["x-request-id"]?.toString(),
  }, handler);
  const send = (res: express.Response, outcome: ReturnType<CommandExecutor["execute"]>) =>
    res.status(outcome.result.statusCode).json({ ...(outcome.result.body as Record<string, unknown>), idempotent: outcome.replayed });

  router.get("/provider-contracts/geliver", dependencies.authorizeRead, (_req, res) =>
    res.json({ success: true, contract: "dsdst.carrier-provider-contract.v1", data: GELIVER_TRANSPORT_CONTRACT }));
  router.get("/shipments/:id", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.shipment.v1", data: service.getShipment(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });
  router.get("/reservations/:id/shipment", dependencies.authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.shipment.v1", data: service.getShipmentForReservation(req.params.id) }); }
    catch (error) { return sendError(error, res); }
  });

  router.post("/reservations/:id/pack", dependencies.authorizePrepare, (req, res) => {
    const payload = { reservationId: req.params.id, packedAt: req.body?.packedAt ?? null };
    try {
      const outcome = execute(req, "warehouse:pick_orders", "shipping.prepare-packed.v1", payload, (context) => {
        const data = service.packAndPrepare({ reservationId: req.params.id, operationId: operationId(req), actor: actor(req), packedAt: req.body?.packedAt });
        context.addOutbox({ topic: "shipping", eventType: "shipping.preparation.created.v1", aggregateType: "shipment",
          aggregateId: data.shipment.id, payload: { shipment_id: data.shipment.id, order_id: data.shipment.orderId, reservation_id: data.shipment.reservationId } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/shipments/:id/packages", dependencies.authorizeManage, (req, res) => {
    const payload = { shipmentId: req.params.id, packages: req.body?.packages ?? null };
    try {
      const outcome = execute(req, "shipping:manage", "shipping.packages.define.v1", payload, (context) => {
        const packages = service.definePackages({ shipmentId: req.params.id, packages: req.body?.packages,
          operationId: operationId(req), actor: actor(req) });
        context.addOutbox({ topic: "shipping", eventType: "shipping.packages.defined.v1", aggregateType: "shipment",
          aggregateId: req.params.id, payload: { shipment_id: req.params.id, package_count: packages.length } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.shipment-packages.v1", data: packages } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/shipments/:id/carrier-selection", dependencies.authorizeManage, (req, res) => {
    const payload = { shipmentId: req.params.id, ...req.body };
    try {
      const outcome = execute(req, "shipping:manage", "shipping.carrier.select.v1", payload, (context) => {
        const data = service.selectCarrier({ ...req.body, shipmentId: req.params.id, operationId: operationId(req), actor: actor(req) });
        context.addOutbox({ topic: "shipping", eventType: "shipping.carrier.selected.v1", aggregateType: "shipment",
          aggregateId: req.params.id, payload: { shipment_id: req.params.id, provider: data.carrierSelection.provider,
            carrier: data.carrierSelection.carrierCode, service: data.carrierSelection.serviceCode } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/shipments/:id/booking", dependencies.authorizeManage, (req, res) => {
    const payload = { shipmentId: req.params.id, requestedAt: req.body?.requestedAt ?? null };
    try {
      const outcome = execute(req, "shipping:manage", "shipping.booking.request.v1", payload, (context) => {
        const data = service.requestBooking({ shipmentId: req.params.id, operationId: operationId(req), actor: actor(req), requestedAt: req.body?.requestedAt });
        context.addOutbox({ topic: "carrier", eventType: "shipping.geliver.booking.requested.v1", aggregateType: "shipment",
          aggregateId: req.params.id, payload: { shipment_id: req.params.id, booking_job_ids: data.jobs.map((job) => job.id),
            transport_enabled: GELIVER_TRANSPORT_CONTRACT.enabled } });
        return { statusCode: 202, body: { success: true, contract: "dsdst.shipment-booking.v1", data,
          providerTransport: { ...GELIVER_TRANSPORT_CONTRACT, verifiedCapabilities: [...GELIVER_TRANSPORT_CONTRACT.verifiedCapabilities] } } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/shipments/:id/cancel", dependencies.authorizeManage, (req, res) => {
    const payload = { shipmentId: req.params.id, reason: req.body?.reason ?? null, cancelledAt: req.body?.cancelledAt ?? null };
    try {
      const outcome = execute(req, "shipping:manage", "shipping.cancel.v1", payload, (context) => {
        const data = service.cancelBeforeHandoff({ shipmentId: req.params.id, reason: req.body?.reason,
          operationId: operationId(req), actor: actor(req), transport: failClosedTransport, cancelledAt: req.body?.cancelledAt });
        context.addOutbox({ topic: "shipping", eventType: "shipping.cancelled.v1", aggregateType: "shipment",
          aggregateId: req.params.id, payload: { shipment_id: req.params.id, state: data.state } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/notification-policies/:sourceChannel", dependencies.authorizeManage, (req, res) => {
    const payload = { sourceChannel: req.params.sourceChannel, emailEnabled: req.body?.emailEnabled,
      smsEnabled: req.body?.smsEnabled };
    try {
      const outcome = execute(req, "shipping:manage", "shipping.notification-policy.set.v1", payload, () => {
        if (typeof req.body?.emailEnabled !== "boolean" || typeof req.body?.smsEnabled !== "boolean") {
          throw new ShipmentValidationError("SHIPMENT_VALIDATION_FAILED", "emailEnabled and smsEnabled must be boolean.");
        }
        const data = service.setNotificationPolicy({ ...payload, emailEnabled: req.body.emailEnabled, smsEnabled: req.body.smsEnabled,
          operationId: operationId(req), actor: actor(req) });
        return { statusCode: 200, body: { success: true, contract: "dsdst.shipment-notification-policy.v1", data } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/shipments/:id/handoff", dependencies.authorizeDispatch, (req, res) => {
    const payload = { shipmentId: req.params.id, handedOffAt: req.body?.handedOffAt ?? null,
      handoffEvidence: req.body?.handoffEvidence ?? null, actualCharge: req.body?.actualCharge ?? null };
    try {
      const outcome = execute(req, "shipping:dispatch", "shipping.handoff.confirm.v1", payload, (context) => {
        const data = service.confirmHandoff({ shipmentId: req.params.id, handedOffAt: req.body?.handedOffAt,
          handoffEvidence: req.body?.handoffEvidence, actualCharge: req.body?.actualCharge,
          operationId: operationId(req), actor: actor(req) });
        for (const event of data.outbox) context.addOutbox(event);
        context.addOutbox({ topic: "shipping", eventType: "shipping.dispatched.v1", aggregateType: "shipment",
          aggregateId: req.params.id, payload: { shipment_id: req.params.id, reservation_id: data.shipment.reservationId } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.shipment.v1", data: data.shipment } };
      });
      return send(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  return router;
}

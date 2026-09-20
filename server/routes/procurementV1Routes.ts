import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { ExchangeRateService, ExchangeRateValidationError } from "../modules/finance/exchangeRates.js";
import { MoneyValidationError } from "../modules/finance/money.js";
import { ProcurementService, ProcurementValidationError } from "../modules/procurement/procurementService.js";

type Dependencies = {
  db: Database.Database;
  authorizeProcurement: RequestHandler;
  authorizeCostApproval: RequestHandler;
  authorizePayment: RequestHandler;
  authorizeFx: RequestHandler;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || "").trim();

const execute = (commands: CommandExecutor, req: express.Request, capability: string, commandType: string, payload: unknown, handler: Parameters<CommandExecutor["execute"]>[1]) => (
  commands.execute({
    operationId: operationId(req),
    commandType,
    payload,
    actor: { human: { id: req.user!.id, name: req.user!.username } },
    authorization: { decision: "ALLOW", capability },
    correlationId: req.headers["x-correlation-id"]?.toString(),
    requestId: req.headers["x-request-id"]?.toString(),
  }, handler)
);

const sendOutcome = (res: express.Response, outcome: ReturnType<CommandExecutor["execute"]>) => (
  res.status(outcome.result.statusCode).json({ ...(outcome.result.body as Record<string, unknown>), idempotent: outcome.replayed })
);

const sendError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError) return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  if (error instanceof ProcurementValidationError) return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  if (error instanceof ExchangeRateValidationError || error instanceof MoneyValidationError) {
    return res.status(400).json({ success: false, error: { code: "MONEY_VALIDATION_FAILED", message: error.message } });
  }
  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT_UNIQUE")) {
    return res.status(409).json({ success: false, error: { code: "PROCUREMENT_IDENTITY_CONFLICT", message: "Procurement identity already exists." } });
  }
  throw error;
};

export function createProcurementV1Router({ db, authorizeProcurement, authorizeCostApproval, authorizePayment, authorizeFx }: Dependencies) {
  const router = express.Router();
  const procurement = new ProcurementService(db);
  const fx = new ExchangeRateService(db);
  const commands = new CommandExecutor(db);

  router.get("/fx/usd-try", (_req, res) => res.json({ success: true, contract: "dsdst.fx-current.v1", data: fx.getCurrentUsdTry() }));

  router.post("/fx/usd-try", authorizeFx, (req, res) => {
    try {
      const payload = { rate: req.body?.rate, source: req.body?.source };
      const outcome = execute(commands, req, "fx:write", "finance.fx.usd-try.set-current.v1", payload, (context) => {
        const data = fx.recordCurrentUsdTry({ ...payload, changedAt: new Date().toISOString(), actorId: req.user!.id, actorType: "HUMAN" });
        context.addOutbox({ topic: "finance.fx", eventType: "finance.fx.current-changed.v1", aggregateType: "fx_pair", aggregateId: "USD/TRY", payload: { observation_id: data.observationId } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.fx-current.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/suppliers", authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, "procurement:write", "procurement.supplier.register.v1", req.body, (context) => {
        const data = procurement.registerSupplier(req.body);
        context.addOutbox({ topic: "procurement", eventType: "procurement.supplier.registered.v1", aggregateType: "supplier", aggregateId: data.id, payload: { supplier_id: data.id } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.procurement.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases", authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, "procurement:write", "procurement.purchase.create.v1", req.body, (context) => {
        const data = procurement.createPurchase(req.body);
        context.addOutbox({ topic: "procurement", eventType: "procurement.purchase.created.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, status: data.status } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.procurement.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.get("/purchases/:id", (req, res) => {
    try {
      const data = procurement.getPurchase(req.params.id);
      if (!data) return res.status(404).json({ success: false, error: { code: "PURCHASE_NOT_FOUND", message: "Purchase was not found." } });
      return res.json({ success: true, contract: "dsdst.procurement.v1", data });
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/finalize-costs", authorizeCostApproval, (req, res) => {
    try {
      const payload = { purchaseId: req.params.id, allocations: req.body?.allocations };
      const outcome = execute(commands, req, "acquisition-cost:approve", "procurement.acquisition-cost.finalize.v1", payload, (context) => {
        const data = procurement.finalizeAcquisitionCosts(req.params.id, req.body);
        context.addOutbox({ topic: "procurement", eventType: "procurement.acquisition-cost.finalized.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, planned_lot_ids: data.lots.map((lot: any) => lot.id) } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.acquisition-cost.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/payments", authorizePayment, (req, res) => {
    try {
      const payload = { purchaseId: req.params.id, payment: req.body };
      const outcome = execute(commands, req, "finance:write", "procurement.purchase-payment.record.v1", payload, (context) => {
        const data = procurement.recordPayment(req.params.id, req.body);
        context.addOutbox({ topic: "finance", eventType: "finance.purchase-payment.posted.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, payment_id: data.recordedPaymentId, payment_status: data.paymentStatus } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.purchase-payment.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  return router;
}

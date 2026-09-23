import express, { type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { ReturnsService, ReturnsValidationError } from "../modules/returns/returnsService.js";

type Dependencies = {
  db: Database.Database;
  authorizeRead: RequestHandler;
  authorizeCreate: RequestHandler;
  authorizeRefund: RequestHandler;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || req.headers["idempotency-key"] || "").trim();

const sendError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError || error instanceof ReturnsValidationError) {
    return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  }
  throw error;
};

export function createReturnsV1Router({ db, authorizeRead, authorizeCreate, authorizeRefund }: Dependencies) {
  const router = express.Router();
  const returns = new ReturnsService(db);
  const commands = new CommandExecutor(db);
  const execute = (req: express.Request, capability: string, commandType: string, payload: unknown, handler: Parameters<CommandExecutor["execute"]>[1]) => commands.execute({
    operationId: operationId(req), commandType, payload,
    actor: { human: { id: req.user!.id, name: req.user!.username } },
    authorization: { decision: "ALLOW", capability },
    correlationId: req.headers["x-correlation-id"]?.toString(), requestId: req.headers["x-request-id"]?.toString(),
  }, handler);

  router.get("/sales/:saleId", authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.returns.v1", data: returns.getSaleReturns(req.params.saleId) }); }
    catch (error) { return sendError(error, res); }
  });
  router.get("/:returnId", authorizeRead, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.returns.v1", data: returns.getReturn(req.params.returnId) }); }
    catch (error) { return sendError(error, res); }
  });
  router.post("/sales/:saleId", authorizeCreate, (req, res) => {
    const payload = { saleId: req.params.saleId, lines: req.body?.lines ?? null, customerShippingRefund: req.body?.customerShippingRefund ?? null, requestedAt: req.body?.requestedAt ?? null };
    try {
      const outcome = execute(req, "returns:create", "returns.request.create.v1", payload, (context) => {
        const data = returns.createReturnRequest({ ...payload, operationId: operationId(req), actor: { id: req.user!.id, name: req.user!.username } } as any);
        context.addOutbox({ topic: "returns", eventType: "returns.request.approved.v1", aggregateType: "return", aggregateId: data.id, payload: { return_id: data.id, sale_id: req.params.saleId } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.returns.v1", data } };
      });
      return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
    } catch (error) { return sendError(error, res); }
  });
  router.post("/:returnId/refunds", authorizeRefund, (req, res) => {
    const payload = { returnId: req.params.returnId, amountMinor: req.body?.amountMinor ?? null, cashAccountId: req.body?.cashAccountId ?? null,
      approvalReference: req.body?.approvalReference ?? null, approvedAt: req.body?.approvedAt ?? null };
    try {
      const outcome = execute(req, "returns:approve_refund", "returns.refund.approve-and-pay.v1", payload, (context) => {
        const data = returns.approveRefund({ ...payload, operationId: operationId(req), actor: { id: req.user!.id, name: req.user!.username } } as any);
        const payment = data.refunds.at(-1);
        context.addOutbox({ topic: "returns-finance", eventType: "returns.refund.approved.v1", aggregateType: "return", aggregateId: data.id,
          payload: { return_id: data.id, payment_id: payment?.id, amount_minor: payment?.amountMinor, payment_mode: payment?.paymentMode } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.returns.v1", data } };
      });
      return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });
    } catch (error) { return sendError(error, res); }
  });
  return router;
}

import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { ExchangeRateService, ExchangeRateValidationError } from "../modules/finance/exchangeRates.js";
import { MoneyValidationError } from "../modules/finance/money.js";
import { ProcurementService, ProcurementValidationError } from "../modules/procurement/procurementService.js";
import { persistUpload, removeStoredUpload } from "../services/uploadSecurity.js";

type Dependencies = {
  db: Database.Database;
  authorizeProcurement: RequestHandler;
  authorizeCostApproval: RequestHandler;
  authorizePayment: RequestHandler;
  authorizeFx: RequestHandler;
  uploadsDir?: string;
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

export function createProcurementV1Router({ db, authorizeProcurement, authorizeCostApproval, authorizePayment, authorizeFx, uploadsDir }: Dependencies) {
  const router = express.Router();
  const procurement = new ProcurementService(db);
  const fx = new ExchangeRateService(db);
  const commands = new CommandExecutor(db);
  const documentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

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

  router.get("/suppliers", authorizeProcurement, (_req, res) => res.json({ success: true, contract: "dsdst.procurement-suppliers.v1", data: procurement.listSuppliers() }));

  router.get("/purchases", authorizeProcurement, (_req, res) => res.json({ success: true, contract: "dsdst.procurement-list.v1", data: procurement.listPurchases() }));

  router.post("/purchases/csv-preview", authorizeProcurement, (req, res) => {
    try { return res.json({ success: true, contract: "dsdst.procurement-csv-preview.v1", data: procurement.previewCsv(req.body?.rows) }); }
    catch (error) { return sendError(error, res); }
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

  router.get("/products/:productId/history", authorizeProcurement, (req, res) => {
    try {
      return res.json({
        success: true,
        contract: "dsdst.procurement-product-history.v1",
        data: procurement.getProductPurchaseHistory(req.params.productId),
      });
    } catch (error) { return sendError(error, res); }
  });

  router.get("/purchases/:id", authorizeProcurement, (req, res) => {
    try {
      const data = procurement.getPurchase(req.params.id);
      if (!data) return res.status(404).json({ success: false, error: { code: "PURCHASE_NOT_FOUND", message: "Purchase was not found." } });
      return res.json({ success: true, contract: "dsdst.procurement.v1", data });
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/costs", authorizeProcurement, (req, res) => {
    try {
      const payload = { purchaseId: req.params.id, cost: req.body };
      const outcome = execute(commands, req, "procurement:write", "procurement.acquisition-cost.add.v1", payload, (context) => {
        const data = procurement.addAcquisitionCost(req.params.id, req.body);
        const component = data.acquisitionCosts[data.acquisitionCosts.length - 1];
        context.addOutbox({ topic: "procurement", eventType: "procurement.acquisition-cost.added.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, component_id: component?.id } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.acquisition-cost.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/workflow", authorizeProcurement, (req, res) => {
    try {
      const payload = { purchaseId: req.params.id, state: req.body?.state };
      const outcome = execute(commands, req, "procurement:write", "procurement.purchase.workflow-transition.v1", payload, (context) => {
        const data = procurement.transitionWorkflow(req.params.id, req.body?.state);
        context.addOutbox({ topic: "procurement", eventType: "procurement.purchase.state-changed.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, state: data.workflowState } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.procurement-workflow.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/approve-receipt", authorizeCostApproval, (req, res) => {
    try {
      const payload = { purchaseId: req.params.id };
      const outcome = execute(commands, req, "acquisition-cost:approve", "procurement.purchase.approve-receipt.v1", payload, (context) => {
        const data = procurement.approveForReceipt(req.params.id, req.user!.id);
        context.addOutbox({ topic: "warehouse", eventType: "warehouse.receipt-intent.approved.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, cost_snapshot_ids: data.lots.map((lot: any) => lot.id) } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.procurement-receipt-approval.v1", data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });

  router.post("/purchases/:id/documents", authorizeProcurement, documentUpload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: { code: "DOCUMENT_REQUIRED", message: "A document file is required." } });
    let stored: Awaited<ReturnType<typeof persistUpload>> | null = null;
    try {
      const sha256 = createHash("sha256").update(req.file.buffer).digest("hex");
      const payload = { purchaseId: req.params.id, documentType: req.body?.documentType, costComponentId: req.body?.costComponentId || null, fileName: req.file.originalname, mediaType: req.file.mimetype, sizeBytes: req.file.size, sha256 };
      const outcome = execute(commands, req, "procurement:write", "procurement.document.attach.v1", payload, (context) => {
        throw new Error("ASYNC_UPLOAD_HANDLER_REQUIRED");
      });
      return sendOutcome(res, outcome);
    } catch (error) {
      // CommandExecutor is synchronous; perform the inspected filesystem write first,
      // then execute the replay-safe DB command. Replays never call this handler.
      if (String((error as Error)?.message) !== "ASYNC_UPLOAD_HANDLER_REQUIRED") return sendError(error, res);
      try {
        if (!uploadsDir) throw new ProcurementValidationError("UPLOAD_STORAGE_UNAVAILABLE", "Procurement document storage is not configured.", 503);
        stored = await persistUpload({ uploadsDir, folder: "procurement", prefix: "document", originalName: req.file.originalname,
          declaredMime: req.file.mimetype, buffer: req.file.buffer, allowedMimes: ["image/jpeg","image/png","image/webp","application/pdf"] });
        const sha256 = createHash("sha256").update(req.file.buffer).digest("hex");
        const payload = { purchaseId: req.params.id, documentType: req.body?.documentType, costComponentId: req.body?.costComponentId || null, fileName: req.file.originalname, mediaType: stored.mimeType, sizeBytes: stored.size, sha256 };
        const commandOutcome = execute(commands, req, "procurement:write", "procurement.document.attach.v1", payload, (context) => {
          const data = procurement.recordDocument({ ...payload, storageReference: stored!.publicPath, uploadedBy: req.user!.id });
          context.addOutbox({ topic: "procurement", eventType: "procurement.document.attached.v1", aggregateType: "purchase_order", aggregateId: data.id, payload: { purchase_id: data.id, sha256 } });
          return { statusCode: 201, body: { success: true, contract: "dsdst.procurement-document.v1", data } };
        });
        return sendOutcome(res, commandOutcome);
      } catch (writeError) {
        if (stored) removeStoredUpload(uploadsDir, stored.publicPath);
        return sendError(writeError, res);
      }
    }
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

  router.post("/purchases/:id/cost-preview", authorizeProcurement, (req, res) => {
    try {
      const data = procurement.previewAcquisitionCosts(req.params.id, req.body);
      return res.json({ success: true, contract: "dsdst.acquisition-cost-preview.v1", data });
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

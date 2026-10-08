import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import multer from "multer";
import { createHash } from "node:crypto";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { ExchangeRateService, ExchangeRateValidationError } from "../modules/finance/exchangeRates.js";
import { MoneyValidationError } from "../modules/finance/money.js";
import { ProcurementService, ProcurementValidationError } from "../modules/procurement/procurementService.js";
import { ProcurementImportService } from '../modules/procurement/procurementImportService.js';
import { SupplierAliasRepairService } from '../modules/procurement/supplierAliasRepairService.js';
import { ImportValidationError } from '../modules/procurement/procurementImport.js';
import { CatalogValidationError } from '../modules/catalog/catalogService.js';
import { persistUpload, removeStoredUpload } from "../services/uploadSecurity.js";

type Dependencies = {
  db: Database.Database;
  authorizeProcurement: RequestHandler;
  authorizeCostApproval: RequestHandler;
  authorizePayment: RequestHandler;
  authorizeFx: RequestHandler;
  authorizeCatalog?: RequestHandler;
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
  if (error instanceof ImportValidationError || error instanceof CatalogValidationError) return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
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

export function createProcurementV1Router({ db, authorizeProcurement, authorizeCostApproval, authorizePayment, authorizeFx, authorizeCatalog, uploadsDir }: Dependencies) {
  const router = express.Router();
  const procurement = new ProcurementService(db);
  const fx = new ExchangeRateService(db);
  const commands = new CommandExecutor(db);
  const importer = new ProcurementImportService(db);
  const aliasRepair = new SupplierAliasRepairService(db);
  router.get('/imports/alias-repair/:supplierId', authorizeProcurement, (req, res) => {
    try { return res.json({ success: true, contract: 'dsdst.procurement.alias-repair-preview.v1', data: aliasRepair.preview(req.params.supplierId) }); }
    catch (error) { return sendError(error,res); }
  });
  router.post('/imports/alias-repair/:supplierId/apply', authorizeProcurement, authorizeCatalog || ((_req, res) => { res.status(403).json({ error: { code: 'CATALOG_AUTHORIZATION_REQUIRED' } }); }), (req, res) => {
    try {
      const outcome = execute(commands,req,'procurement:write+catalog:write','procurement.alias-repair.apply.v1', { supplierId: req.params.supplierId, evidence: req.body }, context => {
        const data = aliasRepair.apply(req.params.supplierId,req.body,req.user!.id);
        context.addOutbox({ topic: 'catalog', eventType: 'catalog.supplier-aliases.retracted.v1', aggregateType: 'supplier', aggregateId: req.params.supplierId, payload: { supplierId: req.params.supplierId, manifestHash: data.manifestHash } });
        return { statusCode: 200, body: { success: true, contract: 'dsdst.procurement.alias-repair.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.get('/imports/alias-repair/:supplierId/compensate/:alias', authorizeProcurement, (req, res) => {
    try { return res.json({ success: true, contract: 'dsdst.procurement.alias-repair-preview.v1', data: aliasRepair.previewCompensation(req.params.supplierId,req.params.alias) }); }
    catch (error) { return sendError(error,res); }
  });
  router.post('/imports/alias-repair/:supplierId/compensate', authorizeProcurement, authorizeCatalog || ((_req, res) => { res.status(403).json({ error: { code: 'CATALOG_AUTHORIZATION_REQUIRED' } }); }), (req, res) => {
    try {
      const outcome = execute(commands,req,'procurement:write+catalog:write','procurement.alias-repair.compensate.v1', { supplierId: req.params.supplierId, evidence: req.body }, context => {
        const data = aliasRepair.compensate(req.params.supplierId,req.body.alias,req.body,req.user!.id);
        context.addOutbox({ topic: 'catalog', eventType: 'catalog.supplier-alias.restored.v1', aggregateType: 'supplier', aggregateId: req.params.supplierId, payload: { supplierId: req.params.supplierId, alias: data.alias } });
        return { statusCode: 200, body: { success: true, contract: 'dsdst.procurement.alias-repair.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.post('/imports/preview', authorizeProcurement, (req, res) => {
    try { return res.json({ success: true, contract: 'dsdst.procurement.import.v1', data: importer.preview(req.body) }); }
    catch (error) { return sendError(error, res); }
  });
  router.post('/imports/apply', authorizeProcurement, authorizeCatalog || ((_req, res) => { res.status(403).json({ error: { code: 'CATALOG_AUTHORIZATION_REQUIRED' } }); }), (req, res) => {
    try {
      const outcome = execute(commands, req, 'procurement:write+catalog:write', 'procurement.import.apply.v1', req.body, context => {
        const data = importer.apply(req.body, req.user!.id, operationId(req));
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.import.drafted.v1', aggregateType: 'procurement_import_draft', aggregateId: data.id, payload: { draftId: data.id } });
        return { statusCode: 201, body: { success: true, contract: 'dsdst.procurement.import.v1', data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });
  router.post('/imports/drafts/:id/cancel', authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands,req,'procurement:write','procurement.import-draft.cancel.v1', { draftId:req.params.id }, context => {
        const data = importer.cancelDraft(req.params.id,req.user!.id,operationId(req));
        context.addOutbox({ topic:'procurement',eventType:'procurement.import-draft.cancelled.v1',
          aggregateType:'procurement_import_draft',aggregateId:req.params.id,payload:{ draftId:req.params.id } });
        return { statusCode:200,body:{ success:true,contract:'dsdst.procurement.import-draft.v1',data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.post('/imports/drafts/:id/complete', authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, 'procurement:write', 'procurement.import.complete.v1', { draftId: req.params.id, policy: req.body }, context => {
        const data = importer.completeDraft(req.params.id, req.body, req.user!.id);
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.import.created.v1', aggregateType: 'purchase_order', aggregateId: data.id, payload: { purchaseId: data.id } });
        return { statusCode: 201, body: { success: true, contract: 'dsdst.procurement.import.v1', data } };
      });
      return sendOutcome(res, outcome);
    } catch (error) { return sendError(error, res); }
  });
  router.post('/imports/drafts/:id/costs', authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, 'procurement:write', 'procurement.import-draft.cost.add.v1', { draftId: req.params.id, cost: req.body }, context => {
        const data = importer.addDraftCost(req.params.id,req.body,req.user!.id,operationId(req));
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.import-draft.cost-changed.v1', aggregateType: 'procurement_import_draft', aggregateId: req.params.id, payload: { draftId: req.params.id } });
        return { statusCode: 201, body: { success: true, contract: 'dsdst.procurement.import-draft.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.post('/imports/drafts/:id/costs/:costId/update', authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, 'procurement:write', 'procurement.import-draft.cost.update.v1', { draftId: req.params.id, costId: req.params.costId, cost: req.body }, context => {
        const data = importer.updateDraftCost(req.params.id,req.params.costId,req.body,req.user!.id,operationId(req));
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.import-draft.cost-changed.v1', aggregateType: 'procurement_import_draft', aggregateId: req.params.id, payload: { draftId: req.params.id } });
        return { statusCode: 200, body: { success: true, contract: 'dsdst.procurement.import-draft.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.post('/imports/drafts/:id/costs/:costId/remove', authorizeProcurement, (req, res) => {
    try {
      const outcome = execute(commands, req, 'procurement:write', 'procurement.import-draft.cost.remove.v1', { draftId: req.params.id, costId: req.params.costId, expectedVersion: req.body?.expectedVersion }, context => {
        const data = importer.deleteDraftCost(req.params.id,req.params.costId,req.body?.expectedVersion,req.user!.id,operationId(req));
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.import-draft.cost-changed.v1', aggregateType: 'procurement_import_draft', aggregateId: req.params.id, payload: { draftId: req.params.id } });
        return { statusCode: 200, body: { success: true, contract: 'dsdst.procurement.import-draft.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
  router.post('/imports/drafts/:id/cost-preview', authorizeCostApproval, (req, res) => {
    try { return res.json({ success:true,contract:'dsdst.procurement.import-draft-cost-preview.v1',
      data:importer.previewDraftCost(req.params.id,req.body,req.user!.id) }); }
    catch (error) { return sendError(error,res); }
  });
  router.post('/imports/drafts/:id/finalize', authorizeCostApproval, (req, res) => {
    try {
      const outcome = execute(commands, req, 'acquisition-cost:approve', 'procurement.import-draft.finalize.v1', { draftId: req.params.id, decision: req.body }, context => {
        const data = importer.finalizeDraft(req.params.id,req.body,req.user!.id);
        context.addOutbox({ topic: 'procurement', eventType: 'procurement.acquisition-cost.finalized.v1', aggregateType: 'purchase_order', aggregateId: data.id, payload: { purchase_id: data.id, planned_lot_ids: data.lots.map((lot: any) => lot.id) } });
        return { statusCode: 200, body: { success: true, contract: 'dsdst.acquisition-cost.v1', data } };
      });
      return sendOutcome(res,outcome);
    } catch (error) { return sendError(error,res); }
  });
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

  router.get("/purchases", authorizeProcurement, (_req, res) => res.json({ success: true, contract: "dsdst.procurement-list.v1", data: [...importer.listDrafts(), ...procurement.listPurchases()] }));

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
      const data = procurement.getPurchase(req.params.id) || importer.getDraft(req.params.id);
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

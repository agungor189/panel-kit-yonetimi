import express, { type RequestHandler } from "express";
import type Database from "better-sqlite3";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { ReconciliationError, ReconciliationService } from "../modules/reconciliation/reconciliationService.js";
import { ReconciliationRepairExecutor } from "../modules/reconciliation/reconciliationRepairExecutor.js";

type Dependencies = { db: Database.Database; authorizeRead: RequestHandler; authorizeRun: RequestHandler; authorizePropose: RequestHandler; authorizeApprove: RequestHandler };
const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || req.headers["idempotency-key"] || req.body?.operation_id || "").trim();
const sendError = (value: unknown, res: express.Response) => {
  if (value instanceof ReconciliationError || value instanceof CommandFoundationError) return res.status(value.statusCode).json({ success: false, error: { code: value.code, message: value.message } });
  throw value;
};

export function createReconciliationV1Router(deps: Dependencies) {
  const router = express.Router(); const service = new ReconciliationService(deps.db); const repairs = new ReconciliationRepairExecutor(deps.db, service); const commands = new CommandExecutor(deps.db);
  const execute = (req: express.Request, capability: string, commandType: string, payload: unknown, handler: Parameters<CommandExecutor["execute"]>[1]) => commands.execute({
    operationId: operationId(req), commandType, payload, actor: { human: { id: req.user!.id, name: req.user!.username } }, authorization: { decision: "ALLOW", capability },
    correlationId: req.headers["x-correlation-id"]?.toString(), requestId: req.headers["x-request-id"]?.toString(),
  }, handler);
  const sendOutcome = (res: express.Response, outcome: ReturnType<typeof execute>) => res.status(outcome.result.statusCode).json({ ...(outcome.result.body as object), idempotent: outcome.replayed });

  router.get("/summary", deps.authorizeRead, (_req, res) => res.json({ success: true, contract: "dsdst.reconciliation.v1", data: service.summary() }));
  router.get("/findings", deps.authorizeRead, (req, res) => res.json({ success: true, contract: "dsdst.reconciliation.v1", data: service.listFindings({ status: req.query.status?.toString(), domain: req.query.domain?.toString(), severity: req.query.severity?.toString(), affectedType: req.query.affected_type?.toString() }) }));
  router.get("/findings/:id/history", deps.authorizeRead, (req, res) => { try { return res.json({ success: true, contract: "dsdst.reconciliation.v1", data: service.getHistory(req.params.id) }); } catch (value) { return sendError(value, res); } });
  router.get("/warehouse", deps.authorizeRead, (_req, res) => res.json({ success: true, contract: "dsdst.reconciliation.warehouse.v1", data: service.listFindings({ status: "OPEN", domain: "INVENTORY", affectedType: "SKU" }) }));

  router.post("/runs", deps.authorizeRun, (req, res) => {
    const payload = { trigger: "MANUAL", requestedAt: req.body?.requested_at || null };
    try { const outcome = execute(req, "reconciliation:run", "reconciliation.run.v1", payload, (context) => { const data = service.run({ trigger: "MANUAL", actor: { type: "HUMAN", id: req.user!.id }, operationId: operationId(req) }); context.addOutbox({ topic: "reconciliation", eventType: "reconciliation.run.completed.v1", aggregateType: "reconciliation_run", aggregateId: data.id, payload: { run_id: data.id, finding_count: data.finding_count, critical_count: data.critical_count } }); return { statusCode: 201, body: { success: true, contract: "dsdst.reconciliation.v1", data } }; }); return sendOutcome(res, outcome); }
    catch (value) { return sendError(value, res); }
  });
  router.post("/findings/:id/verify", deps.authorizeApprove, (req, res) => {
    const payload = { findingId: req.params.id, reason: req.body?.reason || null };
    try { const outcome = execute(req, "data:repair:approve", "reconciliation.finding.verify.v1", payload, (context) => { const data = service.verifyFinding({ findingId: req.params.id, reason: req.body?.reason, actorId: req.user!.id, actorIsAdmin: req.user!.role === "admin", operationId: operationId(req) }); context.addOutbox({ topic: "reconciliation", eventType: "reconciliation.finding.verified.v1", aggregateType: "reconciliation_finding", aggregateId: data.id, payload: { finding_id: data.id, affected_type: data.affectedType, affected_id: data.affectedId } }); return { statusCode: 200, body: { success: true, contract: "dsdst.reconciliation.v1", data } }; }); return sendOutcome(res, outcome); }
    catch (value) { return sendError(value, res); }
  });
  router.post("/findings/:id/repair-proposals", deps.authorizePropose, (req, res) => {
    const payload = { findingId: req.params.id, commandType: req.body?.command_type, commandPayload: req.body?.command_payload, reason: req.body?.reason };
    try { const outcome = execute(req, "data:repair:propose", "reconciliation.repair.propose.v1", payload, (context) => { const data = service.proposeRepair({ findingId: req.params.id, commandType: req.body?.command_type, commandPayload: req.body?.command_payload, reason: req.body?.reason, actorId: req.user!.id, operationId: operationId(req) }); context.addOutbox({ topic: "reconciliation-repair", eventType: "reconciliation.repair.proposed.v1", aggregateType: "repair_proposal", aggregateId: data.id, payload: { proposal_id: data.id, finding_id: req.params.id } }); return { statusCode: 201, body: { success: true, contract: "dsdst.reconciliation.v1", data } }; }); return sendOutcome(res, outcome); }
    catch (value) { return sendError(value, res); }
  });
  for (const action of ["approve", "reject"] as const) router.post(`/repair-proposals/:id/${action}`, deps.authorizeApprove, (req, res) => {
    const payload = { proposalId: req.params.id, reason: req.body?.reason };
    try { const outcome = execute(req, "data:repair:approve", `reconciliation.repair.${action}.v1`, payload, (context) => { const common = { proposalId: req.params.id, reason: req.body?.reason, actorId: req.user!.id, actorIsAdmin: req.user!.role === "admin", operationId: operationId(req) }; const data = action === "approve" ? service.approveRepair(common) : service.rejectRepair(common); context.addOutbox({ topic: "reconciliation-repair", eventType: `reconciliation.repair.${action}d.v1`, aggregateType: "repair_proposal", aggregateId: data.id, payload: { proposal_id: data.id, finding_id: data.finding_id } }); return { statusCode: 200, body: { success: true, contract: "dsdst.reconciliation.v1", data } }; }); return sendOutcome(res, outcome); }
    catch (value) { return sendError(value, res); }
  });
  router.post("/repair-proposals/:id/execute", deps.authorizeApprove, (req, res) => {
    const payload = { proposalId: req.params.id };
    try { const outcome = execute(req, "data:repair:apply", "reconciliation.repair.execute.v1", payload, (context) => { const data = repairs.execute({ proposalId: req.params.id, actorId: req.user!.id, operationId: operationId(req) }); context.addOutbox({ topic: "reconciliation-repair", eventType: "reconciliation.repair.applied.v1", aggregateType: "repair_proposal", aggregateId: data.id, payload: { proposal_id: data.id, finding_id: data.finding_id } }); return { statusCode: 200, body: { success: true, contract: "dsdst.reconciliation.v1", data } }; }); return sendOutcome(res, outcome); }
    catch (value) { return sendError(value, res); }
  });
  return router;
}

import type Database from "better-sqlite3";
import express, { type NextFunction, type RequestHandler } from "express";
import { userHasCapability } from "../modules/auth/permissions.js";
import type { AuthenticatedUser } from "../modules/auth/types.js";
import { CommandExecutor, CommandFoundationError, type JsonValue } from "../modules/commands/commandFoundation.js";
import { PublishedKitService, PublishedKitValidationError, type KitPublicationProposal } from "../modules/kits/publishedKitService.js";

type Dependencies = {
  db: Database.Database;
  authenticateService: RequestHandler;
  authenticateUserToken: (token: string, servicePrincipalId: string) => AuthenticatedUser | null;
};

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || req.headers["idempotency-key"] || "").trim();

const sendError = (error: unknown, res: express.Response) => {
  if (error instanceof PublishedKitValidationError || error instanceof CommandFoundationError) {
    return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  }
  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT")) {
    return res.status(409).json({ success: false, error: { code: "KIT_PUBLICATION_CONFLICT", message: "Published kit identity or version already exists." } });
  }
  throw error;
};

export function createKitPublicationV1Router({ db, authenticateService, authenticateUserToken }: Dependencies) {
  const router = express.Router();
  const service = new PublishedKitService(db);
  const commands = new CommandExecutor(db);
  router.use(authenticateService);
  router.use((req, res, next) => {
    const authorization = req.headers.authorization || "";
    const user = authorization.startsWith("Bearer ") && req.panelApiKey
      ? authenticateUserToken(authorization.slice("Bearer ".length), req.panelApiKey.id)
      : null;
    if (!user) return res.status(401).json({ success: false, error: { code: "USER_UNAUTHORIZED", message: "A valid service-bound human session is required." } });
    if (user.must_change_password) return res.status(403).json({ success: false, error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Password change is required before kit publication." } });
    if (!userHasCapability(user, "kits:approve")) return res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "kits:approve capability is required." } });
    req.user = user;
    return next();
  });

  router.post("/preview", (req, res) => {
    try {
      return res.json({ success: true, contract: "dsdst.kit-publication-preview.v1", data: service.preview(req.body as KitPublicationProposal) });
    } catch (error) { return sendError(error, res); }
  });

  router.get("/policy", (_req, res) => {
    const policy = db.prepare("SELECT kerf_mm,formula_version,updated_at FROM kit_publication_settings WHERE id='default'").get();
    return res.json({ success: true, contract: "dsdst.kit-publication-policy.v1", data: policy });
  });

  router.put("/policy", (req, res) => {
    try {
      const kerfMm = req.body?.kerfMm;
      if (!Number.isSafeInteger(kerfMm) || Number(kerfMm) < 0) {
        return res.status(400).json({ success: false, error: { code: "INVALID_KERF", message: "kerfMm must be a non-negative integer millimeter value." } });
      }
      const payload = { kerfMm: Number(kerfMm), formulaVersion: String(req.body?.formulaVersion || "dsdst.kit-cost.v1") };
      const outcome = commands.execute({
        operationId: operationId(req), commandType: "kit.publication-policy.update.v1", payload,
        actor: { human: { id: req.user!.id, name: req.user!.username }, service: { id: req.panelApiKey!.id, name: req.panelApiKey!.name } },
        authorization: { decision: "ALLOW", capability: "kits:approve" },
      }, (context) => {
        db.prepare("UPDATE kit_publication_settings SET kerf_mm=?,formula_version=?,updated_at=CURRENT_TIMESTAMP WHERE id='default'").run(payload.kerfMm, payload.formulaVersion);
        const data = db.prepare("SELECT kerf_mm,formula_version,updated_at FROM kit_publication_settings WHERE id='default'").get() as Record<string, unknown>;
        context.addOutbox({ topic: "catalog", eventType: "kit.publication-policy.updated.v1", aggregateType: "kit_publication_policy", aggregateId: "default", payload: data as any });
        return { statusCode: 200, body: { success: true, contract: "dsdst.kit-publication-policy.v1", data: data as JsonValue } };
      });
      return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as Record<string, unknown>), idempotent: outcome.replayed });
    } catch (error) { return sendError(error, res); }
  });

  router.post("/publish", (req, res) => {
    try {
      const payload = {
        proposal: req.body?.proposal,
        approvedContentHash: req.body?.approvedContentHash,
        approvedPolicyHash: req.body?.approvedPolicyHash,
      };
      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "kit.publication.publish.v1",
        payload,
        actor: {
          human: { id: req.user!.id, name: req.user!.username },
          service: { id: req.panelApiKey!.id, name: req.panelApiKey!.name },
        },
        authorization: { decision: "ALLOW", capability: "kits:approve" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, (context) => {
        const data = service.publish({
          proposal: payload.proposal as KitPublicationProposal,
          approvedContentHash: String(payload.approvedContentHash || ""),
          approvedPolicyHash: String(payload.approvedPolicyHash || ""),
          operationId: operationId(req),
          actor: { id: req.user!.id, name: req.user!.username },
          service: { id: req.panelApiKey!.id, name: req.panelApiKey!.name },
        });
        context.addOutbox({ topic: "catalog", eventType: "kit.publication.published.v1", aggregateType: "published_kit", aggregateId: data.publishedKitId, payload: { published_kit_id: data.publishedKitId, product_id: data.productId, version_id: data.versionId, version_number: data.versionNumber, content_hash: data.contentHash } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.kit-publication.v1", data } };
      });
      return res.status(outcome.result.statusCode).json({ ...(outcome.result.body as Record<string, unknown>), idempotent: outcome.replayed });
    } catch (error) { return sendError(error, res); }
  });

  router.get("/:id", (req, res) => {
    const data = service.getPublishedKit(req.params.id);
    return data
      ? res.json({ success: true, contract: "dsdst.published-kit.v1", data })
      : res.status(404).json({ success: false, error: { code: "PUBLISHED_KIT_NOT_FOUND", message: "Published kit was not found." } });
  });

  return router;
}

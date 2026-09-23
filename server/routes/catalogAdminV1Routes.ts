import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CatalogService, CatalogValidationError, type CatalogProductInput } from "../modules/catalog/catalogService.js";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";

type Dependencies = { db: Database.Database; authorize: RequestHandler };

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || "").trim();
const commandError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError) {
    return res.status(error.statusCode).json({ success: false, error: { code: error.code, message: error.message } });
  }
  if (error instanceof CatalogValidationError) {
    const conflict = /conflict/i.test(error.message);
    const code = error.code === "CATALOG_VALIDATION_FAILED" && conflict ? "CATALOG_VERSION_CONFLICT" : error.code;
    return res.status(error.statusCode || (conflict ? 409 : 400)).json({ success: false, error: { code, message: error.message } });
  }
  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT_UNIQUE")) {
    return res.status(409).json({ success: false, error: { code: "CATALOG_IDENTITY_CONFLICT", message: "Catalog ID or SKU already exists." } });
  }
  throw error;
};

export function createCatalogAdminV1Router({ db, authorize }: Dependencies) {
  const router = express.Router();
  const catalog = new CatalogService(db);
  const commands = new CommandExecutor(db);
  router.use(authorize);

  router.post("/products", (req, res) => {
    try {
      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "catalog.product.create.v1",
        payload: req.body,
        actor: { human: { id: req.user!.id, name: req.user!.username } },
        authorization: { decision: "ALLOW", capability: "catalog:write" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, (context) => {
        const product = catalog.createProduct(req.body as CatalogProductInput);
        context.addOutbox({ topic: "catalog", eventType: "catalog.product.versioned.v1", aggregateType: "catalog_product", aggregateId: product.id, payload: { product_id: product.id, catalog_version_ref: product.catalog_version_ref } });
        return { statusCode: 201, body: { success: true, contract: "dsdst.catalog-product.v1", data: product } };
      });
      return res.status(outcome.result.statusCode).json({ ...outcome.result.body, idempotent: outcome.replayed });
    } catch (error) {
      return commandError(error, res);
    }
  });

  router.put("/products/:id", (req, res) => {
    try {
      const expectedVersion = Number(req.body?.expected_catalog_version);
      const productInput = req.body?.product as CatalogProductInput;
      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "catalog.product.update.v1",
        payload: { product_id: req.params.id, expected_catalog_version: expectedVersion, product: productInput },
        actor: { human: { id: req.user!.id, name: req.user!.username } },
        authorization: { decision: "ALLOW", capability: "catalog:write" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, (context) => {
        const product = catalog.updateProduct(req.params.id, expectedVersion, productInput);
        context.addOutbox({ topic: "catalog", eventType: "catalog.product.versioned.v1", aggregateType: "catalog_product", aggregateId: product.id, payload: { product_id: product.id, catalog_version_ref: product.catalog_version_ref } });
        return { statusCode: 200, body: { success: true, contract: "dsdst.catalog-product.v1", data: product } };
      });
      return res.status(outcome.result.statusCode).json({ ...outcome.result.body, idempotent: outcome.replayed });
    } catch (error) {
      return commandError(error, res);
    }
  });

  return router;
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CatalogService, CatalogValidationError, type CatalogProductInput } from "../modules/catalog/catalogService.js";
import { CommandExecutor, CommandFoundationError } from "../modules/commands/commandFoundation.js";
import { enqueueCanonicalChannelChanges } from "../modules/channels/channelOutboundProjection.js";
import { generateNormalizedFields } from "../utils/normalizeProductFields.js";

type Dependencies = { db: Database.Database; authorize: RequestHandler };

const operationId = (req: express.Request) => String(req.headers["x-operation-id"] || "").trim();

const commandError = (error: unknown, res: express.Response) => {
  if (error instanceof CommandFoundationError) {
    return res.status(error.statusCode).json({
      success: false,
      error: { code: error.code, message: error.message },
    });
  }

  if (error instanceof CatalogValidationError) {
    const conflict = /conflict/i.test(error.message);
    const code =
      error.code === "CATALOG_VALIDATION_FAILED" && conflict
        ? "CATALOG_VERSION_CONFLICT"
        : error.code;

    return res.status(error.statusCode || (conflict ? 409 : 400)).json({
      success: false,
      error: { code, message: error.message },
    });
  }

  if (String((error as { code?: unknown })?.code || "").includes("SQLITE_CONSTRAINT_UNIQUE")) {
    return res.status(409).json({
      success: false,
      error: {
        code: "CATALOG_IDENTITY_CONFLICT",
        message: "Catalog ID or SKU already exists.",
      },
    });
  }

  throw error;
};

const hasOwn = (value: unknown, key: string) =>
  Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));

const cleanText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
};

const nonNegativeNumber = (value: unknown, field: string, fallback = 0): number => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CatalogValidationError(`${field} must be a non-negative number.`);
  }
  return parsed;
};

const nonNegativeInteger = (value: unknown, field: string, fallback = 0): number => {
  const parsed = nonNegativeNumber(value, field, fallback);
  if (!Number.isSafeInteger(parsed)) {
    throw new CatalogValidationError(`${field} must be a non-negative integer.`);
  }
  return parsed;
};

const persistOperationalMetadata = (
  db: Database.Database,
  productId: string,
  rawOperational: unknown,
  opId: string,
) => {
  if (!rawOperational || typeof rawOperational !== "object" || Array.isArray(rawOperational)) return;

  const operational = rawOperational as Record<string, any>;

  if (
    hasOwn(operational, "central_stock")
    || hasOwn(operational, "total_stock")
    || hasOwn(operational, "stock")
    || (Array.isArray(operational.platforms)
      && operational.platforms.some((platform: any) => hasOwn(platform, "stock")))
  ) {
    throw new CatalogValidationError(
      "Inventory quantities must be changed through procurement/inventory commands.",
      "INVENTORY_COMMAND_REQUIRED",
      409,
    );
  }

  const before = db.prepare("SELECT * FROM products WHERE id=?").get(productId) as any;
  if (!before) throw new CatalogValidationError("Catalog product was not found.");

  const value = (key: string) =>
    hasOwn(operational, key) ? operational[key] : before[key];

  const supplierCode = cleanText(value("supplier_code"));

  if (supplierCode) {
    const conflict = db.prepare(`
      SELECT id,sku
      FROM products
      WHERE supplier_code=? COLLATE NOCASE
        AND id<>?
      LIMIT 1
    `).get(supplierCode, productId) as any;

    if (conflict) {
      throw new CatalogValidationError(
        `Supplier code '${supplierCode}' is already used by ${conflict.sku || conflict.id}.`,
        "SUPPLIER_CODE_CONFLICT",
        409,
      );
    }
  }

  const nameTr = cleanText(value("name_tr"));
  const nameEn = cleanText(value("name_en"));
  const category = cleanText(value("category"));
  const material = cleanText(value("material")) || category;
  const model = cleanText(value("model"));
  const size = cleanText(value("size"));
  const pipeSize = cleanText(value("pipe_size"));
  const displayName = nameTr || nameEn || cleanText(before.title) || cleanText(before.sku);

  const normalized = generateNormalizedFields({
    ...before,
    ...operational,
    name: displayName,
    title: before.title,
    material,
    category,
    model,
    size,
    pipe_size: pipeSize,
  });

  const previousSalePrice = Number(before.sale_price || 0);
  const salePrice = nonNegativeNumber(
    value("sale_price"),
    "sale_price",
    previousSalePrice,
  );

  db.prepare(`
    UPDATE products
    SET
      name=?,
      name_tr=?,
      name_en=?,
      warehouse_location=?,
      supplier_code=?,
      barcode=?,
      category=?,
      model=?,
      product_series=?,
      tube_type_code=?,
      form_code=?,
      description=?,
      purchase_price_usd=?,
      purchase_cost=?,
      sale_price=?,
      buffer_percentage=?,
      profit_percentage=?,
      exchange_rate_used=?,
      price_locked=?,
      notes=?,
      material=?,
      size=?,
      pipe_size=?,
      connection_type=?,
      usage_area=?,
      supplier=?,
      min_stock_level=?,
      normalized_material=?,
      normalized_model=?,
      normalized_size=?,
      normalized_tube_type=?,
      normalized_pipe_size=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    displayName,
    nameTr,
    nameEn,
    cleanText(value("warehouse_location")),
    supplierCode,
    cleanText(value("barcode")),
    category,
    model,
    cleanText(value("product_series")),
    cleanText(value("tube_type_code")),
    cleanText(value("form_code")),
    cleanText(value("description")),
    nonNegativeNumber(value("purchase_price_usd"), "purchase_price_usd", Number(before.purchase_price_usd || 0)),
    nonNegativeNumber(value("purchase_cost"), "purchase_cost", Number(before.purchase_cost || 0)),
    salePrice,
    nonNegativeNumber(value("buffer_percentage"), "buffer_percentage", Number(before.buffer_percentage || 0)),
    nonNegativeNumber(value("profit_percentage"), "profit_percentage", Number(before.profit_percentage || 0)),
    nonNegativeNumber(value("exchange_rate_used"), "exchange_rate_used", Number(before.exchange_rate_used || 0)),
    Boolean(value("price_locked")) ? 1 : 0,
    cleanText(value("notes")),
    material,
    size,
    pipeSize,
    cleanText(value("connection_type")),
    cleanText(value("usage_area")),
    cleanText(value("supplier")),
    nonNegativeInteger(value("min_stock_level"), "min_stock_level", Number(before.min_stock_level || 0)),
    normalized.normalized_material,
    normalized.normalized_model,
    normalized.normalized_size,
    normalized.normalized_tube_type,
    normalized.normalized_pipe_size,
    productId,
  );

  if (Array.isArray(operational.platforms)) {
    const findPlatform = db.prepare(`
      SELECT id
      FROM product_platforms
      WHERE product_id=? AND platform_name=?
      LIMIT 1
    `);

    const updatePlatform = db.prepare(`
      UPDATE product_platforms
      SET price=?,is_listed=?
      WHERE id=?
    `);

    const insertPlatform = db.prepare(`
      INSERT INTO product_platforms
        (id,product_id,platform_name,stock,price,is_listed)
      VALUES (?,?,?,?,?,?)
    `);

    for (const platform of operational.platforms) {
      const platformName = cleanText(platform?.name ?? platform?.platform_name);
      if (!platformName) continue;

      if (hasOwn(platform, "stock")) {
        throw new CatalogValidationError(
          "Platform stock cannot be mutated from ProductWizard.",
          "INVENTORY_COMMAND_REQUIRED",
          409,
        );
      }

      const price = nonNegativeNumber(
        platform?.price,
        `platforms.${platformName}.price`,
        salePrice,
      );

      const listed = platform?.is_listed === true ? 1 : 0;
      const existing = findPlatform.get(productId, platformName) as any;

      if (existing) {
        updatePlatform.run(price, listed, existing.id);
      } else {
        insertPlatform.run(
          randomUUID(),
          productId,
          platformName,
          0,
          price,
          listed,
        );
      }
    }
  }

  if (previousSalePrice !== salePrice) {
    enqueueCanonicalChannelChanges(db, {
      productId,
      kinds: ["PRICE"],
      operationId: opId,
    });
  }
};

export function createCatalogAdminV1Router({ db, authorize }: Dependencies) {
  const router = express.Router();
  const catalog = new CatalogService(db);
  const commands = new CommandExecutor(db);

  router.use(authorize);

  router.post("/products", (req, res) => {
    try {
      const productInput = (req.body?.product ?? req.body) as CatalogProductInput;
      const operational = req.body?.product ? req.body?.operational : undefined;

      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "catalog.product.create.v1",
        payload: req.body,
        actor: { human: { id: req.user!.id, name: req.user!.username } },
        authorization: { decision: "ALLOW", capability: "catalog:write" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, (context) => {
        const created = catalog.createProduct(productInput);

        persistOperationalMetadata(
          db,
          created.id,
          operational,
          operationId(req),
        );

        const product = catalog.getProduct(created.id)!;

        context.addOutbox({
          topic: "catalog",
          eventType: "catalog.product.versioned.v1",
          aggregateType: "catalog_product",
          aggregateId: product.id,
          payload: {
            product_id: product.id,
            catalog_version_ref: product.catalog_version_ref,
          },
        });

        return {
          statusCode: 201,
          body: {
            success: true,
            contract: "dsdst.catalog-product.v1",
            data: product,
          },
        };
      });

      return res.status(outcome.result.statusCode).json({
        ...outcome.result.body,
        idempotent: outcome.replayed,
      });
    } catch (error) {
      return commandError(error, res);
    }
  });

  router.put("/products/:id", (req, res) => {
    try {
      const expectedVersion = Number(req.body?.expected_catalog_version);
      const productInput = req.body?.product as CatalogProductInput;
      const operational = req.body?.operational;

      const outcome = commands.execute({
        operationId: operationId(req),
        commandType: "catalog.product.update.v1",
        payload: {
          product_id: req.params.id,
          expected_catalog_version: expectedVersion,
          product: productInput,
          ...(operational !== undefined ? { operational } : {}),
        },
        actor: { human: { id: req.user!.id, name: req.user!.username } },
        authorization: { decision: "ALLOW", capability: "catalog:write" },
        correlationId: req.headers["x-correlation-id"]?.toString(),
        requestId: req.headers["x-request-id"]?.toString(),
      }, (context) => {
        const updated = catalog.updateProduct(
          req.params.id,
          expectedVersion,
          productInput,
        );

        persistOperationalMetadata(
          db,
          updated.id,
          operational,
          operationId(req),
        );

        const product = catalog.getProduct(updated.id)!;

        context.addOutbox({
          topic: "catalog",
          eventType: "catalog.product.versioned.v1",
          aggregateType: "catalog_product",
          aggregateId: product.id,
          payload: {
            product_id: product.id,
            catalog_version_ref: product.catalog_version_ref,
          },
        });

        return {
          statusCode: 200,
          body: {
            success: true,
            contract: "dsdst.catalog-product.v1",
            data: product,
          },
        };
      });

      return res.status(outcome.result.statusCode).json({
        ...outcome.result.body,
        idempotent: outcome.replayed,
      });
    } catch (error) {
      return commandError(error, res);
    }
  });

  return router;
}

import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";
import { CatalogService, type CatalogType } from "../modules/catalog/catalogService.js";
import { UOM_DEFINITIONS, UOM_REGISTRY_VERSION } from "../modules/catalog/uom.js";

type Dependencies = { db: Database.Database; authenticate: RequestHandler };

export function createCatalogV1Router({ db, authenticate }: Dependencies) {
  const router = express.Router();
  const catalog = new CatalogService(db);
  router.use(authenticate);

  router.get("/uoms", (_req, res) => {
    const conversions = db.prepare(`SELECT from_uom_code AS "from", to_uom_code AS "to", numerator,
      denominator, version, version_ref, effective_from FROM uom_conversions
      WHERE retired_at IS NULL ORDER BY from_uom_code, to_uom_code`).all();
    res.json({
      success: true,
      contract: "dsdst.catalog-uom.v1",
      data: {
        registry_version: UOM_REGISTRY_VERSION,
        units: UOM_DEFINITIONS.map((unit) => ({
          code: unit.code,
          dimension: unit.dimension,
          base_quantum: unit.baseQuantum,
          quantity_scale: unit.quantityScale,
          registry_version: UOM_REGISTRY_VERSION,
        })),
        conversions,
      },
    });
  });

  router.get("/products", (req, res) => {
    const requested = typeof req.query.catalog_type === "string" ? req.query.catalog_type : undefined;
    const type = requested && ["product", "profile", "connector", "cap", "wheel", "complementary", "KIT"].includes(requested)
      ? requested as CatalogType
      : undefined;
    res.json({ success: true, contract: "dsdst.catalog-product.v1", data: catalog.listProducts(type) });
  });

  router.get("/profiles", (_req, res) => {
    res.json({ success: true, contract: "dsdst.catalog-product.v1", data: catalog.listProducts("profile") });
  });

  router.get("/products/:id", (req, res) => {
    const product = catalog.getProduct(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: { code: "CATALOG_PRODUCT_NOT_FOUND", message: "Catalog product not found" } });
    return res.json({ success: true, contract: "dsdst.catalog-product.v1", data: product });
  });

  return router;
}

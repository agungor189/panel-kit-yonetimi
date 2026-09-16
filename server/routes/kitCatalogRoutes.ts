import type Database from "better-sqlite3";
import express, { type RequestHandler } from "express";

type KitCatalogDependencies = {
  db: Database.Database;
  authenticate: RequestHandler;
  logActivity?: (action: string, entityType: string, entityId: string, details?: unknown) => void;
};

const CONNECTOR_COLUMNS = `
  p.id,
  p.sku,
  COALESCE(p.name_tr, p.name, p.title) AS name_tr,
  p.name_en,
  p.title,
  p.supplier_code,
  p.material,
  p.form_code,
  p.form_code AS form,
  p.tube_type_code,
  p.size_code,
  p.normalized_model AS model,
  p.size,
  p.pipe_size,
  p.normalized_material,
  p.normalized_size,
  p.normalized_tube_type,
  p.normalized_pipe_size,
  COALESCE(pi.path, '') AS image,
  COALESCE(p.purchase_cost, 0) AS stored_purchase_cost,
  COALESCE(p.purchase_price_usd, 0) AS purchase_price_usd,
  COALESCE(p.exchange_rate_used, 0) AS exchange_rate_used,
  COALESCE(p.sale_price, 0) AS sale_price,
  COALESCE(p.central_stock, 0) AS central_stock,
  COALESCE(NULLIF(p.weight_grams, 0), NULLIF(p.weight, 0), 0) AS weight_grams,
  p.updated_at
`;

function activeUsdRate(db: Database.Database) {
  try {
    const active = db.prepare("SELECT rate FROM exchange_rates WHERE is_active=1 ORDER BY fetched_at DESC LIMIT 1").get() as { rate?: number } | undefined;
    if (Number(active?.rate) > 0) return Number(active?.rate);
  } catch { /* Legacy databases may not have the rate table yet. */ }
  return 0;
}

function configuredUsdRate(db: Database.Database) {
  try {
    const setting = db.prepare("SELECT value FROM settings WHERE key='usd_exchange_rate'").get() as { value?: string } | undefined;
    return Number(setting?.value) > 0 ? Number(setting?.value) : 0;
  } catch { return 0; }
}

function withResolvedPurchaseCost(row: any, currentUsdRate: number, fallbackUsdRate: number) {
  const { stored_purchase_cost, purchase_price_usd, exchange_rate_used, ...publicRow } = row;
  const storedCost = Number(stored_purchase_cost || 0);
  const usdCost = Number(purchase_price_usd || 0);
  const rate = currentUsdRate > 0 ? currentUsdRate : (Number(exchange_rate_used || 0) || fallbackUsdRate);
  return { ...publicRow, purchase_cost: storedCost > 0 ? storedCost : (usdCost > 0 && rate > 0 ? usdCost * rate : 0) };
}

export function createKitCatalogRouter({ db, authenticate, logActivity }: KitCatalogDependencies) {
  const router = express.Router();

  router.use(authenticate);

  router.get("/connectors", (req, res) => {
    const currentUsdRate = activeUsdRate(db);
    const fallbackUsdRate = configuredUsdRate(db);
    const rows = (db.prepare(`
      SELECT ${CONNECTOR_COLUMNS}
      FROM products p
      LEFT JOIN product_images pi ON pi.id = (
        SELECT id FROM product_images WHERE product_id = p.id ORDER BY sort_order, id LIMIT 1
      )
      WHERE COALESCE(p.visible_in_catalog, 1) = 1
        AND COALESCE(p.status, 'Active') = 'Active'
        AND COALESCE(p.product_type, 'simple') != 'kit'
      ORDER BY COALESCE(p.name_tr, p.name, p.title), p.sku
    `).all() as any[]).map((row) => withResolvedPurchaseCost(row, currentUsdRate, fallbackUsdRate));
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, count: rows.length });
    res.json({ success: true, data: rows });
  });

  router.get("/connectors/:id", (req, res) => {
    const rawRow = db.prepare(`
      SELECT ${CONNECTOR_COLUMNS}
      FROM products p
      LEFT JOIN product_images pi ON pi.id = (
        SELECT id FROM product_images WHERE product_id = p.id ORDER BY sort_order, id LIMIT 1
      )
      WHERE p.id = ?
        AND COALESCE(p.visible_in_catalog, 1) = 1
        AND COALESCE(p.status, 'Active') = 'Active'
        AND COALESCE(p.product_type, 'simple') != 'kit'
    `).get(req.params.id);
    if (!rawRow) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Connector not found" } });
    const row = withResolvedPurchaseCost(rawRow, activeUsdRate(db), configuredUsdRate(db));
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, connectorId: req.params.id });
    res.json({ success: true, data: row });
  });

  router.get("/profiles", (req, res) => {
    const rows = db.prepare(`
      SELECT
        p.*,
        COALESCE(preferred.price_per_meter, p.price_per_meter, 0) AS effective_price_per_meter,
        COALESCE(preferred.supplier, p.supplier) AS effective_supplier,
        preferred.id AS preferred_offer_id
      FROM kit_profiles p
      LEFT JOIN kit_profile_offers preferred ON preferred.id = (
        SELECT id FROM kit_profile_offers
        WHERE profile_id = p.id
        ORDER BY is_preferred DESC, price_per_meter ASC, id ASC
        LIMIT 1
      )
      WHERE COALESCE(p.is_active, 1) = 1
      ORDER BY p.name, p.id
    `).all();
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, count: rows.length });
    res.json({ success: true, data: rows });
  });

  router.get("/complementary-products", (req, res) => {
    const rows = db.prepare(`
      SELECT
        p.*,
        COALESCE(NULLIF(p.cover_image, ''), image.path, '') AS image
      FROM complementary_products p
      LEFT JOIN complementary_product_images image ON image.id = (
        SELECT id FROM complementary_product_images
        WHERE complementary_product_id = p.id
        ORDER BY sort_order ASC, created_at ASC, id ASC
        LIMIT 1
      )
      WHERE COALESCE(p.is_active, 1) = 1
      ORDER BY p.name, p.id
    `).all();
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, count: rows.length });
    res.json({ success: true, data: rows });
  });

  return router;
}

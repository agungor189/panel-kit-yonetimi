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
  p.size,
  p.pipe_size,
  p.normalized_material,
  p.normalized_size,
  p.normalized_tube_type,
  p.normalized_pipe_size,
  COALESCE(pi.path, '') AS image,
  COALESCE(p.purchase_cost, 0) AS purchase_cost,
  COALESCE(p.sale_price, 0) AS sale_price,
  COALESCE(p.central_stock, 0) AS central_stock,
  p.updated_at
`;

export function createKitCatalogRouter({ db, authenticate, logActivity }: KitCatalogDependencies) {
  const router = express.Router();

  router.use(authenticate);

  router.get("/connectors", (req, res) => {
    const rows = db.prepare(`
      SELECT ${CONNECTOR_COLUMNS}
      FROM products p
      LEFT JOIN product_images pi ON pi.id = (
        SELECT id FROM product_images WHERE product_id = p.id ORDER BY sort_order, id LIMIT 1
      )
      WHERE COALESCE(p.visible_in_catalog, 1) = 1
        AND COALESCE(p.status, 'Active') = 'Active'
        AND COALESCE(p.product_type, 'simple') != 'kit'
      ORDER BY COALESCE(p.name_tr, p.name, p.title), p.sku
    `).all();
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, count: rows.length });
    res.json({ success: true, data: rows });
  });

  router.get("/connectors/:id", (req, res) => {
    const row = db.prepare(`
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
    if (!row) return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Connector not found" } });
    logActivity?.("PANEL_API_USED", "kit_catalog", req.panelApiKey?.id || "unknown", { path: req.path, connectorId: req.params.id });
    res.json({ success: true, data: row });
  });

  return router;
}

import { Router } from "express";
import Database from "better-sqlite3";

export function createProductAnalyticsRouter(db: Database.Database) {
  const router = Router();

  const firstQueryValue = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value[0] ? String(value[0]) : undefined;
    if (value === undefined || value === null) return undefined;
    return String(value);
  };

  const isActiveFilter = (value: string | undefined) =>
    !!value && value !== 'Tümü' && value !== 'Hepsi';

  const normalizeEndDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value} 23:59:59` : value;

  const buildWhere = (req: any) => {
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const material = firstQueryValue(req.query.material);
    const model = firstQueryValue(req.query.model);
    const pipeSize = firstQueryValue(req.query.pipeSize ?? req.query.pipe_size);
    const tubeType = firstQueryValue(req.query.tubeType ?? req.query.tube_type);

    let productWhere = "p.status != 'deleted' AND COALESCE(p.exclude_from_analysis, 0) = 0 AND COALESCE(p.is_sellable, 1) = 1";
    const productParams: any[] = [];

    if (isActiveFilter(material)) {
      productWhere += " AND IFNULL(p.normalized_material, 'Bilinmiyor') = ?";
      productParams.push(material);
    }
    if (isActiveFilter(model)) {
      productWhere += " AND IFNULL(p.normalized_model, 'Bilinmiyor') = ?";
      productParams.push(model);
    }
    if (isActiveFilter(pipeSize)) {
      productWhere += " AND COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor') = ?";
      productParams.push(pipeSize);
    }
    if (isActiveFilter(tubeType)) {
      productWhere += " AND IFNULL(p.normalized_tube_type, 'Bilinmiyor') = ?";
      productParams.push(tubeType);
    }

    let salesWhere = "s.status NOT IN ('İptal Edildi', 'İade Edildi')";
    const salesParams: any[] = [];
    if (startDate) {
      salesWhere += " AND s.created_at >= ?";
      salesParams.push(startDate);
    }
    if (endDate) {
      salesWhere += " AND s.created_at <= ?";
      salesParams.push(normalizeEndDate(endDate));
    }

    return {
      productWhere,
      salesWhere,
      productParams,
      salesParams,
      queryParams: [...salesParams, ...productParams],
    };
  };

  const getSalesStatsJoin = (salesWhere: string) => `
    LEFT JOIN (
      SELECT
        si.product_id,
        SUM(si.quantity) as soldQty,
        SUM(si.unit_price * si.quantity) as revenue,
        MAX(s.created_at) as lastSaleDate
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE ${salesWhere}
      GROUP BY si.product_id
    ) ss ON ss.product_id = p.id
  `;

  const modelDisplayExpr = `
    CASE
      WHEN TRIM(COALESCE(p.normalized_model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.normalized_model)
      WHEN TRIM(COALESCE(p.model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.model)
      ELSE COALESCE(NULLIF(TRIM(p.title), ''), NULLIF(TRIM(p.name), ''), 'Model Belirtilmemiş')
    END
  `;
  const seriesExpr = "COALESCE(NULLIF(TRIM(p.product_series), ''), 'Bilinmiyor')";

  const stockExpr = `
    CASE
      WHEN EXISTS (SELECT 1 FROM product_bom b WHERE b.parent_product_id = p.id) THEN COALESCE((
        SELECT MIN(CAST(COALESCE(cp.central_stock, 0) / NULLIF(b.quantity_per_unit, 0) AS INTEGER))
        FROM product_bom b
        JOIN products cp ON cp.id = b.component_product_id
        WHERE b.parent_product_id = p.id
      ), 0)
      ELSE COALESCE(p.central_stock, 0)
    END
  `;

  // 0. Filter Options
  router.get("/products/filter-options", (req, res) => {
    try {
      const dbSizes = db.prepare(`
        SELECT DISTINCT COALESCE(normalized_pipe_size, normalized_size, 'Bilinmiyor') as val
        FROM products
        WHERE COALESCE(normalized_pipe_size, normalized_size, 'Bilinmiyor') != 'Bilinmiyor'
          AND COALESCE(exclude_from_analysis, 0) = 0
          AND COALESCE(is_sellable, 1) = 1
        ORDER BY val ASC
      `).all();
      
      const pipeSizes = ['Tümü', ...dbSizes.map((row: any) => row.val), 'Bilinmiyor'];
      res.json({ pipeSizes });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 1. Dashboard / Summary
  router.get("/products/summary", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere);
      
      const summary = db.prepare(`
        SELECT 
          COUNT(DISTINCT p.id) as totalSku,
          IFNULL(SUM(ss.soldQty), 0) as totalSoldQty,
          IFNULL(SUM(ss.revenue), 0) as totalRevenue,
          IFNULL(SUM(${stockExpr}), 0) as totalStock
        FROM products p
        ${salesJoinSql}
        WHERE ${productWhere}
      `).get(...queryParams) as any;

      const getTop = (field: string) => db.prepare(`
        SELECT ${field} as name, IFNULL(SUM(ss.soldQty), 0) as qty
        FROM products p ${salesJoinSql}
        WHERE ${productWhere} AND ${field} IS NOT NULL AND ${field} != 'Bilinmiyor'
        GROUP BY ${field} ORDER BY qty DESC LIMIT 1
      `).get(...queryParams) as any;

      const getBottom = (field: string) => db.prepare(`
        SELECT ${field} as name, IFNULL(SUM(ss.soldQty), 0) as qty
        FROM products p ${salesJoinSql}
        WHERE ${productWhere} AND ${field} IS NOT NULL AND ${field} != 'Bilinmiyor'
        GROUP BY ${field} ORDER BY qty ASC LIMIT 1
      `).get(...queryParams) as any;

      const topMaterial = getTop("IFNULL(p.normalized_material, 'Bilinmiyor')");
      const topModel = getTop(modelDisplayExpr);
      const topSeries = getTop(seriesExpr);
      const topSize = getTop("COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor')");
      const topType = getTop("IFNULL(p.normalized_tube_type, 'Bilinmiyor')");
      const bottomMaterial = getBottom("IFNULL(p.normalized_material, 'Bilinmiyor')");
      const bottomModel = getBottom(modelDisplayExpr);

      res.json({
        totalSku: summary?.totalSku || 0,
        totalSoldQty: summary?.totalSoldQty || 0,
        totalRevenue: summary?.totalRevenue || 0,
        totalStock: summary?.totalStock || 0,
        topMaterial: topMaterial && topMaterial.qty > 0 ? `${topMaterial.name} — ${topMaterial.qty} Ad.` : 'Veri Yok',
        topModel: topModel && topModel.qty > 0 ? `${topModel.name} — ${topModel.qty} Ad.` : 'Veri Yok',
        topSeries: topSeries && topSeries.qty > 0 ? `${topSeries.name} — ${topSeries.qty} Ad.` : 'Veri Yok',
        topSize: topSize && topSize.qty > 0 ? `${topSize.name} — ${topSize.qty} Ad.` : 'Veri Yok',
        topType: topType && topType.qty > 0 ? `${topType.name} — ${topType.qty} Ad.` : 'Veri Yok',
        bottomMaterial: bottomMaterial ? `${bottomMaterial.name} — ${bottomMaterial.qty || 0} Ad.` : 'Veri Yok',
        bottomModel: bottomModel ? `${bottomModel.name} — ${bottomModel.qty || 0} Ad.` : 'Veri Yok',
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 2. Cross Analysis
  router.get("/products/cross", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere);
      
      const query = `
        SELECT 
          IFNULL(p.normalized_material, 'Bilinmiyor') as material,
          ${seriesExpr} as series,
          ${modelDisplayExpr} as model,
          COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor') as size,
          IFNULL(p.normalized_tube_type, 'Bilinmiyor') as tubeType,
          COUNT(DISTINCT p.id) as skuCount,
          IFNULL(SUM(ss.soldQty), 0) as soldQty,
          IFNULL(SUM(ss.revenue), 0) as revenue,
          IFNULL(SUM(${stockExpr}), 0) as currentStock
        FROM products p
        ${salesJoinSql}
        WHERE ${productWhere}
        GROUP BY
          IFNULL(p.normalized_material, 'Bilinmiyor'),
          ${seriesExpr},
          ${modelDisplayExpr},
          COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor'),
          IFNULL(p.normalized_tube_type, 'Bilinmiyor')
        ORDER BY soldQty DESC
      `;
      res.json(db.prepare(query).all(...queryParams));
    } catch (error) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 3. Reorder Suggestions
  router.get("/products/reorder-suggestions", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere);
      
      const query = `
        SELECT 
          p.id,
          p.sku,
          p.title as name,
          IFNULL(p.normalized_material, 'Bilinmiyor') as material,
          ${modelDisplayExpr} as model,
          COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor') as size,
          IFNULL(p.normalized_tube_type, 'Bilinmiyor') as tubeType,
          IFNULL(${stockExpr}, 0) as currentStock,
          IFNULL(ss.soldQty, 0) as soldQty,
          IFNULL(ss.revenue, 0) as revenue,
          ss.lastSaleDate as lastSaleDate
        FROM products p
        ${salesJoinSql}
        WHERE ${productWhere}
        GROUP BY p.id
        ORDER BY soldQty DESC, currentStock ASC
      `;
      res.json(db.prepare(query).all(...queryParams));
    } catch (error) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 4. Reports (Material, Model, Size)
  router.get("/products/reports", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere);

      const getStats = (groupCol: string) => {
        return db.prepare(`
          SELECT 
            ${groupCol} as name,
            COUNT(DISTINCT p.id) as skuCount,
            IFNULL(SUM(ss.soldQty), 0) as soldQty,
            IFNULL(SUM(ss.revenue), 0) as revenue,
            IFNULL(SUM(${stockExpr}), 0) as currentStock
          FROM products p
          ${salesJoinSql}
          WHERE ${productWhere}
          GROUP BY ${groupCol}
          ORDER BY soldQty DESC
        `).all(...queryParams);
      };

      res.json({
        material: getStats("IFNULL(p.normalized_material, 'Bilinmiyor')"),
        series: getStats(seriesExpr),
        model: getStats(modelDisplayExpr),
        size: getStats("COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor')")
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 5. Charts Data
  router.get("/products/charts", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere);

      const getDistribution = (groupCol: string, limit: number = 10) => db.prepare(`
        SELECT ${groupCol} as name, IFNULL(SUM(ss.soldQty), 0) as value
        FROM products p ${salesJoinSql}
        WHERE ${productWhere}
        GROUP BY ${groupCol} ORDER BY value DESC LIMIT ${limit}
      `).all(...queryParams);

      const getSalesTrend = () => db.prepare(`
        SELECT 
          strftime('%Y-%m-%d', s.created_at) as date,
          SUM(si.quantity) as qty,
          SUM(si.unit_price * si.quantity) as revenue
        FROM sale_items si
        JOIN sales s ON si.sale_id = s.id
        JOIN products p ON p.id = si.product_id
        WHERE ${salesWhere} AND ${productWhere}
        GROUP BY date
        ORDER BY date ASC
      `).all(...queryParams);

      res.json({
        materialShare: getDistribution("IFNULL(p.normalized_material, 'Bilinmiyor')"),
        seriesShare: getDistribution(seriesExpr),
        modelShare: getDistribution(modelDisplayExpr, 15),
        pipeTypeShare: getDistribution("IFNULL(p.normalized_tube_type, 'Bilinmiyor')"),
        sizeShare: getDistribution("COALESCE(p.normalized_pipe_size, p.normalized_size, 'Bilinmiyor')", 15),
        trend: getSalesTrend()
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  return router;
}

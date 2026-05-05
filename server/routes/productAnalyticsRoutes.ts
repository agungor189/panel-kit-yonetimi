import { Router } from "express";
import Database from "better-sqlite3";

export function createProductAnalyticsRouter(db: Database.Database) {
  const router = Router();
  const ACTIVE_SALES = "s.status NOT IN ('İptal', 'İptal Edildi', 'İade', 'İade Edildi')";

  const firstQueryValue = (value: unknown): string | undefined => {
    if (Array.isArray(value)) return value[0] ? String(value[0]) : undefined;
    if (value === undefined || value === null) return undefined;
    return String(value);
  };

  const isActiveFilter = (value: string | undefined) =>
    !!value && value !== 'Tümü' && value !== 'Hepsi';

  const normalizeEndDate = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value} 23:59:59` : value;

  const periodCutoff = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 19).replace("T", " ");
  };

  const periodDaysFromRange = (startDate?: string, endDate?: string) => {
    if (!startDate) return 30;
    const start = new Date(startDate);
    const end = endDate ? new Date(normalizeEndDate(endDate)) : new Date();
    const diff = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
    return Number.isFinite(diff) && diff > 0 ? diff : 30;
  };

  const modelDisplayExpr = `
    CASE
      WHEN TRIM(COALESCE(p.normalized_model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.normalized_model)
      WHEN TRIM(COALESCE(p.model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.model)
      ELSE COALESCE(NULLIF(TRIM(p.title), ''), NULLIF(TRIM(p.name), ''), 'Model Belirtilmemiş')
    END
  `;
  const seriesExpr = "COALESCE(NULLIF(TRIM(p.product_series), ''), 'Bilinmiyor')";

  const buildWhere = (req: any) => {
    const startDate = firstQueryValue(req.query.startDate);
    const endDate = firstQueryValue(req.query.endDate);
    const material = firstQueryValue(req.query.material);
    const series = firstQueryValue(req.query.series);
    const model = firstQueryValue(req.query.model);
    const formCode = firstQueryValue(req.query.formCode ?? req.query.form_code);
    const supplierCode = firstQueryValue(req.query.supplierCode ?? req.query.supplier_code);
    const pipeSize = firstQueryValue(req.query.pipeSize ?? req.query.pipe_size);
    const tubeType = firstQueryValue(req.query.tubeType ?? req.query.tube_type);
    const periodDays = periodDaysFromRange(startDate, endDate);
    const effectiveStartDate = startDate || periodCutoff(periodDays);

    let productWhere = "p.status != 'deleted' AND COALESCE(p.exclude_from_analysis, 0) = 0 AND COALESCE(p.is_sellable, 1) = 1";
    const productParams: any[] = [];

    if (isActiveFilter(material)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.normalized_material), ''), NULLIF(TRIM(p.material), ''), 'Bilinmiyor') = ?";
      productParams.push(material);
    }
    if (isActiveFilter(series)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.product_series), ''), 'Bilinmiyor') = ?";
      productParams.push(series);
    }
    if (isActiveFilter(model)) {
      productWhere += ` AND (${modelDisplayExpr}) = ?`;
      productParams.push(model);
    }
    if (isActiveFilter(formCode)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.form_code), ''), 'Bilinmiyor') = ?";
      productParams.push(formCode);
    }
    if (isActiveFilter(supplierCode)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.supplier_code), ''), 'Bilinmiyor') = ?";
      productParams.push(supplierCode);
    }
    if (isActiveFilter(pipeSize)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.normalized_pipe_size), ''), NULLIF(TRIM(p.normalized_size), ''), NULLIF(TRIM(p.size), ''), 'Bilinmiyor') = ?";
      productParams.push(pipeSize);
    }
    if (isActiveFilter(tubeType)) {
      productWhere += " AND COALESCE(NULLIF(TRIM(p.normalized_tube_type), ''), NULLIF(TRIM(p.tube_type_code), ''), 'Bilinmiyor') = ?";
      productParams.push(tubeType);
    }

    let salesWhere = ACTIVE_SALES;
    const salesParams: any[] = [];
    salesWhere += " AND s.created_at >= ?";
    salesParams.push(effectiveStartDate);
    if (endDate) {
      salesWhere += " AND s.created_at <= ?";
      salesParams.push(normalizeEndDate(endDate));
    }

    return {
      productWhere,
      salesWhere,
      productParams,
      salesParams,
      periodDays,
      queryParams: [...salesParams, ...productParams],
    };
  };

  const getSalesStatsJoin = (salesWhere: string, periodDays = 30) => `
    LEFT JOIN (
      SELECT
        si.product_id,
        SUM(si.quantity) as soldQty,
        SUM(si.unit_price * si.quantity) as revenue,
        SUM(si.quantity) * 1.0 / ${Math.max(1, Number(periodDays) || 30)} as avgDaily,
        MAX(s.created_at) as lastSaleDate
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE ${salesWhere}
      GROUP BY si.product_id
    ) ss ON ss.product_id = p.id
  `;

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
      const distinct = (expr: string) => {
        const rows = db.prepare(`
          SELECT DISTINCT ${expr} AS val
          FROM products p
          WHERE p.status != 'deleted'
            AND COALESCE(p.exclude_from_analysis, 0) = 0
            AND COALESCE(p.is_sellable, 1) = 1
            AND ${expr} IS NOT NULL
            AND ${expr} != ''
            AND ${expr} != 'Bilinmiyor'
          ORDER BY val ASC
        `).all();
        return ['Tümü', ...rows.map((row: any) => row.val), 'Bilinmiyor'];
      };

      res.json({
        materials: distinct("COALESCE(NULLIF(TRIM(p.normalized_material), ''), NULLIF(TRIM(p.material), ''), 'Bilinmiyor')"),
        series: distinct(seriesExpr),
        models: distinct(modelDisplayExpr),
        forms: distinct("COALESCE(NULLIF(TRIM(p.form_code), ''), 'Bilinmiyor')"),
        tubeTypes: distinct("COALESCE(NULLIF(TRIM(p.normalized_tube_type), ''), NULLIF(TRIM(p.tube_type_code), ''), 'Bilinmiyor')"),
        pipeSizes: distinct("COALESCE(NULLIF(TRIM(p.normalized_pipe_size), ''), NULLIF(TRIM(p.normalized_size), ''), NULLIF(TRIM(p.size), ''), 'Bilinmiyor')"),
        supplierCodes: distinct("COALESCE(NULLIF(TRIM(p.supplier_code), ''), 'Bilinmiyor')"),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 1. Dashboard / Summary
  router.get("/products/summary", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams, periodDays } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere, periodDays);
      
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
        period_days: periodDays,
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
      const { productWhere, salesWhere, queryParams, periodDays } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere, periodDays);
      
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
          IFNULL(SUM(ss.soldQty), 0) * 1.0 / ${periodDays} as avg_daily,
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
      const { productWhere, salesWhere, queryParams, periodDays } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere, periodDays);
      
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
          IFNULL(ss.avgDaily, 0) as avg_daily,
          IFNULL(ss.revenue, 0) as revenue,
          ss.lastSaleDate as lastSaleDate,
          CASE
            WHEN IFNULL(ss.avgDaily, 0) <= 0 THEN NULL
            ELSE CAST(IFNULL(${stockExpr}, 0) / ss.avgDaily AS INTEGER)
          END as days_until_stockout,
          CAST(IFNULL(ss.avgDaily, 0) * 75 + 0.999 AS INTEGER) as target_stock,
          MAX(0, CAST(IFNULL(ss.avgDaily, 0) * 75 + 0.999 AS INTEGER) - IFNULL(${stockExpr}, 0)) as recommended_qty,
          MAX(0, CAST(IFNULL(ss.avgDaily, 0) * 75 + 0.999 AS INTEGER) - IFNULL(${stockExpr}, 0)) * COALESCE(p.purchase_price_usd, 0) as estimated_cost_usd,
          MAX(0, CAST(IFNULL(ss.avgDaily, 0) * 75 + 0.999 AS INTEGER) - IFNULL(${stockExpr}, 0)) * COALESCE(p.weight_grams, 0) / 1000 as estimated_weight_kg,
          ${periodDays} as period_days
        FROM products p
        ${salesJoinSql}
        WHERE ${productWhere}
        GROUP BY p.id
        ORDER BY soldQty DESC, currentStock ASC
      `;
      const rows = db.prepare(query).all(...queryParams) as any[];
      res.json(rows.map((r) => ({
        ...r,
        reason: r.soldQty <= 0
          ? "Seçili dönemde satış yok"
          : r.days_until_stockout !== null && r.days_until_stockout <= 45
            ? `Stok ${r.days_until_stockout} gün içinde bitebilir`
            : "Dönem satış hızına göre hesaplandı",
      })));
    } catch (error) {
      res.status(500).json({ error: "Internal error" });
    }
  });

  // 4. Reports (Material, Model, Size)
  router.get("/products/reports", (req, res) => {
    try {
      const { productWhere, salesWhere, queryParams, periodDays } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere, periodDays);

      const getStats = (groupCol: string) => {
        return db.prepare(`
          SELECT 
            ${groupCol} as name,
            COUNT(DISTINCT p.id) as skuCount,
            IFNULL(SUM(ss.soldQty), 0) as soldQty,
            IFNULL(SUM(ss.revenue), 0) as revenue,
            IFNULL(SUM(ss.soldQty), 0) * 1.0 / ${periodDays} as avg_daily,
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
      const { productWhere, salesWhere, queryParams, periodDays } = buildWhere(req);
      const salesJoinSql = getSalesStatsJoin(salesWhere, periodDays);

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

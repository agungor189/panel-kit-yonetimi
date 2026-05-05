import { Router } from "express";
import Database from "better-sqlite3";

const ACTIVE_SALES = "s.status NOT IN ('İptal', 'İade Edildi', 'İade', 'İptal Edildi')";

function periodCutoff(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function num(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | undefined {
  if (Array.isArray(v)) v = v[0];
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
}

const SELLABLE_PRODUCT_FILTER = `
  p.status != 'deleted'
  AND COALESCE(p.exclude_from_analysis, 0) = 0
  AND COALESCE(p.is_sellable, 1) = 1
`;

const STOCK_EXPR = `
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

export function createInsightsRouter(db: Database.Database) {
  const router = Router();

  // -------- Overview KPIs ---------------------------------------------------
  router.get("/overview", (req, res) => {
    try {
      const period = num(req.query.period, 30);
      const cutoff = periodCutoff(period);

      const sellableCount = (db.prepare(`SELECT COUNT(*) c FROM products p WHERE ${SELLABLE_PRODUCT_FILTER}`).get() as any).c;

      const stockValue = db.prepare(`
        SELECT
          SUM(${STOCK_EXPR} * COALESCE(p.purchase_price_usd, 0)) AS purchase_value_usd,
          SUM(${STOCK_EXPR} * COALESCE(p.sale_price, 0)) AS sale_value_try
        FROM products p
        WHERE ${SELLABLE_PRODUCT_FILTER}
      `).get() as any;

      const sales = db.prepare(`
        SELECT
          COUNT(*) AS sale_count,
          COALESCE(SUM(s.total_amount), 0) AS revenue,
          COALESCE(SUM(s.gross_profit), 0) AS gross_profit,
          COALESCE(SUM(s.net_profit), 0) AS net_profit
        FROM sales s
        WHERE ${ACTIVE_SALES} AND s.created_at >= ?
      `).get(cutoff) as any;

      const productSales = db.prepare(`
        SELECT COUNT(DISTINCT si.product_id) AS distinct_products,
               COALESCE(SUM(si.quantity), 0) AS units_sold
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE ${ACTIVE_SALES} AND s.created_at >= ?
      `).get(cutoff) as any;

      const dead = db.prepare(`
        SELECT COUNT(*) AS dead_count
        FROM products p
        WHERE ${SELLABLE_PRODUCT_FILTER}
          AND NOT EXISTS (
            SELECT 1 FROM sale_items si
            JOIN sales s ON s.id = si.sale_id
            WHERE si.product_id = p.id AND ${ACTIVE_SALES} AND s.created_at >= ?
          )
      `).get(cutoff) as any;

      const critical = db.prepare(`
        SELECT COUNT(*) AS critical_count
        FROM products p
        WHERE ${SELLABLE_PRODUCT_FILTER}
          AND ${STOCK_EXPR} <= COALESCE(p.min_stock_level, 50)
      `).get() as any;

      const fastest = db.prepare(`
        SELECT p.sku, p.name, SUM(si.quantity) AS qty
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        WHERE ${ACTIVE_SALES} AND s.created_at >= ? AND ${SELLABLE_PRODUCT_FILTER}
        GROUP BY si.product_id
        ORDER BY qty DESC
        LIMIT 1
      `).get(cutoff) as any;

      const heaviestStock = db.prepare(`
        SELECT p.sku, p.name, ${STOCK_EXPR} AS stock,
               (${STOCK_EXPR}) * COALESCE(p.purchase_price_usd, 0) AS value_usd
        FROM products p
        WHERE ${SELLABLE_PRODUCT_FILTER}
        ORDER BY value_usd DESC
        LIMIT 1
      `).get() as any;

      res.json({
        period_days: period,
        product: {
          total_sellable: sellableCount,
          critical_stock: critical.critical_count,
          dead_in_period: dead.dead_count,
          distinct_sold_in_period: productSales.distinct_products,
        },
        stock: {
          purchase_value_usd: stockValue.purchase_value_usd || 0,
          sale_value_try: stockValue.sale_value_try || 0,
          heaviest_value_product: heaviestStock,
        },
        sales: {
          sale_count: sales.sale_count,
          units_sold: productSales.units_sold,
          revenue_try: sales.revenue,
          gross_profit_try: sales.gross_profit,
          net_profit_try: sales.net_profit,
          margin: sales.revenue > 0 ? (sales.gross_profit / sales.revenue) : 0,
          fastest_seller: fastest,
        },
      });
    } catch (err: any) {
      console.error("[insights/overview]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // -------- Top sellers / Bottom / Dead -------------------------------------
  router.get("/sales/top", (req, res) => {
    const period = num(req.query.period, 30);
    const limit = num(req.query.limit, 20);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT
        p.id, p.sku, p.name, p.material, p.product_series, p.tube_type_code,
        p.size, p.form_code, p.purchase_price_usd,
        ${STOCK_EXPR} AS stock,
        SUM(si.quantity) AS qty,
        SUM(si.quantity * si.unit_price) AS revenue,
        SUM(si.net_profit) AS profit,
        AVG(si.unit_price) AS avg_price,
        COUNT(DISTINCT s.id) AS order_count,
        SUM(si.quantity) * 1.0 / ${period} AS avg_daily_sales
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN products p ON p.id = si.product_id
      WHERE ${ACTIVE_SALES} AND s.created_at >= ? AND ${SELLABLE_PRODUCT_FILTER}
      GROUP BY si.product_id
      ORDER BY qty DESC
      LIMIT ?
    `).all(cutoff, limit);
    res.json({ period_days: period, items: rows });
  });

  router.get("/sales/bottom", (req, res) => {
    const period = num(req.query.period, 30);
    const limit = num(req.query.limit, 20);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT
        p.id, p.sku, p.name, p.material, p.product_series, p.size,
        ${STOCK_EXPR} AS stock,
        COALESCE(SUM(si.quantity), 0) AS qty,
        COALESCE(SUM(si.quantity * si.unit_price), 0) AS revenue
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND ${ACTIVE_SALES} AND s.created_at >= ?
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY p.id
      HAVING qty > 0
      ORDER BY qty ASC
      LIMIT ?
    `).all(cutoff, limit);
    res.json({ period_days: period, items: rows });
  });

  router.get("/sales/dead", (req, res) => {
    const period = num(req.query.period, 90);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT
        p.id, p.sku, p.name, p.material, p.product_series, p.size,
        ${STOCK_EXPR} AS stock,
        (${STOCK_EXPR}) * COALESCE(p.purchase_price_usd, 0) AS tied_capital_usd,
        (
          SELECT MAX(s2.created_at)
          FROM sale_items si2
          JOIN sales s2 ON s2.id = si2.sale_id
          WHERE si2.product_id = p.id AND ${ACTIVE_SALES.replace(/s\./g, "s2.")}
        ) AS last_sale
      FROM products p
      WHERE ${SELLABLE_PRODUCT_FILTER}
        AND NOT EXISTS (
          SELECT 1 FROM sale_items si
          JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = p.id AND ${ACTIVE_SALES} AND s.created_at >= ?
        )
        AND ${STOCK_EXPR} > 0
      ORDER BY tied_capital_usd DESC
    `).all(cutoff);
    res.json({ period_days: period, items: rows });
  });

  // -------- Sales trend (daily / weekly) -----------------------------------
  router.get("/sales/trend", (req, res) => {
    const period = num(req.query.period, 90);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT DATE(s.created_at) AS day,
             COUNT(*) AS sale_count,
             COALESCE(SUM(s.total_amount), 0) AS revenue,
             COALESCE(SUM(s.gross_profit), 0) AS gross_profit
      FROM sales s
      WHERE ${ACTIVE_SALES} AND s.created_at >= ?
      GROUP BY DATE(s.created_at)
      ORDER BY day ASC
    `).all(cutoff);
    res.json({ period_days: period, items: rows });
  });

  // -------- Stock summary / critical / excess -------------------------------
  router.get("/stock/summary", (_req, res) => {
    const overall = db.prepare(`
      SELECT
        COUNT(*) AS sellable_count,
        SUM(${STOCK_EXPR}) AS total_units,
        SUM(${STOCK_EXPR} * COALESCE(p.purchase_price_usd, 0)) AS total_purchase_value_usd,
        SUM(${STOCK_EXPR} * COALESCE(p.sale_price, 0)) AS total_sale_value_try
      FROM products p
      WHERE ${SELLABLE_PRODUCT_FILTER}
    `).get();
    const byMaterial = db.prepare(`
      SELECT COALESCE(p.material, 'Bilinmiyor') AS material,
             COUNT(*) AS count,
             SUM(${STOCK_EXPR}) AS units,
             SUM(${STOCK_EXPR} * COALESCE(p.purchase_price_usd, 0)) AS purchase_value_usd
      FROM products p
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY material
      ORDER BY purchase_value_usd DESC
    `).all();
    res.json({ overall, by_material: byMaterial });
  });

  router.get("/stock/critical", (req, res) => {
    const safetyDays = num(req.query.safetyDays, 30);
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT p.id, p.sku, p.name, p.material, p.product_series, p.size,
             ${STOCK_EXPR} AS stock,
             COALESCE(p.min_stock_level, 50) AS min_stock,
             COALESCE(SUM(si.quantity), 0) AS sold_in_period,
             COALESCE(SUM(si.quantity), 0) * 1.0 / ? AS avg_daily,
             CASE
               WHEN COALESCE(SUM(si.quantity), 0) <= 0 THEN NULL
               ELSE CAST(${STOCK_EXPR} / (COALESCE(SUM(si.quantity), 0) * 1.0 / ?) AS INTEGER)
             END AS days_until_stockout
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND ${ACTIVE_SALES} AND s.created_at >= ?
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY p.id
      HAVING stock <= COALESCE(p.min_stock_level, 50)
          OR (avg_daily > 0 AND days_until_stockout <= ?)
      ORDER BY (CASE WHEN avg_daily > 0 THEN days_until_stockout ELSE 999999 END) ASC
    `).all(period, period, cutoff, safetyDays);
    res.json({ items: rows });
  });

  router.get("/stock/excess", (req, res) => {
    const coverDays = num(req.query.coverDays, 180);
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT p.id, p.sku, p.name, p.material, p.product_series, p.size,
             ${STOCK_EXPR} AS stock,
             (${STOCK_EXPR}) * COALESCE(p.purchase_price_usd, 0) AS tied_capital_usd,
             COALESCE(SUM(si.quantity), 0) AS sold_in_period,
             COALESCE(SUM(si.quantity), 0) * 1.0 / ? AS avg_daily,
             CASE
               WHEN COALESCE(SUM(si.quantity), 0) <= 0 THEN 999999
               ELSE CAST(${STOCK_EXPR} / (COALESCE(SUM(si.quantity), 0) * 1.0 / ?) AS INTEGER)
             END AS days_of_stock
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND ${ACTIVE_SALES} AND s.created_at >= ?
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY p.id
      HAVING stock > 0 AND days_of_stock >= ?
      ORDER BY tied_capital_usd DESC
    `).all(period, period, cutoff, coverDays);
    res.json({ items: rows });
  });

  // -------- Reorder suggestions --------------------------------------------
  router.get("/reorder", (req, res) => {
    const leadTime = num(req.query.leadTime, 45);
    const safetyDays = num(req.query.safetyDays, 30);
    const period = num(req.query.period, 90);
    const cutoff = periodCutoff(period);

    const rows = db.prepare(`
      SELECT
        p.id, p.sku, p.supplier_code, p.name, p.material, p.product_series,
        p.tube_type_code, p.size, p.form_code,
        p.purchase_price_usd, p.weight_grams,
        ${STOCK_EXPR} AS stock,
        COALESCE(p.min_stock_level, 50) AS min_stock,
        COALESCE(SUM(si.quantity), 0) AS sold_in_period,
        COALESCE(SUM(si.quantity), 0) * 1.0 / ? AS avg_daily,
        CASE
          WHEN COALESCE(SUM(si.quantity), 0) <= 0 THEN NULL
          ELSE CAST(${STOCK_EXPR} / (COALESCE(SUM(si.quantity), 0) * 1.0 / ?) AS INTEGER)
        END AS days_until_stockout
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND ${ACTIVE_SALES} AND s.created_at >= ?
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY p.id
    `).all(period, period, cutoff) as any[];

    const enriched = rows.map((r) => {
      const targetCover = leadTime + safetyDays;
      const dailyDemand = r.avg_daily || 0;
      const targetStock = Math.ceil(dailyDemand * targetCover);
      const recommendedQty = Math.max(0, targetStock - r.stock);
      let priority: "acil" | "yakında" | "normal" | "gereksiz";
      if (dailyDemand <= 0 && r.stock > 0) priority = "gereksiz";
      else if (r.days_until_stockout !== null && r.days_until_stockout <= leadTime / 2) priority = "acil";
      else if (r.days_until_stockout !== null && r.days_until_stockout <= leadTime + safetyDays) priority = "yakında";
      else if (r.stock <= r.min_stock) priority = "yakında";
      else priority = "normal";
      const reasonParts: string[] = [];
      if (priority === "acil") reasonParts.push(`Stok ${r.days_until_stockout ?? "?"} günde bitecek (lead time ${leadTime}g)`);
      if (priority === "yakında") reasonParts.push(`Stok ${r.days_until_stockout ?? "min altı"} günde kritik`);
      if (priority === "gereksiz") reasonParts.push("Bu dönem hiç satılmadı");
      if (priority === "normal") reasonParts.push("Stok yeterli");
      return {
        ...r,
        target_stock: targetStock,
        recommended_qty: recommendedQty,
        priority,
        reason: reasonParts.join(" — "),
      };
    });
    enriched.sort((a, b) => {
      const order = { acil: 0, "yakında": 1, normal: 2, gereksiz: 3 };
      return (order as any)[a.priority] - (order as any)[b.priority] || (a.days_until_stockout ?? 999999) - (b.days_until_stockout ?? 999999);
    });
    res.json({ lead_time_days: leadTime, safety_days: safetyDays, period_days: period, items: enriched });
  });

  // -------- Breakdown ------------------------------------------------------
  router.get("/breakdown", (req, res) => {
    const dimension = str(req.query.dimension) ?? "material";
    const metric = str(req.query.metric) ?? "qty";
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);

    const colMap: Record<string, string> = {
      material: "COALESCE(p.material, 'Bilinmiyor')",
      series: "COALESCE(p.product_series, 'Bilinmiyor')",
      tube_type: "COALESCE(p.tube_type_code, 'NA')",
      size: "COALESCE(p.size, p.size_code, 'Bilinmiyor')",
      form: "COALESCE(p.form_code, 'NA')",
      supplier_code: "COALESCE(p.supplier_code, 'Bilinmiyor')",
    };
    const groupCol = colMap[dimension] || colMap.material;

    const metricMap: Record<string, string> = {
      qty: "COALESCE(SUM(si.quantity), 0)",
      revenue: "COALESCE(SUM(si.quantity * si.unit_price), 0)",
      profit: "COALESCE(SUM(si.net_profit), 0)",
    };
    const metricExpr = metricMap[metric] || metricMap.qty;

    const rows = db.prepare(`
      SELECT
        ${groupCol} AS bucket,
        COUNT(DISTINCT p.id) AS product_count,
        ${metricExpr} AS value,
        SUM(${STOCK_EXPR}) AS stock_units,
        SUM(${STOCK_EXPR} * COALESCE(p.purchase_price_usd, 0)) AS stock_value_usd
      FROM products p
      LEFT JOIN sale_items si ON si.product_id = p.id
      LEFT JOIN sales s ON s.id = si.sale_id AND ${ACTIVE_SALES} AND s.created_at >= ?
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY bucket
      ORDER BY value DESC
    `).all(cutoff) as any[];

    const total = rows.reduce((s, r) => s + (r.value || 0), 0);
    res.json({
      dimension,
      metric,
      period_days: period,
      total,
      items: rows.map((r) => ({ ...r, share: total > 0 ? r.value / total : 0 })),
    });
  });

  // -------- BOM-aware: components -----------------------------------------
  router.get("/components/consumption", (req, res) => {
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT comp.id, comp.sku, comp.name, comp.central_stock,
             comp.purchase_price_usd,
             SUM(b.quantity_per_unit * si.quantity) AS units_consumed,
             SUM(b.quantity_per_unit * si.quantity) * 1.0 / ? AS daily_consumption
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      JOIN product_bom b ON b.parent_product_id = si.product_id
      JOIN products comp ON comp.id = b.component_product_id
      WHERE ${ACTIVE_SALES} AND s.created_at >= ?
      GROUP BY comp.id
      ORDER BY units_consumed DESC
    `).all(period, cutoff);
    res.json({ period_days: period, items: rows });
  });

  router.get("/components/runway", (req, res) => {
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT comp.id, comp.sku, comp.name, comp.central_stock,
             COALESCE(consumed.units, 0) AS units_consumed,
             COALESCE(consumed.units, 0) * 1.0 / ? AS daily_consumption,
             CASE
               WHEN COALESCE(consumed.units, 0) <= 0 THEN NULL
               ELSE CAST(comp.central_stock / (COALESCE(consumed.units, 0) * 1.0 / ?) AS INTEGER)
             END AS days_left
      FROM products comp
      LEFT JOIN (
        SELECT b.component_product_id, SUM(b.quantity_per_unit * si.quantity) AS units
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN product_bom b ON b.parent_product_id = si.product_id
        WHERE ${ACTIVE_SALES} AND s.created_at >= ?
        GROUP BY b.component_product_id
      ) consumed ON consumed.component_product_id = comp.id
      WHERE comp.product_type IN ('component', 'accessory')
      ORDER BY (CASE WHEN COALESCE(consumed.units, 0) > 0 THEN days_left ELSE 999999 END) ASC
    `).all(period, period, cutoff);
    res.json({ period_days: period, items: rows });
  });

  router.get("/components/blocking", (_req, res) => {
    const rows = db.prepare(`
      SELECT
        p.id AS final_id, p.sku AS final_sku, p.name AS final_name,
        ${STOCK_EXPR} AS available,
        json_group_array(json_object(
          'component_id', comp.id,
          'sku', comp.sku,
          'name', comp.name,
          'stock', comp.central_stock,
          'qty_per_unit', b.quantity_per_unit,
          'possible', CAST(COALESCE(comp.central_stock, 0) / NULLIF(b.quantity_per_unit, 0) AS INTEGER)
        )) AS components_json
      FROM products p
      JOIN product_bom b ON b.parent_product_id = p.id
      JOIN products comp ON comp.id = b.component_product_id
      WHERE ${SELLABLE_PRODUCT_FILTER}
      GROUP BY p.id
      HAVING available <= 5
      ORDER BY available ASC
    `).all() as any[];
    res.json({ items: rows.map((r) => ({ ...r, components: JSON.parse(r.components_json) })) });
  });

  router.get("/components/forecast", (req, res) => {
    const horizon = num(req.query.horizon, 60);
    const period = num(req.query.period, 30);
    const cutoff = periodCutoff(period);
    const rows = db.prepare(`
      SELECT comp.id, comp.sku, comp.name, comp.central_stock,
             COALESCE(consumed.units, 0) AS recent_consumption,
             COALESCE(consumed.units, 0) * 1.0 / ? AS daily,
             CAST(COALESCE(consumed.units, 0) * 1.0 / ? * ? AS INTEGER) AS forecast_demand,
             MAX(0, CAST(COALESCE(consumed.units, 0) * 1.0 / ? * ? - comp.central_stock AS INTEGER)) AS need_to_order
      FROM products comp
      LEFT JOIN (
        SELECT b.component_product_id, SUM(b.quantity_per_unit * si.quantity) AS units
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN product_bom b ON b.parent_product_id = si.product_id
        WHERE ${ACTIVE_SALES} AND s.created_at >= ?
        GROUP BY b.component_product_id
      ) consumed ON consumed.component_product_id = comp.id
      WHERE comp.product_type IN ('component', 'accessory')
      ORDER BY need_to_order DESC
    `).all(period, period, horizon, period, horizon, cutoff);
    res.json({ horizon_days: horizon, period_days: period, items: rows });
  });

  // -------- Filter options --------------------------------------------------
  router.get("/filter-options", (_req, res) => {
    const distinct = (col: string) => db.prepare(`
      SELECT DISTINCT ${col} AS v FROM products p
      WHERE ${SELLABLE_PRODUCT_FILTER} AND ${col} IS NOT NULL AND ${col} != ''
      ORDER BY v ASC
    `).all().map((r: any) => r.v);
    res.json({
      materials: distinct("p.material"),
      series: distinct("p.product_series"),
      tube_types: distinct("p.tube_type_code"),
      sizes: distinct("p.size"),
      forms: distinct("p.form_code"),
    });
  });

  return router;
}

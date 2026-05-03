import { Router } from "express";
import { Database } from "better-sqlite3";

export function createDashboardDataRouter(db: Database) {
  const router = Router();

  // Helper
  const getDateFilter = (req: any) => {
    const defaultDate = new Date();
    const startStr = req.query.dateFrom || `${defaultDate.getFullYear()}-${(defaultDate.getMonth() + 1).toString().padStart(2, '0')}-01`;
    let endStr = req.query.dateTo;
    if (!endStr) {
      const lastDay = new Date(defaultDate.getFullYear(), defaultDate.getMonth() + 1, 0).getDate();
      endStr = `${defaultDate.getFullYear()}-${(defaultDate.getMonth() + 1).toString().padStart(2, '0')}-${lastDay.toString().padStart(2, '0')}`;
    }
    return { startStr, endStr };
  };

  // ==========================================
  // PAYMENT WIDGETS
  // ==========================================

  router.get("/widgets/payments/summary", (req, res) => {
    try {
      const { startStr, endStr } = getDateFilter(req);
      const today = new Date().toISOString().split('T')[0];

      // Pending Count & Amount this month
      const pendingQ = db.prepare(`SELECT COUNT(*) as cnt, SUM(amount_try) as sum_amount FROM recurring_payment_occurrences WHERE due_date >= ? AND due_date <= ? AND status = 'pending'`).get(startStr, endStr) as any;
      
      // Auto Process count this month
      const autoQ = db.prepare(`
        SELECT COUNT(*) as cnt 
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON p.id = o.recurring_payment_id
        WHERE o.due_date >= ? AND o.due_date <= ? AND o.status = 'pending' AND p.auto_process = 1
      `).get(startStr, endStr) as any;

      // Overdue (due_date < today AND status != processed)
      const overdueQ = db.prepare(`SELECT COUNT(*) as cnt FROM recurring_payment_occurrences WHERE due_date < ? AND status != 'processed' AND status != 'cancelled'`).get(today) as any;
      
      // Processed count this month
      const processedQ = db.prepare(`SELECT COUNT(*) as cnt FROM recurring_payment_occurrences WHERE due_date >= ? AND due_date <= ? AND status = 'processed'`).get(startStr, endStr) as any;

      res.json({
        pending_count: pendingQ.cnt || 0,
        pending_amount: pendingQ.sum_amount || 0,
        auto_process_count: autoQ.cnt || 0,
        overdue_count: overdueQ.cnt || 0,
        processed_count: processedQ.cnt || 0
      });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/payments/upcoming", (req, res) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const future = new Date();
      future.setDate(future.getDate() + 30);
      const futureStr = future.toISOString().split('T')[0];
      const limit = parseInt(req.query.limit as string) || 7;

      const upcoming = db.prepare(`
        SELECT o.id, p.title, o.due_date, o.amount_try, o.status, p.category 
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON p.id = o.recurring_payment_id
        WHERE o.due_date >= ? AND o.due_date <= ? AND o.status = 'pending'
        ORDER BY o.due_date ASC
        LIMIT ?
      `).all(today, futureStr, limit);

      res.json(upcoming);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/payments/calendar-mini", (req, res) => {
    try {
      const { startStr, endStr } = getDateFilter(req);
      const data = db.prepare(`
        SELECT due_date, status, COUNT(*) as count 
        FROM recurring_payment_occurrences 
        WHERE due_date >= ? AND due_date <= ?
        GROUP BY due_date, status
      `).all(startStr, endStr);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/payments/status-share", (req, res) => {
    try {
      const { startStr, endStr } = getDateFilter(req);
      const data = db.prepare(`
        SELECT status, COUNT(*) as value 
        FROM recurring_payment_occurrences 
        WHERE due_date >= ? AND due_date <= ?
        GROUP BY status
      `).all(startStr, endStr);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/payments/category-share", (req, res) => {
    try {
      const { startStr, endStr } = getDateFilter(req);
      const data = db.prepare(`
        SELECT p.category as name, SUM(o.amount_try) as value 
        FROM recurring_payment_occurrences o
        JOIN recurring_payment_plans p ON p.id = o.recurring_payment_id
        WHERE o.due_date >= ? AND o.due_date <= ?
        GROUP BY p.category
      `).all(startStr, endStr);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/payments/monthly-amounts", (req, res) => {
    try {
      const { startStr, endStr } = getDateFilter(req);
      const data = db.prepare(`
        SELECT due_date as name, SUM(amount_try) as amount 
        FROM recurring_payment_occurrences 
        WHERE due_date >= ? AND due_date <= ?
        GROUP BY due_date
        ORDER BY due_date ASC
      `).all(startStr, endStr);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  // ==========================================
  // PRODUCT & SALES ANALYSIS WIDGETS
  // ==========================================

  const getProductFilters = (req: any) => {
    let q = "";
    let params: any[] = [];
    if (req.query.dateFrom) { q += " AND s.created_at >= ?"; params.push(req.query.dateFrom + ' 00:00:00'); }
    if (req.query.dateTo) { q += " AND s.created_at <= ?"; params.push(req.query.dateTo + ' 23:59:59'); }
    
    let productJoin = "";
    let productWhere = "";
    if (req.query.material || req.query.model || req.query.pipeType || req.query.pipeSize) {
      productJoin = " JOIN products p ON p.id = i.product_id ";
      if (req.query.material) {
        productWhere += " AND (p.material = ? OR p.normalized_material = ?)";
        params.push(req.query.material, req.query.material);
      }
      if (req.query.model) {
        productWhere += " AND (p.model = ? OR p.normalized_model = ?)";
        params.push(req.query.model, req.query.model);
      }
      if (req.query.pipeType) {
        productWhere += " AND (p.connection_type = ? OR p.normalized_tube_type = ?)";
        params.push(req.query.pipeType, req.query.pipeType);
      }
      if (req.query.pipeSize) {
        productWhere += " AND (p.pipe_size = ? OR p.normalized_pipe_size = ?)";
        params.push(req.query.pipeSize, req.query.pipeSize);
      }
    }
    return { q, params, productJoin, productWhere };
  };

  const activeSalesFilter = "s.status NOT IN ('İptal Edildi', 'İade Edildi')";
  const modelDisplayExpr = `
    CASE
      WHEN TRIM(COALESCE(p.normalized_model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.normalized_model)
      WHEN TRIM(COALESCE(p.model, '')) NOT IN ('', 'Bilinmiyor', 'Standart') THEN TRIM(p.model)
      ELSE COALESCE(NULLIF(TRIM(p.title), ''), NULLIF(TRIM(p.name), ''), 'Model Belirtilmemiş')
    END
  `;

  router.get("/widgets/product-analysis/summary", (req, res) => {
    try {
      const { q, params, productJoin, productWhere } = getProductFilters(req);
      const salesQuery = `
        SELECT SUM(i.quantity) as total_sold, SUM(i.quantity * i.unit_price * COALESCE(s.exchange_rate_at_transaction, 1)) as total_revenue
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        ${productJoin}
        WHERE 1=1 ${q} ${productWhere}
      `;
      const data = db.prepare(salesQuery).get(...params) as any;
      
      res.json({
        total_sold: data.total_sold || 0,
        total_revenue: data.total_revenue || 0
      });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/material-share", (req, res) => {
    try {
      const { q, params, productWhere } = getProductFilters(req);
      const data = db.prepare(`
        SELECT COALESCE(p.material, 'Bilinmiyor') as name, SUM(i.quantity) as value
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        JOIN products p ON p.id = i.product_id
        WHERE 1=1 ${q} ${productWhere}
        GROUP BY p.material
        ORDER BY value DESC
      `).all(...params);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/model-share", (req, res) => {
    try {
      const { q, params, productWhere } = getProductFilters(req);
      const data = db.prepare(`
        SELECT ${modelDisplayExpr} as name, SUM(i.quantity) as value
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        JOIN products p ON p.id = i.product_id
        WHERE 1=1 ${q} ${productWhere}
        GROUP BY ${modelDisplayExpr}
        ORDER BY value DESC
      `).all(...params);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/size-share", (req, res) => {
    try {
      const { q, params, productWhere } = getProductFilters(req);
      const data = db.prepare(`
        SELECT COALESCE(p.normalized_pipe_size, p.pipe_size, p.size, 'Bilinmiyor') as name, SUM(i.quantity) as value
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        JOIN products p ON p.id = i.product_id
        WHERE 1=1 ${q} ${productWhere}
        GROUP BY COALESCE(p.normalized_pipe_size, p.pipe_size, p.size, 'Bilinmiyor')
        ORDER BY value DESC
      `).all(...params);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/pipe-type-share", (req, res) => {
    try {
      const { q, params, productWhere } = getProductFilters(req);
      const data = db.prepare(`
        SELECT COALESCE(p.normalized_tube_type, p.connection_type, 'Bilinmiyor') as name, SUM(i.quantity) as value
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        JOIN products p ON p.id = i.product_id
        WHERE 1=1 ${q} ${productWhere}
        GROUP BY COALESCE(p.normalized_tube_type, p.connection_type, 'Bilinmiyor')
        ORDER BY value DESC
      `).all(...params);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/sales-trend", (req, res) => {
    try {
      const { q, params, productJoin, productWhere } = getProductFilters(req);
      const data = db.prepare(`
        SELECT substr(s.created_at, 1, 10) as name, SUM(i.quantity) as value
        FROM sale_items i
        JOIN sales s ON s.id = i.sale_id AND ${activeSalesFilter}
        ${productJoin}
        WHERE 1=1 ${q} ${productWhere}
        GROUP BY substr(s.created_at, 1, 10)
        ORDER BY name ASC
      `).all(...params);
      res.json(data);
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  router.get("/widgets/product-analysis/reorder-summary", (req, res) => {
    try {
      const data = db.prepare(`
        SELECT COUNT(*) as critical_count, SUM(deficit) as est_order_qty
        FROM (
          SELECT
            p.id,
            COALESCE(p.min_stock_level, 50) as min_stock_level,
            COALESCE(p.central_stock, 0) as stock_quantity,
            MAX(COALESCE(p.min_stock_level, 50) - COALESCE(p.central_stock, 0), 0) as deficit
          FROM products p
          GROUP BY p.id, p.min_stock_level, p.central_stock
          HAVING stock_quantity <= min_stock_level
        )
      `).get() as any;
      res.json({
        critical_count: data.critical_count || 0,
        suggested_order_qty: data.est_order_qty || 0
      });
    } catch(e: any) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

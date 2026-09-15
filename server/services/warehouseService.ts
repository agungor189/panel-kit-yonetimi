import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const WAREHOUSE_ORDER_STATUS = {
  ready: "Hazırlanıyor",
  picking: "Toplanıyor",
  picked: "Toplandı",
} as const;

const PICKABLE_STATUSES = [WAREHOUSE_ORDER_STATUS.ready, WAREHOUSE_ORDER_STATUS.picking] as const;

export type WarehousePicker = { id: string; username: string };

export class WarehouseServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WarehouseServiceError";
  }
}

type ActivityWriter = (
  action: string,
  entityType: string,
  entityId: string,
  details?: unknown,
  actorId?: string,
) => void;

type OrderListOptions = {
  page: number;
  limit: number;
};

export type PickHistoryOptions = {
  page: number;
  limit: number;
  dateFrom?: string;
  dateTo?: string;
  summaryFrom?: string;
  summaryTo?: string;
  pickerUserId?: string;
  sku?: string;
  productName?: string;
  orderNumber?: string;
  status?: string;
};

type StatusTransitionResult = {
  order: Record<string, unknown>;
  idempotent: boolean;
  previous_status: string;
};

const asNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

// Keep the Warehouse contract canonical while the live database is still in
// the pre-migration state. Legacy values remain readable but are never exposed.
const canonicalProductType = (value: unknown, hasBom = false): "simple" | "component" | "assembly" => {
  const type = String(value || "").trim().toLowerCase();
  if (hasBom || type === "assembly") return "assembly";
  if (type === "component" || type === "accessory") return "component";
  return "simple";
};

const operationalOrderSelect = `
  SELECT
    s.id,
    s.order_code,
    s.external_order_id,
    s.platform,
    s.customer_name,
    s.customer_phone,
    s.customer_address,
    s.shipping_company,
    s.tracking_number,
    s.status,
    s.total_quantity,
    s.total_weight,
    s.warehouse_picker_user_id,
    s.warehouse_picker_name,
    s.warehouse_picking_started_at,
    s.warehouse_picking_completed_at,
    s.created_at,
    s.updated_at
  FROM sales s
`;

export class WarehouseService {
  constructor(
    private readonly db: Database.Database,
    private readonly writeActivity: ActivityWriter,
  ) {}

  private hasPackageStockTables() {
    return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'warehouse_packages'").get());
  }

  private packageAllocations(productId: string, requiredQuantity: number) {
    if (!this.hasPackageStockTables()) return { tracked: false, available: 0, allocations: [] as any[] };
    const packages = this.db.prepare(`
      SELECT p.id AS package_id, p.package_code, p.package_number, p.total_packages,
             p.remaining_quantity, p.status, p.batch_id, p.batch_line_id,
             l.code AS location_code, b.created_at AS batch_created_at, bl.line_number
      FROM warehouse_packages p
      JOIN inbound_batches b ON b.id = p.batch_id
      JOIN inbound_batch_lines bl ON bl.id = p.batch_line_id
      LEFT JOIN warehouse_locations l ON l.id = p.current_location_id
      WHERE p.product_id = ? AND p.status IN ('PLACED','OPEN') AND p.remaining_quantity > 0
      ORDER BY datetime(b.created_at), bl.line_number, p.package_number, p.package_code
    `).all(productId) as any[];
    const tracked = Boolean(this.db.prepare("SELECT 1 FROM warehouse_packages WHERE product_id = ? LIMIT 1").get(productId));
    let needed = requiredQuantity;
    const allocations = [] as any[];
    for (const pkg of packages) {
      if (needed <= 0) break;
      const take = Math.min(needed, asNumber(pkg.remaining_quantity));
      if (take > 0) {
        allocations.push({
          package_id: pkg.package_id,
          package_code: pkg.package_code,
          package_number: asNumber(pkg.package_number),
          total_packages: asNumber(pkg.total_packages),
          location_code: pkg.location_code || null,
          available_quantity: asNumber(pkg.remaining_quantity),
          pick_quantity: take,
        });
        needed -= take;
      }
    }
    return {
      tracked,
      available: packages.reduce((sum, pkg) => sum + asNumber(pkg.remaining_quantity), 0),
      allocations,
    };
  }

  listPickableOrders({ page, limit }: OrderListOptions) {
    const offset = (page - 1) * limit;
    const placeholders = PICKABLE_STATUSES.map(() => "?").join(", ");
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM sales
      WHERE status IN (${placeholders})
    `).get(...PICKABLE_STATUSES) as { total: number };

    const rows = this.db.prepare(`
      SELECT
        s.id,
        s.order_code,
        s.platform,
        s.customer_name,
        s.status,
        s.created_at,
        s.warehouse_picker_user_id,
        s.warehouse_picker_name,
        s.warehouse_picking_started_at,
        COALESCE((
          SELECT SUM(COALESCE(si.quantity, 0))
          FROM sale_items si
          WHERE si.sale_id = s.id
        ), COALESCE(s.total_quantity, 0)) AS total_quantity
      FROM sales s
      WHERE s.status IN (${placeholders})
      ORDER BY datetime(s.created_at) ASC, s.id ASC
      LIMIT ? OFFSET ?
    `).all(...PICKABLE_STATUSES, limit, offset) as any[];

    const total = asNumber(totalRow?.total);
    return {
      orders: rows.map((row) => ({
        id: row.id,
        order_code: row.order_code,
        platform: row.platform,
        customer: row.customer_name,
        status: row.status,
        created_at: row.created_at,
        total_quantity: asNumber(row.total_quantity),
        picker: row.warehouse_picker_user_id ? {
          user_id: row.warehouse_picker_user_id,
          name: row.warehouse_picker_name,
          started_at: row.warehouse_picking_started_at,
        } : null,
      })),
      pagination: {
        page,
        limit,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / limit),
      },
    };
  }

  getOrder(orderId: string) {
    const order = this.db.prepare(`${operationalOrderSelect} WHERE s.id = ?`).get(orderId) as any;
    if (!order) return null;

    const items = this.db.prepare(`
      SELECT
        si.id,
        si.product_id,
        si.product_name,
        COALESCE(si.quantity, 0) AS quantity,
        COALESCE(si.weight, 0) AS weight,
        p.sku,
        p.barcode,
        p.warehouse_location,
        p.product_type,
        EXISTS(SELECT 1 FROM product_bom b WHERE b.parent_product_id = p.id) AS has_bom
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
      ORDER BY si.rowid ASC
    `).all(orderId) as any[];

    return {
      id: order.id,
      order_code: order.order_code,
      external_order_id: order.external_order_id,
      platform: order.platform,
      customer: {
        name: order.customer_name,
        phone: order.customer_phone,
        address: order.customer_address,
      },
      shipping: {
        company: order.shipping_company,
        tracking_number: order.tracking_number,
      },
      status: order.status,
      total_quantity: asNumber(order.total_quantity),
      total_weight: asNumber(order.total_weight),
      created_at: order.created_at,
      updated_at: order.updated_at,
      picker: order.warehouse_picker_user_id ? {
        user_id: order.warehouse_picker_user_id,
        name: order.warehouse_picker_name,
        started_at: order.warehouse_picking_started_at,
        completed_at: order.warehouse_picking_completed_at,
      } : null,
      items: items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        sku: item.sku,
        barcode: item.barcode,
        warehouse_location: item.warehouse_location,
        product_type: canonicalProductType(item.product_type, Number(item.has_bom) === 1),
        quantity: asNumber(item.quantity),
        weight: asNumber(item.weight),
      })),
    };
  }

  buildPickPlan(orderId: string) {
    const order = this.db.prepare(`
      SELECT id, order_code, status, warehouse_picker_user_id, warehouse_picker_name,
             warehouse_picking_started_at, warehouse_picking_completed_at
      FROM sales
      WHERE id = ?
    `).get(orderId) as any;
    if (!order) return null;

    const saleItems = this.db.prepare(`
      SELECT
        si.id,
        si.product_id,
        si.product_name,
        COALESCE(si.quantity, 0) AS quantity,
        p.sku,
        p.barcode,
        p.name,
        p.title,
        p.warehouse_location,
        (SELECT path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.rowid ASC LIMIT 1) AS image_path,
        COALESCE(p.central_stock, 0) AS central_stock,
        COALESCE(p.product_type, 'simple') AS product_type
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
      ORDER BY si.rowid ASC
    `).all(orderId) as any[];

    const bomStatement = this.db.prepare(`
      SELECT
        b.component_product_id,
        b.quantity_per_unit,
        p.sku,
        p.barcode,
        p.name,
        p.title,
        p.warehouse_location,
        (SELECT path FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order ASC, pi.rowid ASC LIMIT 1) AS image_path,
        COALESCE(p.central_stock, 0) AS central_stock,
        COALESCE(p.product_type, 'component') AS product_type
      FROM product_bom b
      LEFT JOIN products p ON p.id = b.component_product_id
      WHERE b.parent_product_id = ?
      ORDER BY p.sku ASC, b.component_product_id ASC
    `);

    type AccumulatedPick = {
      product_id: string;
      sku: string | null;
      barcode: string | null;
      name: string | null;
      warehouse_location: string | null;
      image_path: string | null;
      required_quantity: number;
      central_stock: number;
      product_type: string;
      parentAssemblySkus: Set<string>;
    };

    const picks = new Map<string, AccumulatedPick>();
    const unresolvedItems: Array<Record<string, unknown>> = [];

    const addPick = (product: any, requiredQuantity: number, parentAssemblySku?: string | null) => {
      const productId = String(product?.component_product_id || product?.product_id || "");
      if (!productId || !product?.sku) {
        unresolvedItems.push({
          product_id: productId || null,
          product_name: product?.title || product?.name || null,
          required_quantity: requiredQuantity,
          reason: "PRODUCT_NOT_FOUND",
        });
        return;
      }

      const existing = picks.get(productId) || {
        product_id: productId,
        sku: product.sku || null,
        barcode: product.barcode || null,
        name: product.title || product.name || null,
        warehouse_location: product.warehouse_location || null,
        image_path: product.image_path || null,
        required_quantity: 0,
        central_stock: asNumber(product.central_stock),
        product_type: canonicalProductType(product.product_type),
        parentAssemblySkus: new Set<string>(),
      };
      existing.required_quantity += requiredQuantity;
      if (parentAssemblySku) existing.parentAssemblySkus.add(parentAssemblySku);
      picks.set(productId, existing);
    };

    for (const item of saleItems) {
      const orderQuantity = asNumber(item.quantity);
      if (!item.product_id || !item.sku) {
        unresolvedItems.push({
          sale_item_id: item.id,
          product_id: item.product_id || null,
          product_name: item.product_name || null,
          required_quantity: orderQuantity,
          reason: "PRODUCT_NOT_FOUND",
        });
        continue;
      }

      const bom = bomStatement.all(item.product_id) as any[];
      const isAssembly = item.product_type === "assembly" || bom.length > 0;
      if (!isAssembly) {
        addPick({ ...item, product_id: item.product_id }, orderQuantity);
        continue;
      }

      if (bom.length === 0) {
        unresolvedItems.push({
          sale_item_id: item.id,
          product_id: item.product_id,
          product_name: item.product_name || item.title || item.name,
          sku: item.sku,
          required_quantity: orderQuantity,
          reason: "ASSEMBLY_BOM_EMPTY",
        });
        continue;
      }

      for (const component of bom) {
        const requiredQuantity = orderQuantity * asNumber(component.quantity_per_unit);
        if (!component.sku) {
          unresolvedItems.push({
            sale_item_id: item.id,
            product_id: component.component_product_id || null,
            product_name: component.title || component.name || null,
            parent_assembly_sku: item.sku,
            required_quantity: requiredQuantity,
            reason: "BOM_COMPONENT_NOT_FOUND",
          });
          continue;
        }
        addPick(component, requiredQuantity, item.sku);
      }
    }

    const progressRows = this.db.prepare(`
      SELECT product_id, required_quantity, picked_quantity, picker_user_id, picker_name,
             verified_by, verified_code_type, completed_at, updated_at
      FROM warehouse_pick_progress
      WHERE order_id = ?
    `).all(orderId) as any[];
    const progressByProduct = new Map(progressRows.map((row) => [String(row.product_id), row]));

    const items = [...picks.values()]
      .map((item) => {
        const parentAssemblySkus = [...item.parentAssemblySkus].sort();
        const progress = progressByProduct.get(item.product_id);
        const packageStock = this.packageAllocations(item.product_id, item.required_quantity);
        return {
          product_id: item.product_id,
          sku: item.sku,
          barcode: item.barcode,
          name: item.name,
          warehouse_location: item.warehouse_location,
          image_url: item.image_path ? `/api/warehouse/v1/products/${encodeURIComponent(item.product_id)}/image` : null,
          required_quantity: item.required_quantity,
          central_stock: item.central_stock,
          available_stock: packageStock.tracked ? packageStock.available : item.central_stock,
          package_tracking: packageStock.tracked,
          package_allocations: packageStock.allocations,
          product_type: item.product_type,
          parent_assembly_sku: parentAssemblySkus.length === 1 ? parentAssemblySkus[0] : null,
          parent_assembly_skus: parentAssemblySkus,
          picked_quantity: asNumber(progress?.picked_quantity),
          verified_code_type: progress?.verified_code_type || null,
          completed_at: progress?.completed_at || null,
        };
      })
      .sort((left, right) =>
        String(left.warehouse_location || "").localeCompare(String(right.warehouse_location || ""), "tr") ||
        String(left.sku || "").localeCompare(String(right.sku || ""), "tr")
      );

    const shortages = items
      .filter((item) => item.available_stock < item.required_quantity)
      .map((item) => ({
        product_id: item.product_id,
        sku: item.sku,
        required_quantity: item.required_quantity,
        central_stock: item.central_stock,
        available_stock: item.available_stock,
        shortage_quantity: item.required_quantity - item.available_stock,
      }));

    return {
      order: {
        id: order.id,
        order_code: order.order_code,
        status: order.status,
        picker: order.warehouse_picker_user_id ? {
          user_id: order.warehouse_picker_user_id,
          name: order.warehouse_picker_name,
          started_at: order.warehouse_picking_started_at,
          completed_at: order.warehouse_picking_completed_at,
        } : null,
      },
      items,
      shortages,
      unresolved_items: unresolvedItems,
    };
  }

  listPickHistory(options: PickHistoryOptions) {
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    const addDateRange = (from?: string, to?: string) => {
      if (from) {
        filters.push("datetime(ps.completed_at) >= datetime(?)");
        parameters.push(from);
      }
      if (to) {
        filters.push("datetime(ps.completed_at) < datetime(?)");
        parameters.push(to);
      }
    };
    addDateRange(options.dateFrom, options.dateTo);
    if (options.pickerUserId) {
      filters.push("ps.completed_by_user_id = ?");
      parameters.push(options.pickerUserId);
    }
    if (options.status) {
      filters.push("ps.status = ?");
      parameters.push(options.status);
    }
    if (options.orderNumber) {
      filters.push(`(
        ps.pick_number LIKE ? COLLATE NOCASE OR
        COALESCE(ps.order_code_snapshot, '') LIKE ? COLLATE NOCASE OR
        COALESCE(ps.external_order_id_snapshot, '') LIKE ? COLLATE NOCASE
      )`);
      const needle = `%${options.orderNumber}%`;
      parameters.push(needle, needle, needle);
    }
    if (options.sku) {
      filters.push(`EXISTS (
        SELECT 1 FROM pick_session_items psi
        LEFT JOIN pick_session_components psc ON psc.pick_session_item_id = psi.id
        WHERE psi.pick_session_id = ps.id
          AND (psi.sku_snapshot LIKE ? COLLATE NOCASE OR psc.component_sku_snapshot LIKE ? COLLATE NOCASE)
      )`);
      const needle = `%${options.sku}%`;
      parameters.push(needle, needle);
    }
    if (options.productName) {
      filters.push(`EXISTS (
        SELECT 1 FROM pick_session_items psi
        LEFT JOIN pick_session_components psc ON psc.pick_session_item_id = psi.id
        WHERE psi.pick_session_id = ps.id
          AND (psi.product_name_snapshot LIKE ? COLLATE NOCASE OR psc.component_name_snapshot LIKE ? COLLATE NOCASE)
      )`);
      const needle = `%${options.productName}%`;
      parameters.push(needle, needle);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const total = asNumber((this.db.prepare(`SELECT COUNT(*) AS total FROM pick_sessions ps ${where}`)
      .get(...parameters) as { total: number }).total);
    const offset = (options.page - 1) * options.limit;
    const sessions = (this.db.prepare(`
      SELECT ps.*
      FROM pick_sessions ps
      ${where}
      ORDER BY datetime(ps.completed_at) DESC, ps.pick_number DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, options.limit, offset) as any[]).map(this.mapPickSession);

    const summaryFilters: string[] = [];
    const summaryParameters: string[] = [];
    if (options.summaryFrom) {
      summaryFilters.push("datetime(completed_at) >= datetime(?)");
      summaryParameters.push(options.summaryFrom);
    }
    if (options.summaryTo) {
      summaryFilters.push("datetime(completed_at) < datetime(?)");
      summaryParameters.push(options.summaryTo);
    }
    if (summaryFilters.length === 0) summaryFilters.push("date(completed_at) = date('now')");
    const summaryWhere = `WHERE ${summaryFilters.join(" AND ")}`;
    const summaryRow = this.db.prepare(`
      SELECT COUNT(*) AS completed_pick_count,
             COALESCE(SUM(total_sale_product_quantity), 0) AS total_sale_product_quantity,
             COALESCE(SUM(total_physical_item_quantity), 0) AS total_physical_item_quantity,
             COALESCE(SUM(total_net_weight_g), 0) AS total_net_weight_g
      FROM pick_sessions
      ${summaryWhere}
    `).get(...summaryParameters) as any;
    const byUser = (this.db.prepare(`
      SELECT completed_by_user_id AS user_id,
             completed_by_name_snapshot AS name,
             COUNT(*) AS completed_pick_count,
             COALESCE(SUM(total_physical_item_quantity), 0) AS total_physical_item_quantity
      FROM pick_sessions
      ${summaryWhere}
      GROUP BY completed_by_user_id, completed_by_name_snapshot
      ORDER BY completed_pick_count DESC, name COLLATE NOCASE ASC
    `).all(...summaryParameters) as any[]).map((row) => ({
      user_id: row.user_id,
      name: row.name,
      completed_pick_count: asNumber(row.completed_pick_count),
      total_physical_item_quantity: asNumber(row.total_physical_item_quantity),
    }));
    const users = (this.db.prepare(`
      SELECT completed_by_user_id AS user_id, MAX(completed_by_name_snapshot) AS name
      FROM pick_sessions
      GROUP BY completed_by_user_id
      ORDER BY name COLLATE NOCASE ASC
    `).all() as any[]).map((row) => ({ user_id: row.user_id, name: row.name }));

    return {
      sessions,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / options.limit),
      },
      today_summary: {
        completed_pick_count: asNumber(summaryRow.completed_pick_count),
        total_sale_product_quantity: asNumber(summaryRow.total_sale_product_quantity),
        total_physical_item_quantity: asNumber(summaryRow.total_physical_item_quantity),
        total_net_weight_g: asNumber(summaryRow.total_net_weight_g),
        by_user: byUser,
      },
      users,
    };
  }

  getPickHistory(pickSessionId: string) {
    const sessionRow = this.db.prepare("SELECT * FROM pick_sessions WHERE id = ?").get(pickSessionId) as any;
    if (!sessionRow) return null;
    const itemRows = this.db.prepare(`
      SELECT * FROM pick_session_items
      WHERE pick_session_id = ?
      ORDER BY rowid ASC
    `).all(pickSessionId) as any[];
    const componentStatement = this.db.prepare(`
      SELECT component_product_id, component_sku_snapshot, component_name_snapshot,
             quantity_per_product, picked_product_quantity, total_component_quantity,
             unit_weight_g_snapshot, total_weight_g
      FROM pick_session_components
      WHERE pick_session_item_id = ?
      ORDER BY rowid ASC
    `);
    return {
      ...this.mapPickSession(sessionRow),
      items: itemRows.map((item) => ({
        ...item,
        ordered_quantity: asNumber(item.ordered_quantity),
        picked_quantity: asNumber(item.picked_quantity),
        unit_weight_g_snapshot: asNumber(item.unit_weight_g_snapshot),
        total_weight_g: asNumber(item.total_weight_g),
        total_component_quantity: asNumber(item.total_component_quantity),
        components: (componentStatement.all(item.id) as any[]).map((component) => ({
          ...component,
          quantity_per_product: asNumber(component.quantity_per_product),
          picked_product_quantity: asNumber(component.picked_product_quantity),
          total_component_quantity: asNumber(component.total_component_quantity),
          unit_weight_g_snapshot: asNumber(component.unit_weight_g_snapshot),
          total_weight_g: asNumber(component.total_weight_g),
        })),
      })),
    };
  }

  scanProduct(code: string) {
    const barcodeMatch = this.db.prepare(`
      SELECT id, sku, barcode, name, title, warehouse_location,
             COALESCE(central_stock, 0) AS central_stock,
             product_type,
             EXISTS(SELECT 1 FROM product_bom b WHERE b.parent_product_id = products.id) AS has_bom
      FROM products
      WHERE barcode = ? COLLATE NOCASE
        AND COALESCE(status, 'Active') != 'deleted'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(code) as any;

    const product = barcodeMatch || this.db.prepare(`
      SELECT id, sku, barcode, name, title, warehouse_location,
             COALESCE(central_stock, 0) AS central_stock,
             product_type,
             EXISTS(SELECT 1 FROM product_bom b WHERE b.parent_product_id = products.id) AS has_bom
      FROM products
      WHERE sku = ? COLLATE NOCASE
        AND COALESCE(status, 'Active') != 'deleted'
      ORDER BY rowid ASC
      LIMIT 1
    `).get(code) as any;

    if (!product) return null;
    return {
      product_id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.title || product.name,
      warehouse_location: product.warehouse_location,
      central_stock: asNumber(product.central_stock),
      product_type: canonicalProductType(product.product_type, Number(product.has_bom) === 1),
    };
  }

  getProductImagePath(productId: string): string | null {
    const row = this.db.prepare(`
      SELECT path FROM product_images
      WHERE product_id = ?
      ORDER BY sort_order ASC, rowid ASC
      LIMIT 1
    `).get(productId) as { path?: string } | undefined;
    return row?.path || null;
  }

  startPicking(orderId: string, picker: WarehousePicker): StatusTransitionResult {
    return this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT id, order_code, status, updated_at, warehouse_picker_user_id,
               warehouse_picker_name, warehouse_picking_started_at, warehouse_picking_completed_at
        FROM sales
        WHERE id = ?
      `).get(orderId) as any;

      if (!current) {
        throw new WarehouseServiceError(404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
      }

      if (current.status === WAREHOUSE_ORDER_STATUS.picking) {
        if (current.warehouse_picker_user_id && current.warehouse_picker_user_id !== picker.id) {
          throw new WarehouseServiceError(
            409,
            "ORDER_LOCKED",
            `Bu sipariş ${current.warehouse_picker_name || "başka bir kullanıcı"} tarafından toplanıyor.`,
          );
        }
        if (current.warehouse_picker_user_id === picker.id) {
          return { order: current, idempotent: true, previous_status: current.status };
        }
      }

      if (current.status !== WAREHOUSE_ORDER_STATUS.ready && current.status !== WAREHOUSE_ORDER_STATUS.picking) {
        throw new WarehouseServiceError(
          409,
          "INVALID_ORDER_STATUS",
          `Sipariş '${current.status}' durumundan toplamaya geçirilemez.`,
        );
      }

      const plan = this.buildPickPlan(orderId);
      if (!plan || plan.unresolved_items.length > 0) {
        throw new WarehouseServiceError(409, "PICK_PLAN_UNRESOLVED", "Toplama planında çözümlenemeyen ürün var.");
      }
      if (plan.shortages.length > 0) {
        const shortage = plan.shortages[0];
        throw new WarehouseServiceError(
          409,
          "INSUFFICIENT_STOCK",
          `Stok yetersiz: ${shortage.sku} için ${shortage.shortage_quantity} adet eksik.`,
        );
      }

      const update = this.db.prepare(`
        UPDATE sales
        SET status = ?, warehouse_picker_user_id = ?, warehouse_picker_name = ?,
            warehouse_picking_started_at = COALESCE(warehouse_picking_started_at, CURRENT_TIMESTAMP),
            warehouse_picking_completed_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ? AND (warehouse_picker_user_id IS NULL OR warehouse_picker_user_id = ?)
      `).run(WAREHOUSE_ORDER_STATUS.picking, picker.id, picker.username, orderId, current.status, picker.id);
      if (update.changes !== 1) {
        throw new WarehouseServiceError(409, "ORDER_STATUS_CONFLICT", "Sipariş durumu eş zamanlı olarak değişti.");
      }

      this.writeActivity("WAREHOUSE_PICKING_STARTED", "sale", orderId, {
        order_code: current.order_code,
        previous_status: current.status,
        status: WAREHOUSE_ORDER_STATUS.picking,
        source: "warehouse_api",
        picker_user_id: picker.id,
        picker_name: picker.username,
      }, picker.id);

      const updated = this.db.prepare(`
        SELECT id, order_code, status, updated_at, warehouse_picker_user_id,
               warehouse_picker_name, warehouse_picking_started_at
        FROM sales
        WHERE id = ?
      `).get(orderId) as Record<string, unknown>;

      return { order: updated, idempotent: false, previous_status: current.status };
    })();
  }

  verifyPick(orderId: string, productId: string, code: string, picker: WarehousePicker) {
    return this.db.transaction(() => {
      this.assertPickingOwner(orderId, picker);
      const plan = this.buildPickPlan(orderId);
      const item = plan?.items.find((candidate) =>
        !candidate.completed_at || asNumber(candidate.picked_quantity) !== candidate.required_quantity,
      );
      if (!item || item.product_id !== productId) {
        throw new WarehouseServiceError(409, "PICK_CODE_MISMATCH", "YANLIŞ ÜRÜN / YANLIŞ LOKASYON");
      }

      const normalizedCode = code.trim().toLocaleLowerCase("tr-TR");
      const matches = [
        ["sku", item.sku],
        ["barcode", item.barcode],
        ["location", item.warehouse_location],
        ["barcode", item.package_allocations?.[0]?.package_code],
        ["location", item.package_allocations?.[0]?.location_code],
      ] as const;
      const match = matches.find(([, value]) => value && String(value).trim().toLocaleLowerCase("tr-TR") === normalizedCode);
      if (!match) {
        throw new WarehouseServiceError(409, "PICK_CODE_MISMATCH", "YANLIŞ ÜRÜN / YANLIŞ LOKASYON");
      }

      this.db.prepare(`
        INSERT INTO warehouse_pick_progress (
          order_id, product_id, sku, required_quantity, picked_quantity,
          picker_user_id, picker_name, verified_by, verified_code_type, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id, product_id) DO UPDATE SET
          sku = excluded.sku,
          required_quantity = excluded.required_quantity,
          picker_user_id = excluded.picker_user_id,
          picker_name = excluded.picker_name,
          verified_by = excluded.verified_by,
          verified_code_type = excluded.verified_code_type,
          updated_at = CURRENT_TIMESTAMP
        WHERE warehouse_pick_progress.completed_at IS NULL
      `).run(orderId, productId, item.sku, item.required_quantity, picker.id, picker.username, picker.id, match[0]);

      return { product_id: productId, match_type: match[0], verified: true };
    })();
  }

  completePickItem(orderId: string, productId: string, pickedQuantity: unknown, picker: WarehousePicker) {
    return this.db.transaction(() => {
      this.assertPickingOwner(orderId, picker);
      const plan = this.buildPickPlan(orderId);
      const item = plan?.items.find((candidate) => candidate.product_id === productId);
      if (!item) throw new WarehouseServiceError(404, "PICK_ITEM_NOT_FOUND", "Toplama ürünü bulunamadı.");

      const progress = this.db.prepare(`
        SELECT * FROM warehouse_pick_progress WHERE order_id = ? AND product_id = ?
      `).get(orderId, productId) as any;
      if (progress?.completed_at && asNumber(progress.picked_quantity) === item.required_quantity) {
        return { ...progress, idempotent: true };
      }
      const expected = plan?.items.find((candidate) =>
        !candidate.completed_at || asNumber(candidate.picked_quantity) !== candidate.required_quantity,
      );
      if (expected?.product_id !== productId) {
        throw new WarehouseServiceError(409, "PICK_ITEM_OUT_OF_ORDER", "Önce sıradaki toplama ürünü tamamlanmalıdır.");
      }

      const quantity = asNumber(pickedQuantity);
      if (quantity < item.required_quantity) {
        throw new WarehouseServiceError(409, "PICK_QUANTITY_SHORT", `Eksik adet. ${item.required_quantity} adet toplamalısın.`);
      }
      if (quantity > item.required_quantity) {
        throw new WarehouseServiceError(409, "PICK_QUANTITY_EXCESS", `Fazla adet. ${item.required_quantity} adet toplamalısın.`);
      }

      if (!progress?.verified_code_type || progress.verified_by !== picker.id) {
        throw new WarehouseServiceError(409, "PICK_NOT_VERIFIED", "Adet onayından önce ürün kodu doğrulanmalıdır.");
      }
      if (asNumber(progress.required_quantity) !== item.required_quantity) {
        throw new WarehouseServiceError(409, "PICK_PLAN_CHANGED", "Toplama planı değişti. Ürünü yeniden doğrulayın.");
      }
      if (item.package_tracking) this.consumePackageStock(orderId, item, picker);
      this.db.prepare(`
        UPDATE warehouse_pick_progress
        SET picked_quantity = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE order_id = ? AND product_id = ?
      `).run(quantity, orderId, productId);

      this.writeActivity("WAREHOUSE_ITEM_PICKED", "sale", orderId, {
        product_id: productId,
        sku: item.sku,
        required_quantity: item.required_quantity,
        picked_quantity: quantity,
        verified_code_type: progress.verified_code_type,
        picker_user_id: picker.id,
      }, picker.id);

      return this.db.prepare(`
        SELECT * FROM warehouse_pick_progress WHERE order_id = ? AND product_id = ?
      `).get(orderId, productId);
    })();
  }

  private consumePackageStock(orderId: string, item: any, picker: WarehousePicker) {
    const totalAllocated = (item.package_allocations || []).reduce((sum: number, allocation: any) => sum + asNumber(allocation.pick_quantity), 0);
    if (totalAllocated !== asNumber(item.required_quantity)) {
      throw new WarehouseServiceError(409, "PACKAGE_STOCK_CHANGED", "Paket stoğu değişti. Toplama planını yenileyin.");
    }
    for (const allocation of item.package_allocations) {
      const idempotencyKey = `pick:${orderId}:${item.product_id}:${allocation.package_id}`;
      const existing = this.db.prepare("SELECT id FROM warehouse_package_movements WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) continue;
      const changed = this.db.prepare(`
        UPDATE warehouse_packages
        SET remaining_quantity = remaining_quantity - ?,
            status = CASE WHEN remaining_quantity - ? <= 0 THEN 'EMPTY' ELSE 'OPEN' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('PLACED','OPEN') AND remaining_quantity >= ?
      `).run(allocation.pick_quantity, allocation.pick_quantity, allocation.package_id, allocation.pick_quantity);
      if (changed.changes !== 1) {
        throw new WarehouseServiceError(409, "PACKAGE_STOCK_CHANGED", `${allocation.package_code} paketi başka bir işlemde değişti.`);
      }
      this.db.prepare(`
        INSERT INTO warehouse_package_movements (
          id, package_id, product_id, movement_type, quantity_delta, reference_type, reference_id, idempotency_key, actor_id
        ) VALUES (?, ?, ?, 'PICK', ?, 'sale', ?, ?, ?)
      `).run(randomUUID(), allocation.package_id, item.product_id, -allocation.pick_quantity, orderId, idempotencyKey, picker.id);
    }
    const changed = this.db.prepare(`
      UPDATE products SET central_stock = central_stock - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND COALESCE(central_stock, 0) >= ?
    `).run(item.required_quantity, item.product_id, item.required_quantity);
    if (changed.changes !== 1) throw new WarehouseServiceError(409, "CENTRAL_STOCK_CHANGED", "Merkez stok bakiyesi değişti.");
    this.db.prepare("INSERT INTO stock_movements (id, product_id, platform_name, change_amount, reason, type) VALUES (?, ?, 'WAREHOUSE', ?, ?, 'OUT')")
      .run(randomUUID(), item.product_id, -item.required_quantity, `Paketli sipariş toplama: ${orderId}`);
  }

  completePicking(orderId: string, picker: WarehousePicker, note?: string | null): StatusTransitionResult {
    return this.db.transaction(() => {
      const existingSession = this.db.prepare("SELECT id FROM pick_sessions WHERE order_id = ?").get(orderId);
      if (existingSession) {
        const existingOrder = this.db.prepare(`
          SELECT id, order_code, status, updated_at, warehouse_picker_user_id,
                 warehouse_picker_name, warehouse_picking_started_at, warehouse_picking_completed_at
          FROM sales WHERE id = ?
        `).get(orderId) as Record<string, unknown> | undefined;
        if (!existingOrder) throw new WarehouseServiceError(404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
        return { order: existingOrder, idempotent: true, previous_status: String(existingOrder.status) };
      }

      const current = this.assertPickingOwner(orderId, picker);
      const plan = this.buildPickPlan(orderId);
      if (!plan || plan.items.length === 0 || plan.unresolved_items.length > 0) {
        throw new WarehouseServiceError(409, "PICKING_INCOMPLETE", "Siparişin tüm fiziksel ürünleri tamamlanmadı.");
      }
      const incomplete = plan.items.find((item) =>
        asNumber(item.picked_quantity) !== item.required_quantity || !item.completed_at,
      );
      if (incomplete) {
        throw new WarehouseServiceError(
          409,
          "PICKING_INCOMPLETE",
          `${incomplete.sku} için ${incomplete.required_quantity} adet tamamlanmadan sipariş kapatılamaz.`,
        );
      }

      const pickSession = this.createPickSnapshot(orderId, current, picker, note);

      const update = this.db.prepare(`
        UPDATE sales
        SET status = ?, warehouse_picking_completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ? AND warehouse_picker_user_id = ?
      `).run(WAREHOUSE_ORDER_STATUS.picked, orderId, WAREHOUSE_ORDER_STATUS.picking, picker.id);
      if (update.changes !== 1) {
        throw new WarehouseServiceError(409, "ORDER_STATUS_CONFLICT", "Sipariş durumu eş zamanlı olarak değişti.");
      }

      this.writeActivity("WAREHOUSE_PICKING_COMPLETED", "sale", orderId, {
        order_code: current.order_code,
        previous_status: current.status,
        status: WAREHOUSE_ORDER_STATUS.picked,
        source: "warehouse_api",
        picker_user_id: picker.id,
        picker_name: picker.username,
        pick_session_id: pickSession.id,
        pick_number: pickSession.pick_number,
      }, picker.id);

      const updated = this.db.prepare(`
        SELECT id, order_code, status, updated_at, warehouse_picker_user_id,
               warehouse_picker_name, warehouse_picking_started_at, warehouse_picking_completed_at
        FROM sales WHERE id = ?
      `).get(orderId) as Record<string, unknown>;
      return { order: updated, idempotent: false, previous_status: current.status };
    })();
  }

  private assertPickingOwner(orderId: string, picker: WarehousePicker) {
    const order = this.db.prepare(`
      SELECT id, order_code, external_order_id, status, warehouse_picker_user_id, warehouse_picker_name,
             warehouse_picking_started_at, warehouse_picking_completed_at
      FROM sales WHERE id = ?
    `).get(orderId) as any;
    if (!order) throw new WarehouseServiceError(404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
    if (order.status !== WAREHOUSE_ORDER_STATUS.picking) {
      throw new WarehouseServiceError(409, "INVALID_ORDER_STATUS", "Sipariş toplama durumunda değil.");
    }
    if (order.warehouse_picker_user_id !== picker.id) {
      throw new WarehouseServiceError(
        409,
        "ORDER_LOCKED",
        `Bu sipariş ${order.warehouse_picker_name || "başka bir kullanıcı"} tarafından toplanıyor.`,
      );
    }
    return order;
  }

  private readonly mapPickSession = (row: any) => ({
    id: row.id,
    pick_number: row.pick_number,
    order_id: row.order_id,
    order_code: row.order_code_snapshot,
    external_order_id: row.external_order_id_snapshot,
    status: row.status,
    started_by: { user_id: row.started_by_user_id, name: row.started_by_name_snapshot },
    completed_by: { user_id: row.completed_by_user_id, name: row.completed_by_name_snapshot },
    started_at: row.started_at,
    completed_at: row.completed_at,
    total_product_types: asNumber(row.total_product_types),
    total_sale_product_quantity: asNumber(row.total_sale_product_quantity),
    total_physical_item_quantity: asNumber(row.total_physical_item_quantity),
    total_net_weight_g: asNumber(row.total_net_weight_g),
    note: row.note || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  private createPickSnapshot(orderId: string, order: any, picker: WarehousePicker, note?: string | null) {
    const saleItems = this.db.prepare(`
      SELECT si.id AS sale_item_id, si.product_id, si.product_name, COALESCE(si.quantity, 0) AS quantity,
             p.sku, p.name, p.title, COALESCE(p.product_type, 'simple') AS product_type,
             COALESCE(NULLIF(p.weight_grams, 0), NULLIF(p.weight, 0), 0) AS unit_weight_g,
             EXISTS(SELECT 1 FROM product_bom b WHERE b.parent_product_id = p.id) AS has_bom
      FROM sale_items si
      LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = ?
      ORDER BY si.rowid ASC
    `).all(orderId) as any[];
    const bomStatement = this.db.prepare(`
      SELECT b.component_product_id, b.quantity_per_unit,
             p.sku, p.name, p.title,
             COALESCE(NULLIF(p.weight_grams, 0), NULLIF(p.weight, 0), 0) AS unit_weight_g
      FROM product_bom b
      LEFT JOIN products p ON p.id = b.component_product_id
      WHERE b.parent_product_id = ?
      ORDER BY p.sku ASC, b.component_product_id ASC
    `);

    type SnapshotComponent = {
      component_product_id: string | null;
      sku: string;
      name: string;
      quantity_per_product: number;
      picked_product_quantity: number;
      total_component_quantity: number;
      unit_weight_g: number;
      total_weight_g: number;
    };
    type SnapshotItem = {
      row: any;
      quantity: number;
      productType: "simple" | "component" | "assembly";
      components: SnapshotComponent[];
      unitWeightG: number;
      totalWeightG: number;
      totalComponentQuantity: number;
    };

    const snapshotItems: SnapshotItem[] = saleItems.map((row) => {
      const quantity = asNumber(row.quantity);
      const productType = canonicalProductType(row.product_type, Number(row.has_bom) === 1);
      const bom = row.product_id ? bomStatement.all(row.product_id) as any[] : [];
      const sourceComponents = bom.length > 0 ? bom : [{
        component_product_id: row.product_id,
        quantity_per_unit: 1,
        sku: row.sku,
        name: row.name,
        title: row.title || row.product_name,
        unit_weight_g: row.unit_weight_g,
      }];
      const components = sourceComponents.map((component): SnapshotComponent => {
        const quantityPerProduct = asNumber(component.quantity_per_unit);
        const unitWeightG = asNumber(component.unit_weight_g);
        const totalComponentQuantity = quantityPerProduct * quantity;
        return {
          component_product_id: component.component_product_id || null,
          sku: String(component.sku || "SKU YOK"),
          name: String(component.title || component.name || "İsimsiz ürün"),
          quantity_per_product: quantityPerProduct,
          picked_product_quantity: quantity,
          total_component_quantity: totalComponentQuantity,
          unit_weight_g: unitWeightG,
          total_weight_g: unitWeightG * totalComponentQuantity,
        };
      });
      const unitWeightG = components.reduce(
        (sum, component) => sum + component.unit_weight_g * component.quantity_per_product,
        0,
      );
      return {
        row,
        quantity,
        productType,
        components,
        unitWeightG,
        totalWeightG: components.reduce((sum, component) => sum + component.total_weight_g, 0),
        totalComponentQuantity: components.reduce((sum, component) => sum + component.total_component_quantity, 0),
      };
    });

    const previousNumber = asNumber((this.db.prepare(`
      SELECT MAX(CAST(SUBSTR(pick_number, 6) AS INTEGER)) AS value FROM pick_sessions
    `).get() as { value?: number }).value);
    const id = randomUUID();
    const pickNumber = `PICK-${String(previousNumber + 1).padStart(6, "0")}`;
    const totalSaleQuantity = snapshotItems.reduce((sum, item) => sum + item.quantity, 0);
    const totalPhysicalQuantity = snapshotItems.reduce((sum, item) => sum + item.totalComponentQuantity, 0);
    const totalWeightG = snapshotItems.reduce((sum, item) => sum + item.totalWeightG, 0);
    const totalProductTypes = new Set(snapshotItems.map((item) => item.row.product_id || item.row.sale_item_id)).size;
    const cleanNote = String(note || "").trim() || null;

    this.db.prepare(`
      INSERT INTO pick_sessions (
        id, pick_number, order_id, order_code_snapshot, external_order_id_snapshot, status,
        started_by_user_id, started_by_name_snapshot, completed_by_user_id, completed_by_name_snapshot,
        started_at, completed_at, total_product_types, total_sale_product_quantity,
        total_physical_item_quantity, total_net_weight_g, note
      ) VALUES (?, ?, ?, ?, ?, 'PICKED', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?)
    `).run(
      id, pickNumber, orderId, order.order_code, order.external_order_id || null,
      order.warehouse_picker_user_id, order.warehouse_picker_name, picker.id, picker.username,
      order.warehouse_picking_started_at || new Date().toISOString(), totalProductTypes,
      totalSaleQuantity, totalPhysicalQuantity, totalWeightG, cleanNote,
    );

    const insertItem = this.db.prepare(`
      INSERT INTO pick_session_items (
        id, pick_session_id, sale_item_id, product_id, sku_snapshot, product_name_snapshot,
        product_type_snapshot, ordered_quantity, picked_quantity, unit_weight_g_snapshot,
        total_weight_g, total_component_quantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertComponent = this.db.prepare(`
      INSERT INTO pick_session_components (
        id, pick_session_item_id, component_product_id, component_sku_snapshot,
        component_name_snapshot, quantity_per_product, picked_product_quantity,
        total_component_quantity, unit_weight_g_snapshot, total_weight_g
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of snapshotItems) {
      const itemId = randomUUID();
      insertItem.run(
        itemId, id, item.row.sale_item_id, item.row.product_id,
        item.row.sku || "SKU YOK", item.row.title || item.row.name || item.row.product_name || "İsimsiz ürün",
        item.productType, item.quantity, item.quantity, item.unitWeightG,
        item.totalWeightG, item.totalComponentQuantity,
      );
      for (const component of item.components) {
        insertComponent.run(
          randomUUID(), itemId, component.component_product_id, component.sku, component.name,
          component.quantity_per_product, component.picked_product_quantity,
          component.total_component_quantity, component.unit_weight_g, component.total_weight_g,
        );
      }
    }

    return { id, pick_number: pickNumber };
  }
}

import Database from "better-sqlite3";

export const WAREHOUSE_ORDER_STATUS = {
  ready: "Hazırlanıyor",
  picking: "Toplanıyor",
  picked: "Toplandı",
} as const;

const PICKABLE_STATUSES = [WAREHOUSE_ORDER_STATUS.ready, WAREHOUSE_ORDER_STATUS.picking] as const;

type WarehouseOrderStatus = typeof WAREHOUSE_ORDER_STATUS[keyof typeof WAREHOUSE_ORDER_STATUS];

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
    s.created_at,
    s.updated_at
  FROM sales s
`;

export class WarehouseService {
  constructor(
    private readonly db: Database.Database,
    private readonly writeActivity: ActivityWriter,
  ) {}

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
      SELECT id, order_code, status
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
        COALESCE(p.central_stock, 0) AS central_stock,
        COALESCE(p.product_type, 'finished') AS product_type
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

    const items = [...picks.values()]
      .map((item) => {
        const parentAssemblySkus = [...item.parentAssemblySkus].sort();
        return {
          product_id: item.product_id,
          sku: item.sku,
          barcode: item.barcode,
          name: item.name,
          warehouse_location: item.warehouse_location,
          required_quantity: item.required_quantity,
          central_stock: item.central_stock,
          product_type: item.product_type,
          parent_assembly_sku: parentAssemblySkus.length === 1 ? parentAssemblySkus[0] : null,
          parent_assembly_skus: parentAssemblySkus,
        };
      })
      .sort((left, right) =>
        String(left.warehouse_location || "").localeCompare(String(right.warehouse_location || ""), "tr") ||
        String(left.sku || "").localeCompare(String(right.sku || ""), "tr")
      );

    const shortages = items
      .filter((item) => item.central_stock < item.required_quantity)
      .map((item) => ({
        product_id: item.product_id,
        sku: item.sku,
        required_quantity: item.required_quantity,
        central_stock: item.central_stock,
        shortage_quantity: item.required_quantity - item.central_stock,
      }));

    return {
      order: {
        id: order.id,
        order_code: order.order_code,
        status: order.status,
      },
      items,
      shortages,
      unresolved_items: unresolvedItems,
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

  startPicking(orderId: string, actorId: string): StatusTransitionResult {
    return this.transitionStatus(
      orderId,
      WAREHOUSE_ORDER_STATUS.picking,
      [WAREHOUSE_ORDER_STATUS.ready],
      "WAREHOUSE_PICKING_STARTED",
      actorId,
    );
  }

  completePicking(orderId: string, actorId: string): StatusTransitionResult {
    return this.transitionStatus(
      orderId,
      WAREHOUSE_ORDER_STATUS.picked,
      [WAREHOUSE_ORDER_STATUS.picking],
      "WAREHOUSE_PICKING_COMPLETED",
      actorId,
    );
  }

  private transitionStatus(
    orderId: string,
    targetStatus: WarehouseOrderStatus,
    allowedStatuses: readonly string[],
    activityAction: string,
    actorId: string,
  ): StatusTransitionResult {
    return this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT id, order_code, status, updated_at
        FROM sales
        WHERE id = ?
      `).get(orderId) as any;

      if (!current) {
        throw new WarehouseServiceError(404, "ORDER_NOT_FOUND", "Sipariş bulunamadı.");
      }

      if (current.status === targetStatus) {
        return { order: current, idempotent: true, previous_status: current.status };
      }

      if (!allowedStatuses.includes(current.status)) {
        throw new WarehouseServiceError(
          409,
          "INVALID_ORDER_STATUS",
          `Sipariş '${current.status}' durumundan '${targetStatus}' durumuna geçirilemez.`,
        );
      }

      const update = this.db.prepare(`
        UPDATE sales
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = ?
      `).run(targetStatus, orderId, current.status);
      if (update.changes !== 1) {
        throw new WarehouseServiceError(409, "ORDER_STATUS_CONFLICT", "Sipariş durumu eş zamanlı olarak değişti.");
      }

      this.writeActivity(activityAction, "sale", orderId, {
        order_code: current.order_code,
        previous_status: current.status,
        status: targetStatus,
        source: "warehouse_api",
        api_key_id: actorId,
      }, actorId);

      const updated = this.db.prepare(`
        SELECT id, order_code, status, updated_at
        FROM sales
        WHERE id = ?
      `).get(orderId) as Record<string, unknown>;

      return { order: updated, idempotent: false, previous_status: current.status };
    })();
  }
}

import type Database from "better-sqlite3";

const cleanText = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function stockQuantity(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function legacyPlatformStockTotal(platforms: any[] | undefined): number {
  if (!Array.isArray(platforms)) return 0;
  return platforms.reduce((total, platform) => total + stockQuantity(platform?.stock), 0);
}

export function hasCentralStockPayload(body: any): boolean {
  if (!body) return false;
  if (body.central_stock !== undefined || body.total_stock !== undefined || body.stock !== undefined) return true;
  return Array.isArray(body.platforms) && body.platforms.some((platform: any) => platform?.stock !== undefined && platform?.stock !== null);
}

export function resolveCentralStock(body: any, fallback = 0): number {
  if (body?.central_stock !== undefined && body.central_stock !== null && body.central_stock !== "") return stockQuantity(body.central_stock);
  if (body?.total_stock !== undefined && body.total_stock !== null && body.total_stock !== "") return stockQuantity(body.total_stock);
  if (body?.stock !== undefined && body.stock !== null && body.stock !== "") return stockQuantity(body.stock);
  const legacyStock = legacyPlatformStockTotal(body?.platforms);
  return legacyStock > 0 ? legacyStock : stockQuantity(fallback);
}

export function centralStockChannel(platformName?: string | null): string {
  return cleanText(platformName) || "Merkez Depo";
}

export function createProductStockModule(db: Database.Database) {
  const getProductBomComponents = (productId: string): any[] => {
    if (!productId) return [];
    return db.prepare(`
      SELECT b.component_product_id, b.quantity_per_unit, b.component_role,
        p.id, p.sku, p.name, p.title,
        COALESCE(p.central_stock, 0) as central_stock,
        COALESCE(p.purchase_cost, 0) as purchase_cost,
        COALESCE(p.purchase_price_usd, 0) as purchase_price_usd,
        COALESCE(p.weight_grams, p.weight, 0) as weight_grams
      FROM product_bom b
      JOIN products p ON p.id = b.component_product_id
      WHERE b.parent_product_id = ?
      ORDER BY b.component_role ASC, p.sku ASC
    `).all(productId) as any[];
  };

  const getProductStockProfile = (product: any) => {
    const physicalStock = stockQuantity(product?.central_stock);
    const components = product?.id ? getProductBomComponents(product.id) : [];
    if (components.length === 0) {
      return {
        hasBom: false,
        available_stock: physicalStock,
        physical_stock: physicalStock,
        unit_purchase_cost: Number(product?.purchase_cost) || 0,
        unit_weight: Number(product?.weight_grams ?? product?.weight) || 0,
        components: [],
      };
    }

    let availableStock = Number.POSITIVE_INFINITY;
    let unitPurchaseCost = 0;
    let unitWeight = 0;
    const normalizedComponents = components.map((component) => {
      const quantityPerUnit = Math.max(Number(component.quantity_per_unit) || 0, 0);
      const componentStock = stockQuantity(component.central_stock);
      const componentAvailable = quantityPerUnit > 0 ? Math.floor(componentStock / quantityPerUnit) : 0;
      availableStock = Math.min(availableStock, componentAvailable);
      unitPurchaseCost += (Number(component.purchase_cost) || 0) * quantityPerUnit;
      unitWeight += (Number(component.weight_grams) || 0) * quantityPerUnit;
      return { ...component, quantity_per_unit: quantityPerUnit, available_for_parent: componentAvailable };
    });
    if (!Number.isFinite(availableStock)) availableStock = 0;
    return {
      hasBom: true,
      available_stock: Math.max(Math.floor(availableStock), 0),
      physical_stock: physicalStock,
      unit_purchase_cost: unitPurchaseCost || (Number(product?.purchase_cost) || 0),
      unit_weight: unitWeight || (Number(product?.weight_grams ?? product?.weight) || 0),
      components: normalizedComponents,
    };
  };

  const getProductBomUsage = (componentProductId: string): any[] => {
    if (!componentProductId) return [];
    const rows = db.prepare(`
      SELECT b.parent_product_id, b.quantity_per_unit, b.component_role, p.*
      FROM product_bom b
      JOIN products p ON p.id = b.parent_product_id
      WHERE b.component_product_id = ?
        AND COALESCE(p.status, 'Active') != 'deleted'
      ORDER BY p.sku ASC
    `).all(componentProductId) as any[];
    return rows.map((row) => {
      const stockProfile = getProductStockProfile(row);
      const bottleneck = stockProfile.components.reduce(
        (min: any, component: any) => (!min || component.available_for_parent < min.available_for_parent ? component : min),
        null,
      );
      return {
        parent_product_id: row.parent_product_id,
        quantity_per_unit: Number(row.quantity_per_unit) || 0,
        component_role: row.component_role,
        sku: row.sku,
        name: row.name,
        title: row.title,
        available_stock: stockProfile.available_stock,
        physical_stock: stockProfile.physical_stock,
        bottleneck_component: bottleneck ? {
          sku: bottleneck.sku,
          name: bottleneck.name || bottleneck.title,
          quantity_per_unit: bottleneck.quantity_per_unit,
          central_stock: bottleneck.central_stock,
          available_for_parent: bottleneck.available_for_parent,
        } : null,
      };
    });
  };

  const hydrateProductStock = (product: any, includeBom = false) => {
    const stockProfile = getProductStockProfile(product);
    const weightGrams = stockProfile.hasBom
      ? stockProfile.unit_weight
      : Number(product?.weight_grams ?? product?.weight) || 0;
    return {
      ...product,
      total_stock: stockProfile.available_stock,
      available_stock: stockProfile.available_stock,
      physical_stock: stockProfile.physical_stock,
      is_assembly: stockProfile.hasBom ? 1 : 0,
      stock_source: stockProfile.hasBom ? "bom" : "central",
      purchase_cost: stockProfile.hasBom ? stockProfile.unit_purchase_cost : product.purchase_cost,
      weight_grams: weightGrams,
      weight: weightGrams,
      ...(includeBom ? { bom_components: stockProfile.components } : {}),
    };
  };

  return { getProductBomComponents, getProductStockProfile, getProductBomUsage, hydrateProductStock };
}


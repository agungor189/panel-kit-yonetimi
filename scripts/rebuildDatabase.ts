/**
 * Local-only DB rebuild script.
 *
 * Wipes product / sales / stock data, imports the canonical SKU list from
 * scripts/initial-products.csv, seeds Carbon Steel BOM relations, and fills
 * the database with 180 days of synthetic sales for analytics testing.
 *
 * Usage:  npm run rebuild-db
 */

import path from "node:path";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import Papa from "papaparse";
import { openDatabase, initializeDatabase } from "../server/db/initialize.js";
import { parseSku, buildProductName, type ParsedSku } from "../server/utils/parseSku.js";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "dsdst_panel.db");
const CSV_PATH = path.join(process.cwd(), "scripts", "initial-products.csv");

type CsvRow = {
  "Sira no": string;
  SKU: string;
  "Urun kodu": string;
  Malzeme: string;
  "Urun adi": string;
  "ölçü": string;
  "Stok sayisi": string;
  Fiyat: string;
  "Agirlik (gr)": string;
};

type AssemblySpec = {
  sku: string;
  name: string;
  components: { sku: string; qty: number; role: string }[];
};

const ASSEMBLIES: AssemblySpec[] = [
  // CS-STD-RD-25
  { sku: "CS-STD-RD-25-TEE", name: "Carbon Steel Yuvarlak Boru Kelepçesi Tee 25 mm", components: [{ sku: "CS-STD-RD-25-H01", qty: 2, role: "H1" }] },
  { sku: "CS-STD-RD-25-W4", name: "Carbon Steel Yuvarlak Boru Kelepçesi 4 Way 25 mm", components: [{ sku: "CS-STD-RD-25-H03", qty: 1, role: "H3" }, { sku: "CS-STD-RD-25-H02", qty: 1, role: "H2" }] },
  { sku: "CS-STD-RD-25-W5", name: "Carbon Steel Yuvarlak Boru Kelepçesi 5 Way 25 mm", components: [{ sku: "CS-STD-RD-25-H04", qty: 1, role: "H4" }, { sku: "CS-STD-RD-25-H02", qty: 2, role: "H2" }] },
  { sku: "CS-STD-RD-25-CRS", name: "Carbon Steel Yuvarlak Boru Kelepçesi Cross 25 mm", components: [{ sku: "CS-STD-RD-25-H04", qty: 2, role: "H4" }] },
  { sku: "CS-STD-RD-25-W6", name: "Carbon Steel Yuvarlak Boru Kelepçesi 6 Way 25 mm", components: [{ sku: "CS-STD-RD-25-H02", qty: 4, role: "H2" }] },
  { sku: "CS-STD-RD-25-ELB", name: "Carbon Steel Yuvarlak Boru Kelepçesi Elbow 25 mm", components: [{ sku: "CS-STD-RD-25-H16", qty: 2, role: "H16" }] },
  { sku: "CS-STD-RD-25-SWJ", name: "Carbon Steel Yuvarlak Boru Kelepçesi Swivel Joint 25 mm", components: [{ sku: "CS-STD-RD-25-H05", qty: 2, role: "H5" }, { sku: "CS-STD-RD-25-H06", qty: 2, role: "H6" }] },
  { sku: "CS-STD-RD-25-SWT", name: "Carbon Steel Yuvarlak Boru Kelepçesi Swivel Tee 25 mm", components: [{ sku: "CS-STD-RD-25-SWA", qty: 1, role: "Swivel A" }, { sku: "CS-STD-RD-25-SWB", qty: 1, role: "Swivel B" }] },

  // CS-STD-SQ-25
  { sku: "CS-STD-SQ-25-TEE", name: "Carbon Steel Kare Boru Kelepçesi Tee 25x25 mm", components: [{ sku: "CS-STD-SQ-25-H01", qty: 2, role: "H1" }] },
  { sku: "CS-STD-SQ-25-W4", name: "Carbon Steel Kare Boru Kelepçesi 4 Way 25x25 mm", components: [{ sku: "CS-STD-SQ-25-H03", qty: 1, role: "H3" }, { sku: "CS-STD-SQ-25-H02", qty: 1, role: "H2" }] },
  { sku: "CS-STD-SQ-25-W5", name: "Carbon Steel Kare Boru Kelepçesi 5 Way 25x25 mm", components: [{ sku: "CS-STD-SQ-25-H04", qty: 1, role: "H4" }, { sku: "CS-STD-SQ-25-H02", qty: 2, role: "H2" }] },
  { sku: "CS-STD-SQ-25-CRS", name: "Carbon Steel Kare Boru Kelepçesi Cross 25x25 mm", components: [{ sku: "CS-STD-SQ-25-H04", qty: 2, role: "H4" }] },
  { sku: "CS-STD-SQ-25-W6", name: "Carbon Steel Kare Boru Kelepçesi 6 Way 25x25 mm", components: [{ sku: "CS-STD-SQ-25-H02", qty: 4, role: "H2" }] },

  // CS-DRL-SQ-40
  { sku: "CS-DRL-SQ-40-TEE", name: "Carbon Steel Delmeli Kare Boru Kelepçesi Tee 40x40 mm", components: [{ sku: "CS-DRL-SQ-40-H01", qty: 2, role: "H1" }] },
  { sku: "CS-DRL-SQ-40-W4", name: "Carbon Steel Delmeli Kare Boru Kelepçesi 4 Way 40x40 mm", components: [{ sku: "CS-DRL-SQ-40-H03", qty: 1, role: "H3" }, { sku: "CS-DRL-SQ-40-H02", qty: 1, role: "H2" }] },
  { sku: "CS-DRL-SQ-40-W5", name: "Carbon Steel Delmeli Kare Boru Kelepçesi 5 Way 40x40 mm", components: [{ sku: "CS-DRL-SQ-40-H04", qty: 1, role: "H4" }, { sku: "CS-DRL-SQ-40-H02", qty: 2, role: "H2" }] },
  { sku: "CS-DRL-SQ-40-CRS", name: "Carbon Steel Delmeli Kare Boru Kelepçesi Cross 40x40 mm", components: [{ sku: "CS-DRL-SQ-40-H04", qty: 2, role: "H4" }] },
  { sku: "CS-DRL-SQ-40-BAS", name: "Carbon Steel Delmeli Kare Boru Kelepçesi Base 40x40 mm", components: [{ sku: "CS-DRL-SQ-40-H02", qty: 2, role: "H2" }] },
];

function nowIso(d = new Date()) { return d.toISOString().slice(0, 19).replace("T", " "); }

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function clearProductData(db: Database.Database) {
  const tables = [
    "sale_items", "sales",
    "marketplace_order_lines", "marketplace_orders",
    "stock_movements", "pricing_history",
    "product_bom", "product_platforms", "product_images",
    "products",
  ];
  for (const t of tables) {
    try { db.exec(`DELETE FROM ${t}`); } catch (err) { /* table may not exist */ }
  }
  try {
    db.exec("DELETE FROM transactions WHERE type = 'INCOME' AND category IN ('Satış', 'satis', 'Sales')");
  } catch (err) {}
}

function importProducts(db: Database.Database): Map<string, string> {
  const csv = fs.readFileSync(CSV_PATH, "utf8");
  const parsed = Papa.parse<CsvRow>(csv, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    console.warn("[CSV] Parse warnings:", parsed.errors.slice(0, 3));
  }

  const insert = db.prepare(`
    INSERT INTO products (
      id, name, title, sku, supplier_code, barcode, category, model,
      description, material, product_series, tube_type_code,
      size, size_code, form_code, pipe_size,
      connection_type, usage_area, supplier,
      min_stock_level, central_stock,
      product_type, is_sellable, visible_in_catalog, exclude_from_analysis,
      purchase_price_usd, purchase_cost, sale_price,
      weight, weight_grams, status,
      normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size
    ) VALUES (
      @id, @name, @title, @sku, @supplier_code, @barcode, @category, @model,
      @description, @material, @product_series, @tube_type_code,
      @size, @size_code, @form_code, @pipe_size,
      @connection_type, @usage_area, @supplier,
      @min_stock_level, @central_stock,
      @product_type, @is_sellable, @visible_in_catalog, @exclude_from_analysis,
      @purchase_price_usd, @purchase_cost, @sale_price,
      @weight, @weight_grams, @status,
      @normalized_material, @normalized_model, @normalized_size, @normalized_tube_type, @normalized_pipe_size
    )
  `);

  const skuToId = new Map<string, string>();
  let count = 0;

  db.transaction(() => {
    for (const row of parsed.data) {
      const sku = (row.SKU || "").trim();
      if (!sku) continue;
      const parsedSku = parseSku(sku);
      const id = uuidv4();
      const stock = parseInt(row["Stok sayisi"] || "0", 10) || 0;
      const price = parseFloat(row.Fiyat || "0") || 0;
      const weight = parseFloat(row["Agirlik (gr)"] || "0") || 0;
      const sizeLabel = (row["ölçü"] || parsedSku.size_label || "").trim();
      const supplierCode = (row["Urun kodu"] || "").trim();
      const csvName = (row["Urun adi"] || "").trim();
      const csvMaterial = (row.Malzeme || parsedSku.material || "").trim();

      const isComponent = parsedSku.is_component;
      const isAccessory = parsedSku.is_accessory;
      const productType = isComponent ? "component" : isAccessory ? "accessory" : "finished";
      const sellable = isComponent || isAccessory ? 0 : 1;
      const visible = isComponent || isAccessory ? 0 : 1;
      const excludeFromAnalysis = isComponent || isAccessory ? 1 : 0;
      const tubeText = parsedSku.tube_type === "Yuvarlak" ? "Yuvarlak" : parsedSku.tube_type === "Kare" ? "Kare" : null;

      const displayName = csvName || buildProductName(parsedSku);

      insert.run({
        id,
        name: displayName,
        title: displayName,
        sku,
        supplier_code: supplierCode || null,
        barcode: null,
        category: tubeText ? `${tubeText} Boru Kelepçesi` : "Boru Kelepçesi",
        model: parsedSku.form,
        description: null,
        material: csvMaterial,
        product_series: parsedSku.series,
        tube_type_code: parsedSku.tube_type_code,
        size: sizeLabel || null,
        size_code: parsedSku.size_code,
        form_code: parsedSku.form_code,
        pipe_size: sizeLabel || null,
        connection_type: parsedSku.form,
        usage_area: null,
        supplier: "Çin Tedarikçi",
        min_stock_level: isComponent ? 100 : 50,
        central_stock: stock,
        product_type: productType,
        is_sellable: sellable,
        visible_in_catalog: visible,
        exclude_from_analysis: excludeFromAnalysis,
        purchase_price_usd: price,
        purchase_cost: price,
        sale_price: 0,
        weight: weight,
        weight_grams: weight,
        status: "Active",
        normalized_material: csvMaterial,
        normalized_model: parsedSku.form,
        normalized_size: sizeLabel,
        normalized_tube_type: tubeText,
        normalized_pipe_size: sizeLabel,
      });
      skuToId.set(sku, id);
      count++;
    }
  })();

  console.log(`[Import] Inserted ${count} products from CSV`);
  return skuToId;
}

function seedAssemblies(db: Database.Database, skuToId: Map<string, string>): void {
  const insertAssembly = db.prepare(`
    INSERT INTO products (
      id, name, title, sku, category, model,
      description, material, product_series, tube_type_code,
      size, size_code, form_code, pipe_size,
      connection_type, supplier,
      min_stock_level, central_stock,
      product_type, is_sellable, visible_in_catalog, exclude_from_analysis,
      purchase_price_usd, purchase_cost, sale_price,
      weight, weight_grams, status,
      normalized_material, normalized_model, normalized_size, normalized_tube_type, normalized_pipe_size
    ) VALUES (
      @id, @name, @title, @sku, @category, @model,
      @description, @material, @product_series, @tube_type_code,
      @size, @size_code, @form_code, @pipe_size,
      @connection_type, @supplier,
      0, 0,
      'finished', 1, 1, 0,
      @purchase_price_usd, @purchase_cost, @sale_price,
      @weight, @weight_grams, 'Active',
      @normalized_material, @normalized_model, @normalized_size, @normalized_tube_type, @normalized_pipe_size
    )
  `);

  const insertBom = db.prepare(`
    INSERT INTO product_bom (id, parent_product_id, component_product_id, quantity_per_unit, component_role)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getProduct = db.prepare("SELECT id, purchase_price_usd, purchase_cost, weight FROM products WHERE sku = ?");

  let createdCount = 0;
  let bomCount = 0;

  db.transaction(() => {
    for (const assembly of ASSEMBLIES) {
      const parsed = parseSku(assembly.sku);
      const components = assembly.components.map((c) => {
        const p = getProduct.get(c.sku) as any;
        return p ? { ...c, product: p } : null;
      });
      if (components.some((c) => !c)) {
        console.warn(`[BOM] skipping ${assembly.sku} — missing components`);
        continue;
      }

      const purchaseUsd = components.reduce((s, c) => s + (Number(c!.product.purchase_price_usd) || 0) * c!.qty, 0);
      const purchaseCost = components.reduce((s, c) => s + (Number(c!.product.purchase_cost) || 0) * c!.qty, 0);
      const weight = components.reduce((s, c) => s + (Number(c!.product.weight) || 0) * c!.qty, 0);
      const salePrice = +(purchaseUsd * 2.2).toFixed(2);

      const id = uuidv4();
      insertAssembly.run({
        id,
        name: assembly.name,
        title: assembly.name,
        sku: assembly.sku,
        category: parsed.tube_type ? `${parsed.tube_type} Boru Kelepçesi` : "Boru Kelepçesi",
        model: parsed.form,
        description: "Demonte ürün — depoda H parçaları olarak tutulur, satışta final ürün olarak görünür.",
        material: parsed.material,
        product_series: parsed.series,
        tube_type_code: parsed.tube_type_code,
        size: parsed.size_label,
        size_code: parsed.size_code,
        form_code: parsed.form_code,
        pipe_size: parsed.size_label,
        connection_type: parsed.form,
        supplier: "Demonte (Çin Tedarikçi)",
        purchase_price_usd: purchaseUsd,
        purchase_cost: purchaseCost,
        sale_price: salePrice,
        weight,
        weight_grams: weight,
        normalized_material: parsed.material,
        normalized_model: parsed.form,
        normalized_size: parsed.size_label,
        normalized_tube_type: parsed.tube_type,
        normalized_pipe_size: parsed.size_label,
      });
      skuToId.set(assembly.sku, id);
      createdCount++;

      for (const comp of components) {
        insertBom.run(uuidv4(), id, comp!.product.id, comp!.qty, comp!.role);
        bomCount++;
      }
    }
  })();

  console.log(`[BOM] Created ${createdCount} carbon steel finished assemblies, ${bomCount} BOM lines`);
}

// --- Fake sales seeder -----------------------------------------------------

const PLATFORMS = [
  { name: "Mağaza", weight: 0.4, commission: 0 },
  { name: "Trendyol", weight: 0.25, commission: 0.18 },
  { name: "Hepsiburada", weight: 0.1, commission: 0.15 },
  { name: "N11", weight: 0.05, commission: 0.13 },
  { name: "Amazon", weight: 0.1, commission: 0.15 },
  { name: "B2B", weight: 0.1, commission: 0 },
];

const CUSTOMER_NAMES = [
  "Ahmet Yılmaz", "Mehmet Demir", "Ayşe Kaya", "Fatma Çelik", "Mustafa Şahin",
  "Ali Öztürk", "Hasan Aydın", "Hüseyin Arslan", "İbrahim Doğan", "Murat Koç",
  "Mert Yıldız", "Emre Çetin", "Burak Polat", "Cem Akın", "Serkan Erdoğan",
  "DSDST Ltd. Şti.", "ABC İnşaat A.Ş.", "Akdeniz Yapı San.", "Anadolu Boru Tic.", "MetalArt Ltd.",
];

function pickWeighted<T extends { weight: number }>(rand: () => number, items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i;
  }
  return items[items.length - 1];
}

function seedFakeSales(db: Database.Database, days = 180) {
  const sellable = db.prepare(`
    SELECT id, sku, sale_price, purchase_price_usd, weight, central_stock, name
    FROM products
    WHERE COALESCE(is_sellable, 1) = 1
      AND COALESCE(visible_in_catalog, 1) = 1
      AND status != 'deleted'
  `).all() as any[];

  const components = db.prepare(`
    SELECT b.parent_product_id, b.component_product_id, b.quantity_per_unit
    FROM product_bom b
  `).all() as any[];
  const bomMap = new Map<string, { component_id: string; qty: number }[]>();
  for (const b of components) {
    if (!bomMap.has(b.parent_product_id)) bomMap.set(b.parent_product_id, []);
    bomMap.get(b.parent_product_id)!.push({ component_id: b.component_product_id, qty: b.quantity_per_unit });
  }

  const productMeta = new Map(sellable.map((p) => [p.id, p]));

  const rand = rng(20260505);

  const profiles = sellable.map((p) => {
    const r = rand();
    let velocity: "fast" | "medium" | "slow" | "dead";
    if (r < 0.25) velocity = "fast";
    else if (r < 0.6) velocity = "medium";
    else if (r < 0.85) velocity = "slow";
    else velocity = "dead";
    return { product: p, velocity };
  });

  const insertSale = db.prepare(`
    INSERT INTO sales (
      id, customer_name, customer_phone, total_weight, total_quantity, total_amount,
      status, platform, commission_rate, shipping_cost, discount, packaging_cost,
      ad_spend, other_expenses, net_total, gross_profit, net_profit, exchange_rate_at_transaction,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const insertItem = db.prepare(`
    INSERT INTO sale_items (id, sale_id, product_id, product_name, quantity, weight, unit_price, purchase_cost, net_profit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStock = db.prepare("UPDATE products SET central_stock = central_stock - ? WHERE id = ?");
  const insertMovement = db.prepare(`
    INSERT INTO stock_movements (id, product_id, change_amount, reason, type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertTrans = db.prepare(`
    INSERT INTO transactions (id, date, type, category, platform, amount, product_id, note)
    VALUES (?, ?, 'INCOME', 'Satış', ?, ?, ?, ?)
  `);

  const today = new Date();
  const start = new Date(today.getTime() - days * 24 * 3600 * 1000);
  let saleCount = 0;
  let itemCount = 0;
  let cancelCount = 0;
  const usdTry = 33;

  db.transaction(() => {
    for (let dayOffset = 0; dayOffset < days; dayOffset++) {
      const date = new Date(start.getTime() + dayOffset * 24 * 3600 * 1000);
      const dayOfWeek = date.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const isMonthEnd = date.getDate() >= 25;
      const recencyMultiplier = dayOffset > days * 0.66 ? 1.2 : 1.0;

      for (const profile of profiles) {
        if (profile.velocity === "dead") continue;
        const baseRate = profile.velocity === "fast" ? 1.5 : profile.velocity === "medium" ? 0.5 : 0.15;
        const dayRate = baseRate * (isWeekend ? 0.4 : 1.0) * (isMonthEnd ? 1.3 : 1.0) * recencyMultiplier;
        if (rand() > dayRate) continue;

        const product = profile.product;
        const qty = profile.velocity === "fast"
          ? 1 + Math.floor(rand() * 5)
          : profile.velocity === "medium"
          ? 1 + Math.floor(rand() * 3)
          : 1;

        const platform = pickWeighted(rand, PLATFORMS);
        const customer = CUSTOMER_NAMES[Math.floor(rand() * CUSTOMER_NAMES.length)];

        const purchaseUsd = Number(product.purchase_price_usd) || 0;
        const margin = 1.4 + rand() * 1.4;
        const unitPriceTry = purchaseUsd * usdTry * margin;
        const totalAmount = unitPriceTry * qty;
        const totalWeight = (Number(product.weight) || 0) * qty;
        const purchaseCostTotal = purchaseUsd * usdTry * qty;
        const commission = totalAmount * platform.commission;
        const shipping = qty * 35;
        const grossProfit = totalAmount - purchaseCostTotal;
        const netProfit = grossProfit - commission - shipping;
        const isCancelled = rand() < 0.05;
        const status = isCancelled ? (rand() < 0.5 ? "İptal" : "İade") : "Tamamlandı";

        const ts = new Date(date.getTime() + Math.floor(rand() * 24 * 3600 * 1000));
        const tsIso = nowIso(ts);

        const saleId = uuidv4();
        insertSale.run(
          saleId, customer, null, totalWeight, qty, totalAmount,
          status, platform.name, platform.commission, shipping, 0, qty * 5,
          0, 0, totalAmount - shipping - commission, grossProfit, netProfit, usdTry,
          tsIso, tsIso,
        );

        insertItem.run(uuidv4(), saleId, product.id, product.name, qty, totalWeight, unitPriceTry, purchaseUsd * usdTry, netProfit);
        itemCount++;

        if (!isCancelled) {
          const bom = bomMap.get(product.id);
          if (bom && bom.length > 0) {
            for (const line of bom) {
              const consume = Math.round(line.qty * qty);
              updateStock.run(consume, line.component_id);
              insertMovement.run(uuidv4(), line.component_id, -consume, `BOM tüketimi: ${product.sku} satışı`, "BOM_CONSUMPTION", tsIso);
            }
          } else {
            updateStock.run(qty, product.id);
            insertMovement.run(uuidv4(), product.id, -qty, `Satış: ${customer}`, "SALE", tsIso);
          }
          insertTrans.run(uuidv4(), tsIso, platform.name, totalAmount, product.id, `Satış #${saleId.slice(0, 8)}`);
        } else {
          cancelCount++;
        }

        saleCount++;
      }
    }
  })();

  console.log(`[Fake] ${saleCount} sales (${cancelCount} cancelled/returned), ${itemCount} items over ${days} days`);
}

// --- Main ------------------------------------------------------------------

function main() {
  console.log(`[Rebuild] DB: ${DB_PATH}`);
  console.log(`[Rebuild] CSV: ${CSV_PATH}`);
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const db = openDatabase(DB_PATH);
  initializeDatabase(db);

  console.log("[Rebuild] Clearing product/sales data…");
  clearProductData(db);

  console.log("[Rebuild] Importing CSV…");
  const skuToId = importProducts(db);

  console.log("[Rebuild] Seeding Carbon Steel BOM assemblies…");
  seedAssemblies(db, skuToId);

  console.log("[Rebuild] Seeding 180 days of fake sales…");
  seedFakeSales(db, 180);

  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM products) AS total_products,
      (SELECT COUNT(*) FROM products WHERE COALESCE(is_sellable, 1) = 1 AND COALESCE(visible_in_catalog, 1) = 1) AS sellable_products,
      (SELECT COUNT(*) FROM products WHERE product_type = 'component') AS components,
      (SELECT COUNT(*) FROM products WHERE product_type = 'accessory') AS accessories,
      (SELECT COUNT(*) FROM product_bom) AS bom_lines,
      (SELECT COUNT(*) FROM sales) AS sales,
      (SELECT COUNT(*) FROM sale_items) AS sale_items,
      (SELECT COUNT(*) FROM stock_movements) AS movements
  `).get();
  console.log("[Rebuild] Summary:", summary);

  db.close();
  console.log("[Rebuild] Done.");
}

main();

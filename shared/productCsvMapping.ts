export const PRODUCT_TYPES = ["simple", "component", "assembly", "accessory"] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export type ProductCsvField =
  | "row_number"
  | "sku"
  | "supplier_code"
  | "size"
  | "material"
  | "profile_type"
  | "name_tr"
  | "name_en"
  | "title"
  | "central_stock"
  | "box_count"
  | "units_per_box"
  | "box_weight_kg"
  | "total_weight_kg"
  | "weight_grams"
  | "purchase_price_usd"
  | "product_type"
  | "bom"
  | "description"
  | "warehouse_location"
  | "reserve_locations"
  | "barcode"
  | "notes"
  | "product_series"
  | "party_lot"
  | "lot_quantity";

export type ProductCsvColumnDefinition = {
  field: ProductCsvField;
  label: string;
  aliases: readonly string[];
  required?: boolean;
  ignored?: boolean;
};

/**
 * The one authoritative CSV -> Product vocabulary. Supporting a new spelling
 * should only require adding an alias here.
 */
export const PRODUCT_CSV_COLUMNS: readonly ProductCsvColumnDefinition[] = [
  { field: "row_number", label: "Satır numarası", aliases: ["#", "Sıra No", "Sira No"], ignored: true },
  { field: "sku", label: "SKU", aliases: ["SKU", "Ürün Kodu", "Urun Kodu", "Stok Kodu"], required: true },
  { field: "supplier_code", label: "Tedarikçi kodu", aliases: ["Tedarik NO", "Tedarikçi NO", "Tedarikci NO", "Supplier Code"] },
  { field: "size", label: "Ölçü", aliases: ["Ölçü", "Ǒlçü", "Olcu", "Boru Ölçüsü", "Boru Olcusu", "Size", "Pipe Size"] },
  { field: "material", label: "Malzeme", aliases: ["Malzeme", "Material", "Kategori", "Category"] },
  { field: "profile_type", label: "Profil tipi", aliases: ["Profil Tipi", "Profil Türü", "Profil Turu", "Profile Type", "Tube Type"] },
  { field: "name_tr", label: "Türkçe isim", aliases: ["Isim - TR", "İsim - TR", "İsim TR", "Isim TR", "Ürün Adı", "Urun Adi", "Name TR"] },
  { field: "name_en", label: "İngilizce isim", aliases: ["İsim - EN", "Isim - EN", "İsim EN", "Isim EN", "Name EN"] },
  { field: "title", label: "Başlık", aliases: ["Başlık", "Baslik", "Title"] },
  {
    field: "central_stock",
    label: "Merkez stok",
    aliases: [
      "central_stock", "Central Stock", "total_stock", "Total Stock",
      "Toplam Adet", "Merkez Stok", "Merkez Depo Stoğu", "Merkez Depo Stogu",
      "Toplam Stok", "Stok", "Stok Sayısı", "Stok Sayisi", "Stock",
    ],
  },
  { field: "box_count", label: "Kutu sayısı", aliases: ["Kutu sayısı", "Kutu Sayisi", "Box Count"] },
  { field: "units_per_box", label: "Kutu içi adet", aliases: ["Kutu içi adet", "Kutu Ici Adet", "Units Per Box"] },
  { field: "box_weight_kg", label: "Kutu ağırlığı (kg)", aliases: ["Kutu Ağırlığı", "Kutu Agirligi", "Box Weight", "Box Weight Kg"] },
  { field: "total_weight_kg", label: "Toplam ağırlık (kg)", aliases: ["Toplam Ağırlık", "Toplam Agirlik", "Total Weight", "Total Weight Kg"] },
  { field: "weight_grams", label: "Parça ağırlığı (g)", aliases: ["Parça Ağırlığı", "Parca Agirligi", "Ağırlık", "Agirlik", "Weight Grams", "Unit Weight Grams"] },
  { field: "purchase_price_usd", label: "Alış fiyatı (USD)", aliases: ["Alış Fiyatı", "Alis Fiyati", "Purchase Price", "Purchase Price USD"] },
  { field: "product_type", label: "Ürün tipi", aliases: ["TÜR", "TUR", "Tür", "Product Type"], required: true },
  { field: "bom", label: "BOM", aliases: ["BOM", "Product BOM"] },
  { field: "description", label: "Açıklama", aliases: ["Açıklama", "Aciklama", "Description", "Detay"] },
  { field: "warehouse_location", label: "Toplama lokasyonu", aliases: ["Toplama Lokasyonu", "Lokasyon", "Warehouse Location", "Picking Location", "Raf"] },
  { field: "reserve_locations", label: "Rezerv lokasyonlar", aliases: ["Rezerv Lokasyon", "Rezerv Lokasyonlar", "Reserve Location", "Reserve Locations"] },
  { field: "barcode", label: "Barkod", aliases: ["Barkod", "Barcode", "EAN", "UPC"] },
  { field: "notes", label: "Notlar", aliases: ["Notlar", "Not", "Notes"] },
  { field: "product_series", label: "Ürün serisi", aliases: ["Seri", "Ürün Serisi", "Urun Serisi", "Product Series"] },
  { field: "party_lot", label: "Parti / Lot", aliases: ["Parti/Lot", "Parti Lot", "party_lot", "Party Lot", "batch_lot", "Batch Lot", "Lot", "Lot Number"] },
  { field: "lot_quantity", label: "Lot giriş adedi", aliases: ["lot_quantity", "receiving_quantity", "Lot Adedi", "Parti Adedi", "Mal Kabul Adedi", "Incoming Quantity", "Receiving Quantity"] },
] as const;

export function normalizeCsvHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ı]/g, "i")
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const aliasToField = new Map<string, ProductCsvField>();
for (const definition of PRODUCT_CSV_COLUMNS) {
  for (const alias of definition.aliases) {
    const key = normalizeCsvHeader(alias);
    const previous = aliasToField.get(key);
    if (previous && previous !== definition.field) {
      throw new Error(`CSV alias '${alias}' is assigned to both ${previous} and ${definition.field}.`);
    }
    aliasToField.set(key, definition.field);
  }
}

export type ProductCsvHeaderResolution = {
  byField: Partial<Record<ProductCsvField, string>>;
  matchedColumns: Array<{ csv_header: string; product_field: ProductCsvField; label: string }>;
  unknownColumns: string[];
  duplicateFieldColumns: Array<{ product_field: ProductCsvField; csv_headers: string[] }>;
  missingRequiredFields: ProductCsvField[];
};

export function resolveProductCsvHeaders(headers: readonly string[]): ProductCsvHeaderResolution {
  const byField: Partial<Record<ProductCsvField, string>> = {};
  const grouped = new Map<ProductCsvField, string[]>();
  const unknownColumns: string[] = [];

  for (const rawHeader of headers) {
    const headerKey = String(rawHeader ?? "");
    const displayHeader = headerKey.trim();
    const field = aliasToField.get(normalizeCsvHeader(headerKey));
    if (!field) {
      unknownColumns.push(displayHeader);
      continue;
    }
    const matches = grouped.get(field) || [];
    matches.push(headerKey);
    grouped.set(field, matches);
    if (!byField[field]) byField[field] = headerKey;
  }

  const definitionByField = new Map(PRODUCT_CSV_COLUMNS.map((definition) => [definition.field, definition]));
  const matchedColumns = [...grouped.entries()].map(([field, csvHeaders]) => ({
    csv_header: csvHeaders[0].trim(),
    product_field: field,
    label: definitionByField.get(field)?.label || field,
  }));
  const duplicateFieldColumns = [...grouped.entries()]
    .filter(([, csvHeaders]) => csvHeaders.length > 1)
    .map(([field, csvHeaders]) => ({ product_field: field, csv_headers: csvHeaders.map((header) => header.trim()) }));
  const missingRequiredFields = PRODUCT_CSV_COLUMNS
    .filter((definition) => definition.required && !byField[definition.field])
    .map((definition) => definition.field);

  return { byField, matchedColumns, unknownColumns, duplicateFieldColumns, missingRequiredFields };
}

export function csvValue(
  row: Record<string, unknown>,
  resolution: ProductCsvHeaderResolution,
  field: ProductCsvField,
): unknown {
  const header = resolution.byField[field];
  return header ? row[header] : undefined;
}

export function canonicalProductType(value: unknown): ProductType | null {
  const normalized = normalizeCsvHeader(value);
  return (PRODUCT_TYPES as readonly string[]).includes(normalized) ? normalized as ProductType : null;
}

export function parseReserveLocations(value: unknown): string[] {
  const text = String(value ?? "").trim();
  if (!text) return [];

  let values: unknown[];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      values = Array.isArray(parsed) ? parsed : [text];
    } catch {
      values = [text];
    }
  } else {
    values = text.split(/[;|,\n]+/g);
  }

  return [...new Set(values.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

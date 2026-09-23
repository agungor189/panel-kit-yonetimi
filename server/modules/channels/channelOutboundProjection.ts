import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ChannelProjectionKind = "STOCK" | "PRICE" | "VISIBILITY";

const stableJson = (value: any): string => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

const priceMinor = (value: unknown) => {
  const source = String(value ?? "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) return null;
  const [whole, fraction = ""] = source.split(".");
  const result = Number(BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2)));
  return Number.isSafeInteger(result) ? result : null;
};

const inverseCommission = (targetMinor: number, numerator: number, denominator: number) => {
  if (!Number.isSafeInteger(targetMinor) || !Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || targetMinor < 0 || numerator < 0 || denominator <= numerator) return null;
  const divisor = BigInt(denominator - numerator);
  const value = Number((BigInt(targetMinor) * BigInt(denominator) + divisor - 1n) / divisor);
  return Number.isSafeInteger(value) ? value : null;
};

const currentTerm = (db: Database.Database, mapping: any, at: string) => db.prepare(`SELECT * FROM channel_commission_terms
  WHERE account_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)
    AND (product_id=? OR (product_id IS NULL AND category_ref=?) OR (product_id IS NULL AND category_ref IS NULL))
  ORDER BY CASE WHEN product_id=? THEN 0 WHEN category_ref=? THEN 1 ELSE 2 END,version DESC LIMIT 1`)
  .get(mapping.account_id, at, at, mapping.product_id, mapping.category_ref, mapping.product_id, mapping.category_ref) as any;

export const enqueueCanonicalChannelChanges = (db: Database.Database, input: {
  productId: string;
  kinds: ChannelProjectionKind[];
  operationId: string;
  occurredAt?: string;
}) => {
  const occurredAt = input.occurredAt || new Date().toISOString();
  const mappings = db.prepare(`SELECT m.*,p.sale_price,p.is_sellable,p.visible_in_catalog,p.status,
      COALESCE(b.buffer_quantity_base_int,0) AS stock_buffer,
      (SELECT v.final_sale_price_minor FROM published_kits k JOIN published_kit_versions v
        ON v.id=k.current_version_id WHERE k.product_id=m.product_id) AS kit_price_minor,
      COALESCE((SELECT SUM(on_hand_base_int-reserved_base_int) FROM inventory_lots WHERE product_id=m.product_id),0) AS available,
      EXISTS(SELECT 1 FROM inventory_lots WHERE product_id=m.product_id
        AND status='STOCK_DISCREPANCY' AND on_hand_base_int>0) AS has_stock_discrepancy
    FROM channel_product_mappings m JOIN products p ON p.id=m.product_id
    LEFT JOIN channel_stock_buffers b ON b.account_id=m.account_id AND b.product_id=m.product_id
    WHERE m.product_id=? AND m.listing_state='ACTIVE' ORDER BY m.account_id,m.id`).all(input.productId) as any[];
  const created: any[] = [];
  for (const mapping of mappings) {
    for (const kind of [...new Set(input.kinds)]) {
      let payload: any = null;
      if (kind === "STOCK") payload = {
        productId: mapping.product_id,
        quantityBaseInt: Number(mapping.has_stock_discrepancy) === 1
          ? 0 : Math.max(0, Number(mapping.available) - Number(mapping.stock_buffer)),
        canonicalAvailableBaseInt: Number(mapping.available),
        channelStockBufferBaseInt: Number(mapping.stock_buffer),
        publicationBlockedReason: Number(mapping.has_stock_discrepancy) === 1 ? "STOCK_DISCREPANCY" : null,
      };
      if (kind === "PRICE") {
        const term = currentTerm(db, mapping, occurredAt);
        const targetPriceMinor = mapping.kit_price_minor === null || mapping.kit_price_minor === undefined
          ? priceMinor(mapping.sale_price) : Number(mapping.kit_price_minor);
        const channelPriceMinor = term?.state === "KNOWN" && targetPriceMinor !== null
          ? inverseCommission(targetPriceMinor, Number(term.rate_numerator), Number(term.rate_denominator)) : null;
        if (channelPriceMinor === null) continue;
        payload = { productId: mapping.product_id, targetPriceMinor, channelPriceMinor,
          commissionTermId: term.id, commissionVersion: term.version };
      }
      if (kind === "VISIBILITY") payload = { productId: mapping.product_id,
        visible: Number(mapping.is_sellable) !== 0 && Number(mapping.visible_in_catalog) !== 0 && mapping.status !== "deleted" };
      if (!payload) continue;
      const payloadJson = stableJson(payload);
      const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
      const transitionHash = createHash("sha256").update(stableJson({ operationId: input.operationId, payloadHash })).digest("hex");
      const sourceVersion = `canonical:v2:${transitionHash}`;
      const id = randomUUID();
      db.prepare(`INSERT INTO channel_outbound_jobs
        (id,account_id,product_id,mapping_id,job_kind,source_version,payload_json,payload_hash,state,created_operation_id,available_at)
        VALUES (?,?,?,?,?,?,?,?, 'PENDING',?,?) ON CONFLICT(account_id,product_id,job_kind,source_version) DO NOTHING`).run(
        id, mapping.account_id, mapping.product_id, mapping.id, kind, sourceVersion, payloadJson, payloadHash, input.operationId, occurredAt);
      const job = db.prepare(`SELECT id,account_id AS accountId,product_id AS productId,job_kind AS kind,state,payload_json AS payloadJson
        FROM channel_outbound_jobs WHERE account_id=? AND product_id=? AND job_kind=? AND source_version=?`)
        .get(mapping.account_id, mapping.product_id, kind, sourceVersion) as any;
      created.push({ ...job, payload: JSON.parse(job.payloadJson) });
    }
  }
  return created;
};

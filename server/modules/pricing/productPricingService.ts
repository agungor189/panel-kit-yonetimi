import { finalLandedCostSource } from './finalLandedCostSource.js';
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { finalLandedPricingDecision } from "../../../shared/finalLandedPricing.js";
import { CatalogService } from "../catalog/catalogService.js";
import { enqueueCanonicalChannelChanges } from "../channels/channelOutboundProjection.js";

export type ProductPricingSettings = {
  bufferPercentage: number;
  profitPercentage: number;
  fixedTry: number;
  roundingIncrement: 1 | 5 | 10;
};

export type ProductPricingApproval = {
  productId: string;
  approvedSalePrice: number;
  expectedLandedCostSnapshotId: string;
  expectedLandedCostNumerator: number;
  expectedLandedCostDenominator: number;
  expectedSalePrice: number;
  expectedPriceLocked: boolean;
};

export class ProductPricingValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "ProductPricingValidationError";
  }
}

const finiteNonNegative = (value: unknown, field: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ProductPricingValidationError("PRICING_POLICY_INVALID", `${field} must be a non-negative number.`);
  }
  return parsed;
};

export const normalizeProductPricingSettings = (raw: Partial<ProductPricingSettings>): ProductPricingSettings => {
  const rounding = Number(raw.roundingIncrement ?? 1);
  if (![1, 5, 10].includes(rounding)) {
    throw new ProductPricingValidationError("PRICING_POLICY_INVALID", "roundingIncrement must be 1, 5 or 10 TRY.");
  }
  return {
    bufferPercentage: finiteNonNegative(raw.bufferPercentage, "bufferPercentage"),
    profitPercentage: finiteNonNegative(raw.profitPercentage, "profitPercentage"),
    fixedTry: finiteNonNegative(raw.fixedTry ?? 0, "fixedTry"),
    roundingIncrement: rounding as 1 | 5 | 10,
  };
};

export class ProductPricingService {
  constructor(private readonly db: Database.Database) {}

  preview(productId: string, rawSettings: Partial<ProductPricingSettings>) {
    const settings = normalizeProductPricingSettings(rawSettings);
    const product = this.readProduct(productId);
    if (!product) return { productId, willUpdate: false as const, skipReason: "MISSING_PRODUCT" as const, newSalePrice: null, settings };
    if (product.product_type === "kit" || product.published_kit_id) {
      throw new ProductPricingValidationError("KIT_PUBLICATION_REQUIRED", "KIT price changes require a new canonical published kit version.", 409);
    }
    if (Number(product.price_locked) === 1) return { productId, willUpdate: false as const, skipReason: "LOCKED" as const, newSalePrice: null, settings };
    const landedCostTry = product.cost_try_numerator == null || !Number(product.cost_try_denominator)
      ? null
      : Number(product.cost_try_numerator) / Number(product.cost_try_denominator) / 100;
    return { productId, ...finalLandedPricingDecision(landedCostTry, settings.bufferPercentage, settings.profitPercentage, settings.fixedTry, settings.roundingIncrement), settings };
  }

  applyMany(input: { approvals: ProductPricingApproval[]; settings: Partial<ProductPricingSettings>; actorId?: string | null; reason: string; operationId: string }) {
    const settings = normalizeProductPricingSettings(input.settings);
    if (!Array.isArray(input.approvals) || input.approvals.length === 0) {
      throw new ProductPricingValidationError("PRICING_PREVIEW_REQUIRED", "An approved pricing preview is required.", 409);
    }
    const productIds = input.approvals.map((approval) => String(approval?.productId || "").trim());
    if (productIds.some((id) => !id) || new Set(productIds).size !== productIds.length) {
      throw new ProductPricingValidationError("PRICING_PREVIEW_INVALID", "Pricing preview products must be unique and valid.");
    }
    const result = { updatedCount: 0, skippedLockedCount: 0, skippedMissingCount: 0, skippedMissingLandedCostCount: 0, skippedNonPositiveCount: 0, activatedCount: 0 };
    return this.db.transaction(() => {
      const validated = input.approvals.map((approval) => {
        const productId = String(approval.productId);
        const current = this.readProduct(productId);
        if (!current) {
          throw new ProductPricingValidationError("PRICING_PREVIEW_STALE", "A product from the approved preview no longer exists.", 409);
        }
        const expectedSnapshotId = String(approval.expectedLandedCostSnapshotId || "");
        const expectedNumerator = Number(approval.expectedLandedCostNumerator);
        const expectedDenominator = Number(approval.expectedLandedCostDenominator);
        const expectedSalePrice = Number(approval.expectedSalePrice);
        const expectedPriceLocked = Boolean(approval.expectedPriceLocked);
        if (!expectedSnapshotId || !Number.isFinite(expectedNumerator) || !Number.isFinite(expectedDenominator)
          || expectedDenominator <= 0 || !Number.isFinite(expectedSalePrice)) {
          throw new ProductPricingValidationError("PRICING_PREVIEW_INVALID", "Pricing preview snapshot is incomplete.", 409);
        }
        const stale = expectedSnapshotId !== String(current.acquisition_cost_snapshot_id || "")
          || expectedNumerator !== Number(current.cost_try_numerator)
          || expectedDenominator !== Number(current.cost_try_denominator)
          || expectedSalePrice !== Number(current.sale_price || 0)
          || expectedPriceLocked !== (Number(current.price_locked) === 1);
        if (stale) {
          throw new ProductPricingValidationError(
            "PRICING_PREVIEW_STALE",
            "FINAL Landed Cost, price lock or current sale price changed after preview. Create a new preview.",
            409,
          );
        }
        const preview = this.preview(productId, settings);
        if (!preview.willUpdate || preview.newSalePrice === null) {
          throw new ProductPricingValidationError("PRICING_PREVIEW_STALE", "The product is no longer eligible for the approved pricing preview.", 409);
        }
        if (!Number.isFinite(Number(approval.approvedSalePrice)) || Number(approval.approvedSalePrice) !== preview.newSalePrice) {
          throw new ProductPricingValidationError(
            "PRICING_PREVIEW_MISMATCH",
            "Approved sale price does not match the price recalculated from current FINAL Landed Cost.",
            409,
          );
        }
        return { approval, current, preview };
      });

      for (const { approval, current, preview } of validated) {
        const productId = String(approval.productId);
        this.db.prepare(`INSERT INTO pricing_history (
          id,product_id,purchase_price_usd,purchase_cost,sale_price,buffer_percentage,profit_percentage,
          exchange_rate_used,price_locked,changed_by,change_reason,fixed_price_adjustment_try,price_rounding_increment,final_cost_source_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          randomUUID(), productId, current.purchase_price_usd, current.purchase_cost, current.sale_price,
          current.buffer_percentage, current.profit_percentage, current.exchange_rate_used, current.price_locked,
          input.actorId ?? null, input.reason, current.fixed_price_adjustment_try ?? 0, current.price_rounding_increment ?? 1,
          JSON.stringify(finalLandedCostSource(this.db, productId)),
        );
        const changed = this.db.prepare(`UPDATE products SET sale_price=?,buffer_percentage=?,profit_percentage=?,
          fixed_price_adjustment_try=?,price_rounding_increment=?,updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND COALESCE(price_locked,0)=0`).run(
          preview.newSalePrice, settings.bufferPercentage, settings.profitPercentage,
          settings.fixedTry, settings.roundingIncrement, productId,
        );
        if (changed.changes !== 1) {
          throw new ProductPricingValidationError("PRICING_PREVIEW_STALE", "Price lock changed after preview. Create a new preview.", 409);
        }
        this.db.prepare("UPDATE product_platforms SET price=? WHERE product_id=?").run(preview.newSalePrice, productId);
        const activated = new CatalogService(this.db).activateProcurementProductIfReady(productId);
        enqueueCanonicalChannelChanges(this.db, {
          productId,
          kinds: activated ? ["PRICE", "VISIBILITY"] : ["PRICE"],
          operationId: input.operationId,
        });
        result.updatedCount++;
        if (activated) result.activatedCount++;
      }
      return result;
    }).immediate();
  }

  private readProduct(productId: string) {
    const product = this.db.prepare(`SELECT p.*,lc.acquisition_cost_snapshot_id,lc.cost_try_numerator,lc.cost_try_denominator,k.id AS published_kit_id
      FROM products p
      LEFT JOIN current_product_landed_costs lc ON lc.product_id=p.id
      LEFT JOIN published_kits k ON k.product_id=p.id
      WHERE p.id=?`).get(productId) as any;
    if (!product) return null;
    const cost = finalLandedCostSource(this.db, productId);
    return { ...product, acquisition_cost_snapshot_id: cost?.reference ?? null, cost_try_numerator: cost?.numerator ?? null, cost_try_denominator: cost?.denominator ?? null };
  }
}

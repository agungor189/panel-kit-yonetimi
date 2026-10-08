export function calculateFinalLandedSalePrice(
  landedCostTry: number | null | undefined,
  bufferPercentage: number,
  profitPercentage: number,
  fixedTry = 0,
  roundingIncrement: 1 | 5 | 10 = 1,
): number | null {
  if (landedCostTry === null || landedCostTry === undefined) return null;

  const landedCost = Number(landedCostTry);
  if (!Number.isFinite(landedCost) || landedCost < 0) return null;

  const buffer = Number.isFinite(Number(bufferPercentage)) ? Number(bufferPercentage) : 0;
  const profit = Number.isFinite(Number(profitPercentage)) ? Number(profitPercentage) : 0;
  const fixed = Number.isFinite(Number(fixedTry)) ? Number(fixedTry) : 0;
  if (buffer < 0 || profit < 0 || fixed < 0 || ![1, 5, 10].includes(roundingIncrement)) return null;
  const rawPrice = landedCost * (1 + buffer / 100) * (1 + profit / 100) + fixed;
  return Math.ceil(rawPrice / roundingIncrement) * roundingIncrement;
}

export function finalLandedPricingDecision(
  landedCostTry: number | null | undefined,
  bufferPercentage: number,
  profitPercentage: number,
  fixedTry = 0,
  roundingIncrement: 1 | 5 | 10 = 1,
) {
  const newSalePrice = calculateFinalLandedSalePrice(
    landedCostTry,
    bufferPercentage,
    profitPercentage,
    fixedTry,
    roundingIncrement,
  );
  return newSalePrice === null || newSalePrice <= 0
    ? { newSalePrice: null, willUpdate: false as const, skipReason: newSalePrice === null ? 'MISSING_LANDED_COST' as const : 'NON_POSITIVE_PRICE' as const }
    : { newSalePrice, willUpdate: true as const, skipReason: null };
}

export type FinalLandedPricingPreviewSettings = {
  bufferPercentage: number;
  profitPercentage: number;
  fixedTry: number;
  roundingIncrement: 1 | 5 | 10;
};

export type FinalLandedPricingPreviewProduct = {
  product_type?: string | null;
  catalog_type?: string | null;
  price_locked?: boolean | number | null;
  landed_cost_snapshot_id?: string | null;
  landed_cost_numerator?: number | null;
  landed_cost_denominator?: number | null;
  landed_cost_try?: number | null;
  [key: string]: unknown;
};

export function buildFinalLandedPricingPreview<T extends FinalLandedPricingPreviewProduct>(
  products: readonly T[],
  settings: FinalLandedPricingPreviewSettings,
) {
  return products.map((product) => {
    if (product.product_type === 'kit' || product.catalog_type === 'KIT') {
      return { ...product, newSalePrice: null, willUpdate: false as const, skipReason: 'KIT' as const };
    }
    if (Boolean(product.price_locked)) {
      return { ...product, newSalePrice: null, willUpdate: false as const, skipReason: 'LOCKED' as const };
    }
    if (!product.landed_cost_snapshot_id
      || product.landed_cost_numerator == null
      || !Number(product.landed_cost_denominator)) {
      return { ...product, newSalePrice: null, willUpdate: false as const, skipReason: 'MISSING_LANDED_COST' as const };
    }
    return {
      ...product,
      ...finalLandedPricingDecision(
        product.landed_cost_try,
        settings.bufferPercentage,
        settings.profitPercentage,
        settings.fixedTry,
        settings.roundingIncrement,
      ),
    };
  });
}

export function paginateFinalLandedPricingPreview<T>(rows: readonly T[], page: number, pageSize = 50) {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const currentPage = Math.min(pageCount, Math.max(1, Math.floor(page)));
  return {
    rows: rows.slice((currentPage - 1) * safePageSize, currentPage * safePageSize),
    currentPage,
    pageCount,
    total: rows.length,
  };
}

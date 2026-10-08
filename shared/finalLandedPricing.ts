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

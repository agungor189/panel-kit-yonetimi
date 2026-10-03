export function calculateFinalLandedSalePrice(
  landedCostTry: number | null | undefined,
  bufferPercentage: number,
  profitPercentage: number,
): number | null {
  if (landedCostTry === null || landedCostTry === undefined) return null;

  const landedCost = Number(landedCostTry);
  if (!Number.isFinite(landedCost) || landedCost < 0) return null;

  const buffer = Number.isFinite(Number(bufferPercentage)) ? Number(bufferPercentage) : 0;
  const profit = Number.isFinite(Number(profitPercentage)) ? Number(profitPercentage) : 0;
  return Math.ceil(landedCost * (1 + buffer / 100) * (1 + profit / 100));
}

export function finalLandedPricingDecision(
  landedCostTry: number | null | undefined,
  bufferPercentage: number,
  profitPercentage: number,
) {
  const newSalePrice = calculateFinalLandedSalePrice(landedCostTry, bufferPercentage, profitPercentage);
  return newSalePrice === null
    ? { newSalePrice: null, willUpdate: false as const, skipReason: 'MISSING_LANDED_COST' as const }
    : { newSalePrice, willUpdate: true as const, skipReason: null };
}

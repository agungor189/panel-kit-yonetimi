export type Rational = { numerator: number; denominator: number };

export class MoneyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyValidationError";
  }
}

const safeNumber = (value: bigint, field: string): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new MoneyValidationError(`${field} exceeds safe integer money precision.`);
  return result;
};

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

export const reduceRational = (numerator: bigint | number, denominator: bigint | number, field = "rational"): Rational => {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (n < 0n || d <= 0n) throw new MoneyValidationError(`${field} must be a non-negative rational with a positive denominator.`);
  const divisor = gcd(n, d);
  return { numerator: safeNumber(n / divisor, `${field}.numerator`), denominator: safeNumber(d / divisor, `${field}.denominator`) };
};

export const parseDecimalRational = (value: unknown, field: string, maxScale = 8): Rational => {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length || 0) > maxScale) {
    throw new MoneyValidationError(`${field} must be a positive decimal with at most ${maxScale} fraction digits.`);
  }
  const fraction = match[2] || "";
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]) * denominator + BigInt(fraction || "0");
  if (numerator <= 0n) throw new MoneyValidationError(`${field} must be greater than zero.`);
  return reduceRational(numerator, denominator, field);
};

export const integerMoney = (value: unknown, field: string, allowZero = true): number => {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new MoneyValidationError(`${field} must be ${allowZero ? "a non-negative" : "a positive"} integer minor-unit amount.`);
  }
  return Number(value);
};

export const roundRatio = (numerator: bigint, denominator: bigint, field = "amount"): number => {
  if (numerator < 0n || denominator <= 0n) throw new MoneyValidationError(`${field} has an invalid ratio.`);
  return safeNumber((numerator + denominator / 2n) / denominator, field);
};

export const multiplyAndRound = (amountMinor: number, ratio: Rational, field: string): number => (
  roundRatio(BigInt(integerMoney(amountMinor, field)) * BigInt(ratio.numerator), BigInt(ratio.denominator), field)
);

export const amountForQuantity = (unitPriceMinor: number, quantity: Rational): number => (
  roundRatio(BigInt(integerMoney(unitPriceMinor, "supplierUnitPriceMinor")) * BigInt(quantity.numerator), BigInt(quantity.denominator), "line amount")
);

export const splitVat = (sourceAmountMinor: number, mode: "EXCLUDED" | "INCLUDED", vatRateBps: number) => {
  const amount = integerMoney(sourceAmountMinor, "sourceAmountMinor");
  if (!Number.isSafeInteger(vatRateBps) || vatRateBps < 0 || vatRateBps > 10_000) {
    throw new MoneyValidationError("vatRateBps must be an integer between 0 and 10000.");
  }
  if (mode === "EXCLUDED") {
    const vatMinor = roundRatio(BigInt(amount) * BigInt(vatRateBps), 10_000n, "VAT");
    return { netMinor: amount, vatMinor, grossMinor: amount + vatMinor };
  }
  if (mode === "INCLUDED") {
    const netMinor = roundRatio(BigInt(amount) * 10_000n, BigInt(10_000 + vatRateBps), "VAT-inclusive net");
    return { netMinor, vatMinor: amount - netMinor, grossMinor: amount };
  }
  throw new MoneyValidationError("vatMode must be INCLUDED or EXCLUDED.");
};

export const convertMoney = (amounts: { netMinor: number; vatMinor: number; grossMinor: number }, rate: Rational) => {
  const netMinor = multiplyAndRound(amounts.netMinor, rate, "base TRY net");
  const grossMinor = multiplyAndRound(amounts.grossMinor, rate, "base TRY gross");
  return { netMinor, vatMinor: grossMinor - netMinor, grossMinor };
};

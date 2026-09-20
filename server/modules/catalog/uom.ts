export const UOM_REGISTRY_VERSION = "uom-registry:v1" as const;

export const UOM_DEFINITIONS = [
  { code: "piece", dimension: "count", baseQuantum: "piece", quantityScale: 1 },
  { code: "meter", dimension: "length", baseQuantum: "millimeter", quantityScale: 1000 },
  { code: "square_meter", dimension: "area", baseQuantum: "square_millimeter", quantityScale: 1_000_000 },
  { code: "kg", dimension: "mass", baseQuantum: "gram", quantityScale: 1000 },
  { code: "roll", dimension: "count", baseQuantum: "roll", quantityScale: 1 },
  { code: "package", dimension: "count", baseQuantum: "package", quantityScale: 1 },
  { code: "box", dimension: "count", baseQuantum: "box", quantityScale: 1 },
  { code: "millimeter", dimension: "length", baseQuantum: "millimeter", quantityScale: 1 },
  { code: "centimeter", dimension: "length", baseQuantum: "millimeter", quantityScale: 10 },
  { code: "gram", dimension: "mass", baseQuantum: "gram", quantityScale: 1 },
] as const;

export type UomCode = typeof UOM_DEFINITIONS[number]["code"];
export type LengthUom = Extract<UomCode, "millimeter" | "centimeter" | "meter">;

export class UomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UomValidationError";
  }
}

const definitions = new Map<string, typeof UOM_DEFINITIONS[number]>(UOM_DEFINITIONS.map((definition) => [definition.code, definition]));

type Fraction = { numerator: bigint; denominator: bigint };

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
};

const reduce = ({ numerator, denominator }: Fraction): Fraction => {
  const divisor = gcd(numerator, denominator);
  const sign = denominator < 0n ? -1n : 1n;
  return { numerator: numerator / divisor * sign, denominator: denominator / divisor * sign };
};

const parseDecimal = (value: string | number): Fraction => {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new UomValidationError("Numeric quantities must be non-negative safe integers; fractional values must be decimal strings.");
  }
  const source = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(source)) throw new UomValidationError("Quantity must be a non-negative decimal string.");
  const [whole, fraction = ""] = source.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  return reduce({ numerator: BigInt(`${whole}${fraction}`), denominator });
};

const finiteDecimal = (fraction: Fraction): string => {
  const reduced = reduce(fraction);
  let denominator = reduced.denominator;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos += 1; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives += 1; }
  if (denominator !== 1n) throw new UomValidationError("Conversion result cannot be represented at fixed decimal precision.");
  const places = Math.max(twos, fives);
  const scaledNumerator = reduced.numerator * (2n ** BigInt(places - twos)) * (5n ** BigInt(places - fives));
  if (places === 0) return scaledNumerator.toString();
  const raw = scaledNumerator.toString().padStart(places + 1, "0");
  const whole = raw.slice(0, -places);
  const decimals = raw.slice(-places).replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole;
};

export const getUomDefinition = (code: UomCode | string) => {
  const definition = definitions.get(code);
  if (!definition) throw new UomValidationError(`Unsupported UOM: ${code}`);
  return definition;
};

export function convertExact(quantity: string | number, from: UomCode, to: UomCode) {
  const source = getUomDefinition(from);
  const target = getUomDefinition(to);
  if (source.dimension !== target.dimension || source.baseQuantum !== target.baseQuantum) {
    throw new UomValidationError(`UOMs ${from} and ${to} are not convertible.`);
  }
  const value = parseDecimal(quantity);
  const converted = reduce({
    numerator: value.numerator * BigInt(source.quantityScale),
    denominator: value.denominator * BigInt(target.quantityScale),
  });
  return {
    quantity: finiteDecimal(converted),
    from,
    to,
    numerator: source.quantityScale,
    denominator: target.quantityScale,
    registryVersion: UOM_REGISTRY_VERSION,
    conversionRef: from === to ? `uom-identity:${from}:v1` : `uom-conversion:${from}:${to}:v1`,
  };
}

export function normalizeBaseQuantity(quantity: string | number, uomCode: UomCode) {
  const definition = getUomDefinition(uomCode);
  const value = parseDecimal(quantity);
  const numerator = value.numerator * BigInt(definition.quantityScale);
  if (numerator % value.denominator !== 0n) {
    throw new UomValidationError(`${uomCode} quantity does not resolve to an integer base quantity.`);
  }
  const normalized = numerator / value.denominator;
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw new UomValidationError("Base quantity exceeds safe integer range.");
  return {
    baseQuantity: Number(normalized),
    baseQuantum: definition.baseQuantum,
    baseUomCode: uomCode,
    quantityScale: definition.quantityScale,
    registryVersion: UOM_REGISTRY_VERSION,
    conversionRef: `uom-base:${uomCode}:v1`,
  };
}

export const lengthToMillimeters = (quantity: string | number, unit: LengthUom): number => {
  let normalized;
  try {
    normalized = normalizeBaseQuantity(quantity, unit);
  } catch (error) {
    if (error instanceof UomValidationError && /integer base quantity/i.test(error.message)) {
      throw new UomValidationError("Length must resolve to an integer millimeter value.");
    }
    throw error;
  }
  if (normalized.baseQuantum !== "millimeter") throw new UomValidationError("Length must resolve to integer millimeters.");
  return normalized.baseQuantity;
};

export const millimetersToLength = (millimeters: number, unit: LengthUom): string => {
  if (!Number.isSafeInteger(millimeters) || millimeters < 0) throw new UomValidationError("Length must be a non-negative integer millimeter value.");
  return convertExact(millimeters, "millimeter", unit).quantity;
};

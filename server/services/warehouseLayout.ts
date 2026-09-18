export type WarehouseLayoutObject = {
  id: string;
  type: "rack" | "column" | "door";
  name: string;
  x: number;
  z: number;
  rotation: number;
  width: number;
  depth: number;
  height: number;
  color?: string;
  rackCode?: string;
  shelfCount?: number;
  positionsPerShelf?: number;
};

export type WarehouseLayout = {
  warehouse: { name: string; width: number; length: number; height: number };
  objects: WarehouseLayoutObject[];
};

export const compareWarehouseRackCodes = (left: string, right: string) => left.localeCompare(right, "en", {
  numeric: true,
  sensitivity: "base",
});

const text = (value: unknown, fallback = "") => typeof value === "string" ? value.trim() : fallback;
const finite = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const positive = (value: unknown, fallback: number) => Math.max(0.01, finite(value, fallback));

/**
 * Converts the legacy depo-planner document to the read-only physical layout model.
 * Product, stock, package and placement collections are intentionally never read.
 */
export function parseLegacyWarehouseLayout(input: unknown): WarehouseLayout {
  if (!input || typeof input !== "object") throw new Error("Geçerli depo planı JSON nesnesi gerekli.");
  const source = input as Record<string, unknown>;
  const config = source.warehouseConfig && typeof source.warehouseConfig === "object"
    ? source.warehouseConfig as Record<string, unknown>
    : {};
  const allowed = new Set(["rack", "column", "door"]);
  const objects = Array.isArray(source.objects) ? source.objects : [];

  const physical = objects.flatMap((raw, index): WarehouseLayoutObject[] => {
    if (!raw || typeof raw !== "object") return [];
    const object = raw as Record<string, unknown>;
    const type = text(object.type).toLowerCase();
    if (!allowed.has(type)) return [];
    const base = {
      id: text(object.id, `legacy-${type}-${index + 1}`),
      type: type as WarehouseLayoutObject["type"],
      name: text(object.name, type === "rack" ? "Raf" : type === "column" ? "Kolon" : "Kapı"),
      x: finite(object.x),
      z: finite(object.z),
      rotation: finite(object.rotation),
      width: positive(object.width, type === "door" ? 1 : 0.5),
      depth: positive(object.depth, 0.2),
      height: positive(object.height, type === "rack" ? 1.8 : 2),
      color: text(object.color) || undefined,
    };
    if (type !== "rack") return [base];
    const rackCode = text(object.rackCode).toUpperCase().replace(/\s+/g, "");
    if (!rackCode) throw new Error(`${base.name} için rackCode zorunludur.`);
    return [{
      ...base,
      rackCode,
      shelfCount: Math.max(1, Math.trunc(finite(object.shelfCount, 1))),
      positionsPerShelf: Math.max(1, Math.trunc(finite(object.positionsPerShelf ?? object.binsPerShelf, 1))),
    }];
  });

  return {
    warehouse: {
      name: text(config.name, text(source.name, "Depo")),
      width: positive(config.width, 10),
      length: positive(config.length, 10),
      height: positive(config.height, 4),
    },
    objects: physical,
  };
}

export function layoutLocationCodes(layout: WarehouseLayout) {
  return layout.objects
    .filter((object) => object.type === "rack" && object.rackCode)
    .sort((left, right) => compareWarehouseRackCodes(left.rackCode!, right.rackCode!))
    .flatMap((object) => {
      const codes: string[] = [];
      for (let shelf = 1; shelf <= (object.shelfCount || 1); shelf += 1) {
        for (let position = 1; position <= (object.positionsPerShelf || 1); position += 1) {
          codes.push(`${object.rackCode}-K${shelf}-P${position}`);
        }
      }
      return codes;
    });
}

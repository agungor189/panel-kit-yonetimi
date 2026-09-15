import assert from "node:assert/strict";
import test from "node:test";
import { layoutLocationCodes, parseLegacyWarehouseLayout } from "./warehouseLayout.js";

test("legacy layout parser yalnız fiziksel geometriyi alır ve rackCode kullanır", () => {
  const result = parseLegacyWarehouseLayout({
    warehouseConfig: { name: "Test", width: 10, length: 5, height: 4 },
    objects: [
      { id: "r1", type: "rack", name: "A1 Rafı", rackCode: "G1", x: 1, z: 2, width: 1.8, depth: .6, height: 1.8, shelfCount: 2, binsPerShelf: 3, defaultLocationCapacity: 99 },
      { id: "c1", type: "column", x: 3, z: 2, width: .3, depth: .3, height: 4 },
      { id: "p1", type: "package", sku: "YASAK" },
    ],
    products: [{ sku: "YASAK" }], locationStocks: [{ location: "G1-K1-P1" }], packages: [{ id: "YASAK" }],
  });
  assert.equal(result.objects.length, 2);
  assert.equal(result.objects[0].rackCode, "G1");
  assert.equal("defaultLocationCapacity" in result.objects[0], false);
  assert.deepEqual(layoutLocationCodes(result), ["G1-K1-P1", "G1-K1-P2", "G1-K1-P3", "G1-K2-P1", "G1-K2-P2", "G1-K2-P3"]);
  assert.equal(JSON.stringify(result).includes("YASAK"), false);
});

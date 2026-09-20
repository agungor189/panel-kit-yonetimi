import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeDatabase } from "../../db/initialize.js";
import { CatalogService, CatalogValidationError } from "./catalogService.js";
import { convertExact, lengthToMillimeters, millimetersToLength, normalizeBaseQuantity } from "./uom.js";

test("mm/cm/m conversions round-trip exactly and reject sub-millimeter precision", () => {
  for (const [quantity, unit, millimeters] of [
    ["1250", "millimeter", 1250],
    ["125", "centimeter", 1250],
    ["1.25", "meter", 1250],
  ] as const) {
    assert.equal(lengthToMillimeters(quantity, unit), millimeters);
    assert.equal(lengthToMillimeters(millimetersToLength(millimeters, unit), unit), millimeters);
  }
  assert.equal(convertExact("1.25", "meter", "centimeter").quantity, "125");
  assert.throws(() => lengthToMillimeters("1.0005", "meter"), /integer millimeter/i);
});

test("controlled UOM quantities use integer base quanta and piece rejects fractions", () => {
  assert.equal(normalizeBaseQuantity("1.234", "meter").baseQuantity, 1234);
  assert.equal(normalizeBaseQuantity("0.001", "kg").baseQuantity, 1);
  assert.throws(() => normalizeBaseQuantity("1.5", "piece"), /integer base quantity/i);
  assert.throws(() => normalizeBaseQuantity("0.0005", "kg"), /integer base quantity/i);
  assert.throws(() => normalizeBaseQuantity("1", "unknown" as never), /unsupported UOM/i);
});

test("profile catalog versions typed attributes and validates standard/custom lengths", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  const created = catalog.createProduct({
    id: "profile-30",
    sku: "PR-AL-SQ-30",
    title: "30x30 alüminyum profil",
    catalog_type: "profile",
    base_uom_code: "meter",
    mass_grams: 1200,
    profile: {
      material: "ALUMINUM",
      form: "square",
      width_mm: 30,
      height_mm: 30,
      wall_thickness_mm: 2,
      standard_purchase_lengths_mm: [1000, 2000, 3000, 6000],
      custom_length_allowed: false,
    },
  });

  assert.equal(created.catalog_version, 1);
  assert.match(created.catalog_version_ref, /^catalog-product:profile-30:v1$/);
  assert.equal(created.base_uom.code, "meter");
  assert.equal(created.profile?.width_mm, "30");
  assert.equal(created.profile?.width_micrometers, 30_000);
  assert.equal(catalog.validateProfilePurchaseLength("profile-30", 3000).kind, "standard");
  assert.throws(() => catalog.validateProfilePurchaseLength("profile-30", 2500), /custom length is not allowed/i);

  const versioned = catalog.updateProduct("profile-30", 1, {
    ...created,
    profile: { ...created.profile!, custom_length_allowed: true },
  });
  assert.equal(versioned.catalog_version, 2);
  assert.equal(catalog.validateProfilePurchaseLength("profile-30", 2500).kind, "custom");
  assert.equal(db.prepare("SELECT COUNT(*) FROM catalog_product_versions WHERE product_id='profile-30'").pluck().get(), 2);
  assert.throws(
    () => db.prepare("UPDATE catalog_product_versions SET snapshot_json='{}' WHERE product_id='profile-30'").run(),
    /immutable/i,
  );
  db.close();
});

test("profile cross-sections use fixed micrometer precision while lengths remain integer mm", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  assert.throws(() => catalog.createProduct({
    sku: "BAD-PROFILE",
    title: "Bad profile",
    catalog_type: "profile",
    base_uom_code: "meter",
    profile: {
      material: "ALUMINUM",
      form: "round",
      diameter_mm: "33.7001",
      wall_thickness_mm: "1.5",
      standard_purchase_lengths_mm: [6000],
      custom_length_allowed: false,
    },
  }), /at most 3 decimal places/i);
  const precise = catalog.createProduct({
    id: "precise-profile", sku: "PRECISE", title: "Precise profile", catalog_type: "profile", base_uom_code: "meter",
    profile: { material: "STEEL", form: "round", diameter_mm: "33.7", wall_thickness_mm: "1.5", standard_purchase_lengths_mm: [6000], custom_length_allowed: false },
  });
  assert.equal(precise.profile?.diameter_mm, "33.7");
  assert.equal(precise.profile?.diameter_micrometers, 33_700);
  assert.equal(precise.profile?.wall_thickness_micrometers, 1_500);
  assert.throws(() => catalog.validateProfilePurchaseLength("precise-profile", 1500.5), /integer millimeter/i);
  assert.throws(() => catalog.createProduct({
    sku: "BAD-LENGTH",
    title: "Bad standard length",
    catalog_type: "profile",
    base_uom_code: "meter",
    profile: {
      material: "ALUMINUM",
      form: "round",
      diameter_mm: 30,
      wall_thickness_mm: 2,
      standard_purchase_lengths_mm: [2500],
      custom_length_allowed: false,
    },
  }), /standard purchase length/i);
  db.close();
});

test("complementary products accept controlled base UOMs and base UOM identity is immutable", () => {
  const db = new Database(":memory:");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  for (const code of ["piece", "meter", "square_meter", "kg", "roll", "package", "box"] as const) {
    const created = catalog.createProduct({ id: `comp-${code}`, sku: `COMP-${code}`, title: code, catalog_type: "complementary", base_uom_code: code });
    assert.equal(created.catalog_type, "complementary");
    assert.equal(created.base_uom.code, code);
  }
  const piece = catalog.getProduct("comp-piece")!;
  assert.throws(() => catalog.updateProduct(piece.id, piece.catalog_version, { ...piece, base_uom_code: "box" }), /Base UOM identity is immutable/i);
  assert.equal(db.prepare("SELECT COUNT(*) FROM catalog_product_versions WHERE product_id=?").pluck().get(piece.id), 1);
  db.close();
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { importProductImages, inspectProductImageFile, type StagedProductImage } from "./productImageImport.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL);
    CREATE TABLE product_images (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    );
    INSERT INTO products (id, sku) VALUES ('product-1', 'AL-R100-ELB');
  `);
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "product-images-"));
  return { db, uploadsDir };
}

function stage(uploadsDir: string, originalname: string, contents: string, mimetype = "image/png"): StagedProductImage {
  const stagedPath = path.join(uploadsDir, `staged-${crypto.randomUUID()}`);
  fs.writeFileSync(stagedPath, contents);
  return { originalname, mimetype, path: stagedPath };
}

test("SKU filename is matched case-insensitively and missing products are skipped", () => {
  const { db, uploadsDir } = setup();
  try {
    const matched = stage(uploadsDir, "al-r100-elb.png", "first");
    const missing = stage(uploadsDir, "ABC.png", "missing");
    const report = importProductImages(db, uploadsDir, [matched, missing]);

    assert.equal(report.uploaded, 1);
    assert.equal(report.skipped, 1);
    assert.equal(report.results[0].matched_sku, "AL-R100-ELB");
    assert.equal(report.results[1].code, "PRODUCT_NOT_FOUND");
    assert.equal(fs.existsSync(missing.path), false);

    const image = db.prepare("SELECT product_id, path, sort_order FROM product_images").get() as any;
    assert.deepEqual(image, {
      product_id: "product-1",
      path: "/uploads/products/AL-R100-ELB.png",
      sort_order: 0,
    });
    assert.equal(fs.readFileSync(path.join(uploadsDir, "products", "AL-R100-ELB.png"), "utf8"), "first");
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("uploading the same SKU replaces its image without duplicate records", () => {
  const { db, uploadsDir } = setup();
  try {
    importProductImages(db, uploadsDir, [stage(uploadsDir, "AL-R100-ELB.png", "old")]);
    const report = importProductImages(db, uploadsDir, [stage(uploadsDir, "AL-R100-ELB.jpg", "new", "image/jpeg")]);

    assert.equal(report.results[0].code, "IMAGE_REPLACED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM product_images WHERE product_id = 'product-1'").get() as any).count, 1);
    assert.equal((db.prepare("SELECT path FROM product_images WHERE product_id = 'product-1'").pluck().get()), "/uploads/products/AL-R100-ELB.jpg");
    assert.equal(fs.existsSync(path.join(uploadsDir, "products", "AL-R100-ELB.png")), false);
    assert.equal(fs.readFileSync(path.join(uploadsDir, "products", "AL-R100-ELB.jpg"), "utf8"), "new");
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("invalid extensions, MIME mismatches and unsafe names are rejected", () => {
  assert.equal(inspectProductImageFile("AL-R100-ELB.gif", "image/gif").valid, false);
  assert.equal(inspectProductImageFile("AL-R100-ELB.png", "image/jpeg").valid, false);
  assert.equal(inspectProductImageFile("../AL-R100-ELB.png", "image/png").valid, false);
  assert.deepEqual(inspectProductImageFile("AL-R100-ELB.webp", "image/webp"), {
    valid: true,
    sku: "AL-R100-ELB",
    extension: ".webp",
  });
});

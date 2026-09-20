import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { ensureProductImageDirectory, importProductImages, inspectProductImageFile, type StagedProductImage } from "./productImageImport.js";
import { chunkItems } from "../../shared/productImageBatch.js";

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
  const uploadsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "product-images-")));
  return { db, uploadsDir };
}

const validPng = await sharp({ create: { width: 1, height: 1, channels: 4, background: "#ff0000ff" } }).png().toBuffer();
const validJpeg = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#00ff00" } }).jpeg().toBuffer();
const pngBytes = (_payload: string) => Buffer.from(validPng);
const jpegBytes = (_payload: string) => Buffer.from(validJpeg);

function stage(uploadsDir: string, originalname: string, contents: string | Buffer, mimetype = "image/png"): StagedProductImage {
  const productsDir = path.join(uploadsDir, "products");
  fs.mkdirSync(productsDir, { recursive: true });
  const stagedPath = path.join(productsDir, `.staged-${crypto.randomUUID()}`);
  fs.writeFileSync(stagedPath, contents);
  return { originalname, mimetype, path: stagedPath };
}

test("SKU filename is matched case-insensitively and missing products are skipped", async () => {
  const { db, uploadsDir } = setup();
  try {
    const matched = stage(uploadsDir, "al-r100-elb.png", pngBytes("first"));
    const missing = stage(uploadsDir, "ABC.png", pngBytes("missing"));
    const report = await importProductImages(db, uploadsDir, [matched, missing]);

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
    assert.equal(fs.readFileSync(path.join(uploadsDir, "products", "AL-R100-ELB.png")).equals(validPng), true);
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("uploading the same SKU replaces its image without duplicate records", async () => {
  const { db, uploadsDir } = setup();
  try {
    await importProductImages(db, uploadsDir, [stage(uploadsDir, "AL-R100-ELB.png", pngBytes("old"))]);
    const report = await importProductImages(db, uploadsDir, [stage(uploadsDir, "AL-R100-ELB.jpg", jpegBytes("new"), "image/jpeg")]);

    assert.equal(report.results[0].code, "IMAGE_REPLACED");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM product_images WHERE product_id = 'product-1'").get() as any).count, 1);
    assert.equal((db.prepare("SELECT path FROM product_images WHERE product_id = 'product-1'").pluck().get()), "/uploads/products/AL-R100-ELB.jpg");
    assert.equal(fs.existsSync(path.join(uploadsDir, "products", "AL-R100-ELB.png")), false);
    assert.equal(fs.readFileSync(path.join(uploadsDir, "products", "AL-R100-ELB.jpg")).equals(validJpeg), true);
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

test("MIME and extension compatible uploads still reject invalid image bytes", async () => {
  const { db, uploadsDir } = setup();
  try {
    const spoofed = stage(uploadsDir, "AL-R100-ELB.png", "this is not a png", "image/png");
    const report = await importProductImages(db, uploadsDir, [spoofed]);

    assert.equal(report.uploaded, 0);
    assert.equal(report.skipped, 1);
    assert.equal(report.results[0].code, "INVALID_FILE_CONTENT");
    assert.equal(fs.existsSync(spoofed.path), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM product_images").get() as any).count, 0);
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

test("bulk import rejects arbitrary local paths and symlinked staged files without deleting their targets", async () => {
  const { db, uploadsDir } = setup();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "product-image-outside-"));
  const outside = path.join(outsideDir, "secret.png");
  fs.writeFileSync(outside, pngBytes("secret"));
  fs.mkdirSync(path.join(uploadsDir, "products"), { recursive: true });
  const symlink = path.join(uploadsDir, "products", ".staged-symlink.png");
  fs.symlinkSync(outside, symlink);
  try {
    const report = await importProductImages(db, uploadsDir, [
      { originalname: "AL-R100-ELB.png", mimetype: "image/png", path: outside },
      { originalname: "AL-R100-ELB.png", mimetype: "image/png", path: symlink },
    ]);
    assert.deepEqual(report.results.map((result) => result.code), ["UNSAFE_STAGED_PATH", "UNSAFE_STAGED_PATH"]);
    assert.equal(fs.readFileSync(outside).equals(validPng), true);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM product_images").get() as any).count, 0);
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("bulk staging directory cannot be a symlink outside the upload root", () => {
  const uploadsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "product-image-root-")));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "product-image-staging-outside-")));
  fs.symlinkSync(outsideDir, path.join(uploadsDir, "products"), "dir");
  try {
    assert.throws(
      () => ensureProductImageDirectory(uploadsDir),
      /symlink|escapes the server-owned upload root/,
    );
    assert.deepEqual(fs.readdirSync(outsideDir), []);
  } finally {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("300 SKU-named images survive client-sized batches without loss", async () => {
  const { db, uploadsDir } = setup();
  try {
    const insert = db.prepare("INSERT INTO products (id,sku) VALUES (?,?)");
    const files: StagedProductImage[] = [];
    for (let index = 1; index <= 300; index++) {
      const sku = `BULK-${String(index).padStart(3, "0")}`;
      insert.run(`bulk-${index}`, sku);
      files.push(stage(uploadsDir, `${sku}.png`, pngBytes(`image-${index}`)));
    }
    const reports = [];
    for (const batch of chunkItems(files)) reports.push(await importProductImages(db, uploadsDir, batch));
    assert.equal(reports.reduce((sum, report) => sum + report.uploaded, 0), 300);
    assert.equal(reports.reduce((sum, report) => sum + report.skipped, 0), 0);
    assert.equal((db.prepare("SELECT COUNT(*) count FROM product_images WHERE product_id LIKE 'bulk-%'").get() as any).count, 300);
  } finally {
    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
});

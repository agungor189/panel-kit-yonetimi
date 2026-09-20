import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectUpload, persistUpload, removeStoredUpload, removeStoredUploadReference } from "../services/uploadSecurity.js";

test("product and expense deletion do not join database paths directly to process cwd", () => {
  const source = fs.readFileSync(path.resolve("server.ts"), "utf8");
  assert.doesNotMatch(source, /path\.join\(process\.cwd\(\),\s*image\.path\)/);
  assert.doesNotMatch(source, /path\.join\(process\.cwd\(\),\s*attachment\.file_path\)/);
});

test("Panel upload routes use bounded memory staging and explicit file-count limits", () => {
  const source = fs.readFileSync(path.resolve("server.ts"), "utf8");
  assert.match(source, /storage:\s*multer\.memoryStorage\(\),\s*\n\s*limits:\s*\{ fileSize: 8 \* 1024 \* 1024, files: 12 \}/);
  assert.match(source, /upload\.array\("images", 12\)/);
  assert.match(source, /limits:\s*\{ fileSize: 10 \* 1024 \* 1024, files: 1 \}/);
});

test("stored upload deletion rejects traversal, absolute, encoded and legacy paths", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-delete-"));
  const uploads = path.join(sandbox, "uploads");
  const outside = path.join(sandbox, "outside.txt");
  fs.mkdirSync(path.join(uploads, "products"), { recursive: true });
  fs.writeFileSync(outside, "outside");
  try {
    for (const storedPath of [
      "/uploads/../../outside.txt",
      "/uploads/products/../../../outside.txt",
      "/uploads/%2e%2e/outside.txt",
      "/uploads/%252e%252e/outside.txt",
      outside,
      "../../outside.txt",
      "/legacy/arbitrary/path.txt",
    ]) {
      assert.equal(removeStoredUpload(uploads, storedPath).status, "rejected", storedPath);
      assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an invalid legacy database path removes only its reference and never the outside file", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-legacy-"));
  const uploads = path.join(sandbox, "uploads");
  const outside = path.join(sandbox, "outside.txt");
  fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(outside, "outside");
  let referenceDeleted = false;
  try {
    const result = removeStoredUploadReference(uploads, "/uploads/../outside.txt", () => { referenceDeleted = true; });
    assert.equal(result.status, "rejected");
    assert.equal(referenceDeleted, true);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("stored upload deletion removes a regular in-root file and rejects symlink escape", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-symlink-"));
  const uploads = path.join(sandbox, "uploads");
  const outsideDir = path.join(sandbox, "outside");
  const valid = path.join(uploads, "products", "valid.png");
  const outside = path.join(outsideDir, "secret.png");
  fs.mkdirSync(path.dirname(valid), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(valid, "valid");
  fs.writeFileSync(outside, "secret");
  try {
    assert.equal(removeStoredUpload(uploads, "/uploads/products/valid.png").status, "deleted");
    assert.equal(fs.existsSync(valid), false);
    fs.symlinkSync(outsideDir, path.join(uploads, "escape"), "dir");
    assert.equal(removeStoredUpload(uploads, "/uploads/escape/secret.png").status, "rejected");
    assert.equal(fs.readFileSync(outside, "utf8"), "secret");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("upload inspection requires safe name, extension, MIME and byte signature consistency", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(inspectUpload("photo.png", "image/png", png, ["image/png"]).valid, true);
  assert.equal(inspectUpload("../photo.png", "image/png", png, ["image/png"]).valid, false);
  assert.equal(inspectUpload("%2e%2e%2fphoto.png", "image/png", png, ["image/png"]).valid, false);
  assert.equal(inspectUpload("photo.jpg", "image/png", png, ["image/png"]).valid, false);
  assert.equal(inspectUpload("photo.png", "image/png", Buffer.from("not png"), ["image/png"]).valid, false);
});

test("active PDF is rejected and persisted filenames are server generated", () => {
  const activePdf = Buffer.from("%PDF-1.7\n1 0 obj << /OpenAction 2 0 R /JavaScript (x) >>\nendobj\n%%EOF");
  assert.deepEqual(inspectUpload("invoice.pdf", "application/pdf", activePdf, ["application/pdf"]), {
    valid: false,
    code: "ACTIVE_CONTENT",
    message: "Aktif içerik veya gömülü dosya içeren PDF kabul edilmez.",
  });

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-persist-"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  try {
    const stored = persistUpload({
      uploadsDir: sandbox,
      folder: "products",
      prefix: "product",
      originalName: "client-controlled.png",
      declaredMime: "image/png",
      buffer: png,
      allowedMimes: ["image/png"],
    });
    assert.match(stored.publicPath, /^\/uploads\/products\/product-[0-9a-f-]+\.png$/);
    assert.equal(stored.publicPath.includes("client-controlled"), false);
    assert.equal(fs.readFileSync(stored.absolutePath).equals(png), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

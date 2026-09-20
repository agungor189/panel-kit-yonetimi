import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeStoredUploadCleanup, inspectUpload, persistUpload, removeStoredUpload, removeStoredUploadReference } from "../services/uploadSecurity.js";

const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

function minimalPdf(activeName?: "Open#41ction" | "J#61vaScript" | "J#53"): Buffer {
  const catalogAction = activeName === "Open#41ction" ? " /Open#41ction 4 0 R" : "";
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${catalogAction} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1 1] >>",
    ...(activeName ? [`<< /S /${activeName === "Open#41ction" ? "URI" : activeName} >>`] : []),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

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
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-delete-")));
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
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-legacy-")));
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
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-symlink-")));
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

test("upload inspection requires safe name, extension, MIME and decoded image consistency", async () => {
  assert.equal((await inspectUpload("photo.png", "image/png", validPng, ["image/png"])).valid, true);
  assert.equal((await inspectUpload("../photo.png", "image/png", validPng, ["image/png"])).valid, false);
  assert.equal((await inspectUpload("%2e%2e%2fphoto.png", "image/png", validPng, ["image/png"])).valid, false);
  assert.equal((await inspectUpload("photo.jpg", "image/png", validPng, ["image/png"])).valid, false);
  assert.equal((await inspectUpload("photo.png", "image/png", Buffer.from("not png"), ["image/png"])).valid, false);
  assert.equal((await inspectUpload("header-only.png", "image/png", validPng.subarray(0, 8), ["image/png"])).valid, false);
  assert.equal((await inspectUpload("truncated.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), ["image/jpeg"])).valid, false);
  assert.equal((await inspectUpload("garbage.webp", "image/webp", Buffer.from("RIFFxxxxWEBPgarbage"), ["image/webp"])).valid, false);
});

test("escaped active PDF is rejected, static PDF is accepted and persisted filenames are server generated", async () => {
  for (const activeName of ["Open#41ction", "J#61vaScript", "J#53"] as const) {
    assert.deepEqual(await inspectUpload("invoice.pdf", "application/pdf", minimalPdf(activeName), ["application/pdf"]), {
      valid: false,
      code: "ACTIVE_CONTENT",
      message: "Aktif içerik veya gömülü dosya içeren PDF kabul edilmez.",
    }, activeName);
  }
  assert.equal((await inspectUpload("invoice.pdf", "application/pdf", minimalPdf(), ["application/pdf"])).valid, true);
  assert.equal((await inspectUpload("broken.pdf", "application/pdf", Buffer.from("%PDF-1.7\nnot a pdf\n%%EOF"), ["application/pdf"])).valid, false);

  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-persist-")));
  try {
    const stored = await persistUpload({
      uploadsDir: sandbox,
      folder: "products",
      prefix: "product",
      originalName: "client-controlled.png",
      declaredMime: "image/png",
      buffer: validPng,
      allowedMimes: ["image/png"],
    });
    assert.match(stored.publicPath, /^\/uploads\/products\/product-[0-9a-f-]+\.png$/);
    assert.equal(stored.publicPath.includes("client-controlled"), false);
    assert.equal(fs.readFileSync(stored.absolutePath).equals(validPng), true);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("upload and delete reject a symlinked root or parent without touching the target", async () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-root-")));
  const outside = path.join(sandbox, "outside");
  const rootLink = path.join(sandbox, "uploads-link");
  const parentLink = path.join(sandbox, "parent-link");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, rootLink, "dir");
  fs.symlinkSync(outside, parentLink, "dir");
  fs.writeFileSync(path.join(outside, "keep.png"), validPng);
  try {
    await assert.rejects(() => persistUpload({ uploadsDir: rootLink, folder: "products", originalName: "x.png", declaredMime: "image/png", buffer: validPng, allowedMimes: ["image/png"] }));
    await assert.rejects(() => persistUpload({ uploadsDir: path.join(parentLink, "nested-root"), folder: "products", originalName: "x.png", declaredMime: "image/png", buffer: validPng, allowedMimes: ["image/png"] }));
    assert.equal(removeStoredUpload(rootLink, "/uploads/keep.png").status, "rejected");
    assert.deepEqual(fs.readdirSync(outside).sort(), ["keep.png"]);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("DB failure restores the original file and a retry can complete safely", () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-db-failure-")));
  const file = path.join(sandbox, "products", "kept.png");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, validPng);
  assert.throws(() => removeStoredUploadReference(sandbox, "/uploads/products/kept.png", () => { throw new Error("db failed"); }), /db failed/);
  assert.equal(fs.readFileSync(file).equals(validPng), true);
  let deleted = false;
  assert.equal(removeStoredUploadReference(sandbox, "/uploads/products/kept.png", () => { deleted = true; }).status, "deleted");
  assert.equal(deleted, true);
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("DB success with final cleanup failure leaves a recoverable quarantine file without a dangling reference", () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "panel-upload-cleanup-failure-")));
  const file = path.join(sandbox, "products", "pending.png");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, validPng);
  let deleted = false;
  try {
    const result = removeStoredUploadReference(sandbox, "/uploads/products/pending.png", () => { deleted = true; }, {
      unlink: () => { throw new Error("simulated cleanup failure"); },
    });
    assert.equal(result.status, "cleanup_pending");
    assert.equal(deleted, true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(result.absolutePath), true);
    assert.equal(fs.readFileSync(result.absolutePath).equals(validPng), true);
    assert.equal(finalizeStoredUploadCleanup(sandbox, result.absolutePath), "deleted");
    assert.equal(finalizeStoredUploadCleanup(sandbox, result.absolutePath), "missing");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

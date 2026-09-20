import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

const CANONICAL_EXTENSION: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

const ACTIVE_PDF_NAMES = new Set([
  "aa", "embeddedfile", "importdata", "javascript", "js", "launch", "openaction", "richmedia", "submitform",
]);
const IMAGE_PIXEL_LIMIT = 25_000_000;

export type UploadInspection =
  | { valid: true; extension: string; mimeType: string }
  | { valid: false; code: "INVALID_FILENAME" | "INVALID_FILE_TYPE" | "INVALID_FILE_CONTENT" | "ACTIVE_CONTENT"; message: string };

function decodePathLike(value: string): string | null {
  let decoded = value;
  try {
    for (let index = 0; index < 3; index += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    return decoded;
  } catch {
    return null;
  }
}

function safeOriginalFilename(originalName: string): string | null {
  const trimmed = String(originalName || "").normalize("NFKC").trim();
  const decoded = decodePathLike(trimmed);
  if (!decoded || decoded.includes("\0") || /[\\/]/.test(decoded)) return null;
  if (path.posix.basename(decoded) !== decoded || path.win32.basename(decoded) !== decoded) return null;
  return decoded;
}

function detectedMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 5).toString("ascii") === "%PDF-" && buffer.subarray(Math.max(0, buffer.length - 2048)).includes(Buffer.from("%%EOF"))) {
    return "application/pdf";
  }
  return null;
}

async function isDecodableImage(buffer: Buffer, mimeType: string): Promise<boolean> {
  const expectedFormat = mimeType === "image/jpeg" ? "jpeg" : mimeType.slice("image/".length);
  try {
    const image = sharp(buffer, { failOn: "error", limitInputPixels: IMAGE_PIXEL_LIMIT, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) return false;
    if (metadata.width * metadata.height > IMAGE_PIXEL_LIMIT || Number(metadata.pages || 1) !== 1) return false;
    await image.clone().raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

function pdfContainsActiveObjects(document: PDFDocument): boolean {
  const visited = new Set<object>();
  const inspect = (object: any): boolean => {
    if (!object || typeof object !== "object" || visited.has(object)) return false;
    visited.add(object);
    if (object instanceof PDFName) return ACTIVE_PDF_NAMES.has(object.decodeText().replace(/^\//, "").toLowerCase());
    if (object instanceof PDFRef) return inspect(document.context.lookup(object));
    if (object instanceof PDFStream) return inspect(object.dict);
    if (object instanceof PDFDict) {
      return object.entries().some(([key, value]) => inspect(key) || inspect(value));
    }
    if (object instanceof PDFArray) {
      for (let index = 0; index < object.size(); index += 1) if (inspect(object.get(index))) return true;
    }
    return false;
  };
  return document.context.enumerateIndirectObjects().some(([, object]) => inspect(object));
}

async function inspectPdf(buffer: Buffer): Promise<"safe" | "active" | "invalid"> {
  try {
    const document = await PDFDocument.load(buffer, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (document.isEncrypted || document.getPageCount() < 1) return "invalid";
    return pdfContainsActiveObjects(document) ? "active" : "safe";
  } catch {
    return "invalid";
  }
}

export async function inspectUpload(
  originalName: string,
  declaredMime: string,
  buffer: Buffer,
  allowedMimes: readonly string[],
): Promise<UploadInspection> {
  const filename = safeOriginalFilename(originalName);
  if (!filename) {
    return { valid: false, code: "INVALID_FILENAME", message: "Dosya adı klasör veya geçersiz path bileşeni içeremez." };
  }

  const normalizedMime = String(declaredMime || "").toLowerCase();
  const extension = path.extname(filename).toLowerCase();
  const allowedExtensions = MIME_EXTENSIONS[normalizedMime];
  if (!allowedMimes.includes(normalizedMime) || !allowedExtensions?.includes(extension)) {
    return { valid: false, code: "INVALID_FILE_TYPE", message: "Dosya uzantısı ve bildirilen MIME tipi izin verilen türle eşleşmiyor." };
  }

  const actualMime = detectedMime(buffer);
  if (actualMime !== normalizedMime) {
    return { valid: false, code: "INVALID_FILE_CONTENT", message: "Dosya içeriği bildirilen MIME tipiyle eşleşmiyor." };
  }

  if (actualMime === "application/pdf") {
    const pdfState = await inspectPdf(buffer);
    if (pdfState === "active") {
      return { valid: false, code: "ACTIVE_CONTENT", message: "Aktif içerik veya gömülü dosya içeren PDF kabul edilmez." };
    }
    if (pdfState === "invalid") {
      return { valid: false, code: "INVALID_FILE_CONTENT", message: "PDF yapısı geçersiz veya okunamıyor." };
    }
  } else if (!(await isDecodableImage(buffer, actualMime))) {
    return { valid: false, code: "INVALID_FILE_CONTENT", message: "Görsel yapısı geçersiz veya decode edilemiyor." };
  }

  return { valid: true, extension: CANONICAL_EXTENSION[actualMime], mimeType: actualMime };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOwnedDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Upload root must be a real directory");
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error("Upload root or one of its parents is a symlink");
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid()) throw new Error("Upload root is not owned by the server user");
  return real;
}

export function ensureOwnedUploadRoot(uploadsDir: string): string {
  const resolved = path.resolve(uploadsDir);
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("No existing upload-root parent");
    ancestor = parent;
  }
  assertOwnedDirectory(ancestor);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return assertOwnedDirectory(resolved);
}

function assertSafeFolder(folder: string): string[] {
  const normalized = String(folder || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || (segment !== ".quarantine" && !/^[A-Za-z0-9_-]+$/.test(segment)))) {
    throw new Error("Unsafe upload folder");
  }
  return segments;
}

export function ensureOwnedUploadDirectory(uploadsDir: string, folder: string): string {
  const root = ensureOwnedUploadRoot(uploadsDir);
  const segments = assertSafeFolder(folder);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Upload directory contains a symlink");
    const real = fs.realpathSync(current);
    if (real !== current || !isInside(root, real)) throw new Error("Upload directory escapes the server-owned root");
  }
  return current;
}

export async function persistUpload(options: {
  uploadsDir: string;
  folder: string;
  prefix?: string;
  originalName: string;
  declaredMime: string;
  buffer: Buffer;
  allowedMimes: readonly string[];
}): Promise<{ absolutePath: string; publicPath: string; mimeType: string; size: number }> {
  const inspection = await inspectUpload(options.originalName, options.declaredMime, options.buffer, options.allowedMimes);
  if ("code" in inspection) {
    const error = new Error(inspection.message) as Error & { code?: string; statusCode?: number };
    error.code = inspection.code;
    error.statusCode = 415;
    throw error;
  }

  const segments = assertSafeFolder(options.folder);
  const rootReal = ensureOwnedUploadRoot(options.uploadsDir);
  const directoryReal = ensureOwnedUploadDirectory(rootReal, segments.join("/"));

  const safePrefix = String(options.prefix || "file").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "file";
  const filename = `${safePrefix}-${crypto.randomUUID()}${inspection.extension}`;
  const absolutePath = path.join(directoryReal, filename);
  if (!isInside(rootReal, absolutePath)) throw new Error("Upload target escapes the server-owned root");
  fs.writeFileSync(absolutePath, options.buffer, { flag: "wx", mode: 0o600 });

  return {
    absolutePath,
    publicPath: `/uploads/${[...segments, filename].join("/")}`,
    mimeType: inspection.mimeType,
    size: options.buffer.length,
  };
}

export type StoredUploadRemoval =
  | { status: "deleted"; absolutePath: string }
  | { status: "cleanup_pending"; absolutePath: string }
  | { status: "missing"; absolutePath: string }
  | { status: "rejected"; reason: string };

export type StoredUploadResolution =
  | { status: "resolved"; absolutePath: string }
  | { status: "missing"; absolutePath: string }
  | { status: "rejected"; reason: string };

function storedRelativePath(storedPath: string): string | null {
  const decoded = decodePathLike(String(storedPath || "").normalize("NFKC").trim());
  if (!decoded || decoded.includes("\0") || decoded.includes("?") || decoded.includes("#")) return null;
  const normalized = decoded.replace(/\\/g, "/");
  const relative = normalized.startsWith("/uploads/")
    ? normalized.slice("/uploads/".length)
    : normalized.startsWith("uploads/")
      ? normalized.slice("uploads/".length)
      : null;
  if (!relative || path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) return null;
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join(path.sep);
}

export function resolveStoredUpload(uploadsDir: string, storedPath: string): StoredUploadResolution {
  const relative = storedRelativePath(storedPath);
  if (!relative) return { status: "rejected", reason: "invalid_stored_path" };

  let rootReal: string;
  try {
    rootReal = ensureOwnedUploadRoot(uploadsDir);
  } catch {
    return { status: "rejected", reason: "unsafe_upload_root" };
  }
  const candidate = path.resolve(rootReal, relative);
  if (!isInside(rootReal, candidate)) return { status: "rejected", reason: "path_escape" };

  let current = rootReal;
  const segments = path.relative(rootReal, candidate).split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error: any) {
      if (error?.code === "ENOENT") return { status: "missing", absolutePath: candidate };
      throw error;
    }
    if (stat.isSymbolicLink()) return { status: "rejected", reason: "symlink" };
    if (index < segments.length - 1 && !stat.isDirectory()) return { status: "rejected", reason: "invalid_parent" };
    if (index === segments.length - 1 && !stat.isFile()) return { status: "rejected", reason: "not_a_file" };
  }

  const candidateReal = fs.realpathSync(candidate);
  if (!isInside(rootReal, candidateReal)) return { status: "rejected", reason: "real_path_escape" };
  return { status: "resolved", absolutePath: candidate };
}

export function removeStoredUpload(uploadsDir: string, storedPath: string): StoredUploadRemoval {
  const resolved = resolveStoredUpload(uploadsDir, storedPath);
  if (resolved.status !== "resolved") return resolved;
  fs.unlinkSync(resolved.absolutePath);
  return { status: "deleted", absolutePath: resolved.absolutePath };
}

export function removeStoredUploadReference(
  uploadsDir: string,
  storedPath: string,
  deleteReference: () => void,
  operations: { rename?: typeof fs.renameSync; unlink?: typeof fs.unlinkSync } = {},
): StoredUploadRemoval {
  const resolved = resolveStoredUpload(uploadsDir, storedPath);
  if (resolved.status !== "resolved") {
    deleteReference();
    return resolved;
  }

  const root = ensureOwnedUploadRoot(uploadsDir);
  const quarantine = ensureOwnedUploadDirectory(root, ".quarantine");
  const quarantinedPath = path.join(quarantine, `${crypto.randomUUID()}.trash`);
  const rename = operations.rename || fs.renameSync;
  const unlink = operations.unlink || fs.unlinkSync;
  rename(resolved.absolutePath, quarantinedPath);
  try {
    deleteReference();
  } catch (error) {
    try {
      rename(quarantinedPath, resolved.absolutePath);
    } catch (rollbackError) {
      const failure = new Error("Database mutation failed and quarantined file restore failed", { cause: error }) as Error & { recoveryPath?: string; rollbackError?: unknown };
      failure.recoveryPath = quarantinedPath;
      failure.rollbackError = rollbackError;
      throw failure;
    }
    throw error;
  }
  try {
    unlink(quarantinedPath);
    return { status: "deleted", absolutePath: resolved.absolutePath };
  } catch {
    return { status: "cleanup_pending", absolutePath: quarantinedPath };
  }
}

export function finalizeStoredUploadCleanup(uploadsDir: string, quarantinedPath: string): "deleted" | "missing" | "rejected" {
  let root: string;
  let quarantine: string;
  try {
    root = ensureOwnedUploadRoot(uploadsDir);
    quarantine = ensureOwnedUploadDirectory(root, ".quarantine");
  } catch {
    return "rejected";
  }
  const candidate = path.resolve(String(quarantinedPath || ""));
  if (path.dirname(candidate) !== quarantine || !isInside(root, candidate)) return "rejected";
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) return "rejected";
    fs.unlinkSync(candidate);
    return "deleted";
  } catch (error: any) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

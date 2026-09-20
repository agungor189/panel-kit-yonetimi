import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

const ACTIVE_PDF_MARKER = /\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile)\b/i;

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

export function inspectUpload(
  originalName: string,
  declaredMime: string,
  buffer: Buffer,
  allowedMimes: readonly string[],
): UploadInspection {
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

  if (actualMime === "application/pdf" && ACTIVE_PDF_MARKER.test(buffer.toString("latin1"))) {
    return { valid: false, code: "ACTIVE_CONTENT", message: "Aktif içerik veya gömülü dosya içeren PDF kabul edilmez." };
  }

  return { valid: true, extension: CANONICAL_EXTENSION[actualMime], mimeType: actualMime };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeFolder(folder: string): string[] {
  const normalized = String(folder || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error("Unsafe upload folder");
  }
  return segments;
}

export function persistUpload(options: {
  uploadsDir: string;
  folder: string;
  prefix?: string;
  originalName: string;
  declaredMime: string;
  buffer: Buffer;
  allowedMimes: readonly string[];
}): { absolutePath: string; publicPath: string; mimeType: string; size: number } {
  const inspection = inspectUpload(options.originalName, options.declaredMime, options.buffer, options.allowedMimes);
  if ("code" in inspection) {
    const error = new Error(inspection.message) as Error & { code?: string; statusCode?: number };
    error.code = inspection.code;
    error.statusCode = 415;
    throw error;
  }

  const root = path.resolve(options.uploadsDir);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const segments = assertSafeFolder(options.folder);
  const directory = path.resolve(root, ...segments);
  fs.mkdirSync(directory, { recursive: true });
  const directoryReal = fs.realpathSync(directory);
  if (!isInside(rootReal, directoryReal)) throw new Error("Upload directory escapes the server-owned root");

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

  const root = path.resolve(uploadsDir);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) return { status: "rejected", reason: "path_escape" };

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { status: "missing", absolutePath: candidate };
    throw error;
  }
  if (stat.isSymbolicLink()) return { status: "rejected", reason: "symlink" };
  if (!stat.isFile()) return { status: "rejected", reason: "not_a_file" };

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
): StoredUploadRemoval {
  const result = removeStoredUpload(uploadsDir, storedPath);
  deleteReference();
  return result;
}

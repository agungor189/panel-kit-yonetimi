import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ensureOwnedUploadDirectory, inspectUpload, removeStoredUpload, resolveStoredUpload } from "./uploadSecurity.js";

export const PRODUCT_IMAGE_MAX_FILE_SIZE = 8 * 1024 * 1024;
export { PRODUCT_IMAGE_SERVER_BATCH_LIMIT as PRODUCT_IMAGE_MAX_FILES } from "../../shared/productImageBatch";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export type ProductImageFileInspection =
  | { valid: true; sku: string; extension: string }
  | { valid: false; code: "INVALID_FILENAME" | "INVALID_FILE_TYPE"; message: string };

export type StagedProductImage = {
  originalname: string;
  mimetype: string;
  path: string;
};

export type ProductImageImportResult = {
  original_filename: string;
  sku: string;
  matched_sku?: string;
  status: "uploaded" | "skipped";
  code: string;
  message: string;
  image_path?: string;
};

export type ProductImageImportReport = {
  total: number;
  uploaded: number;
  skipped: number;
  results: ProductImageImportResult[];
};

export function inspectProductImageFile(originalName: string, mimeType: string): ProductImageFileInspection {
  const trimmedName = String(originalName || "").trim();
  const baseName = path.basename(trimmedName);
  if (!trimmedName || baseName !== trimmedName || /[\\/]/.test(trimmedName)) {
    return { valid: false, code: "INVALID_FILENAME", message: "Dosya adı geçersiz veya klasör yolu içeriyor." };
  }

  const extension = path.extname(baseName).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION[extension];
  if (!expectedMime || mimeType !== expectedMime) {
    return {
      valid: false,
      code: "INVALID_FILE_TYPE",
      message: "Yalnızca uzantısı ve MIME tipi uyumlu PNG, JPG, JPEG ve WEBP dosyaları kabul edilir.",
    };
  }

  const sku = baseName.slice(0, -extension.length).trim();
  if (!sku || sku === "." || sku === "..") {
    return { valid: false, code: "INVALID_FILENAME", message: "Dosya adı geçerli bir SKU içermiyor." };
  }
  return { valid: true, sku, extension };
}

export function sanitizeSkuFilename(sku: string): string {
  const sanitized = String(sku || "")
    .normalize("NFKC")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .replace(/_+/g, "_")
    .slice(0, 180);
  return sanitized || "product";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function ensureProductImageDirectory(uploadsDir: string): string {
  return ensureOwnedUploadDirectory(uploadsDir, "products");
}

function safeStagedPath(productsDir: string, stagedPath: string): string | null {
  const root = path.resolve(productsDir);
  const candidate = path.resolve(String(stagedPath || ""));
  try {
    const rootReal = fs.realpathSync(root);
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const candidateReal = fs.realpathSync(candidate);
    return isInside(rootReal, candidateReal) ? candidateReal : null;
  } catch {
    return null;
  }
}

function removeFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Cleanup failures should not hide the import result.
  }
}

export function cleanupStagedProductImages(uploadsDir: string, files: readonly StagedProductImage[]): void {
  let productsDir: string;
  try {
    productsDir = ensureProductImageDirectory(uploadsDir);
  } catch {
    return;
  }
  for (const file of files) {
    const safePath = safeStagedPath(productsDir, file.path);
    if (safePath) removeFile(safePath);
  }
}

export async function importProductImages(
  db: Database.Database,
  uploadsDir: string,
  files: readonly StagedProductImage[],
): Promise<ProductImageImportReport> {
  const productsDir = ensureProductImageDirectory(uploadsDir);

  const findProduct = db.prepare(`
    SELECT id, sku
    FROM products
    WHERE sku = ? COLLATE NOCASE
    LIMIT 2
  `);
  const existingImages = db.prepare("SELECT id, path FROM product_images WHERE product_id = ?");
  const deleteImages = db.prepare("DELETE FROM product_images WHERE product_id = ?");
  const insertImage = db.prepare(`
    INSERT INTO product_images (id, product_id, path, sort_order)
    VALUES (?, ?, ?, 0)
  `);

  const seenProductIds = new Set<string>();
  const results: ProductImageImportResult[] = [];

  for (const file of files) {
    const stagedPath = safeStagedPath(productsDir, file.path);
    if (!stagedPath) {
      results.push({
        original_filename: file.originalname,
        sku: "",
        status: "skipped",
        code: "UNSAFE_STAGED_PATH",
        message: "Yüklenen geçici dosya server-owned upload alanında değil.",
      });
      continue;
    }
    const inspection = inspectProductImageFile(file.originalname, file.mimetype);
    if ("message" in inspection) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: "",
        status: "skipped",
        code: inspection.code,
        message: inspection.message,
      });
      continue;
    }

    const contentInspection = await inspectUpload(
      file.originalname,
      file.mimetype,
      fs.readFileSync(stagedPath),
      ["image/jpeg", "image/png", "image/webp"],
    );
    if ("code" in contentInspection) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        status: "skipped",
        code: contentInspection.code,
        message: contentInspection.message,
      });
      continue;
    }

    const matches = findProduct.all(inspection.sku) as Array<{ id: string; sku: string }>;
    if (matches.length === 0) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        status: "skipped",
        code: "PRODUCT_NOT_FOUND",
        message: "Ürün bulunamadı.",
      });
      continue;
    }
    if (matches.length > 1) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        status: "skipped",
        code: "AMBIGUOUS_SKU",
        message: "SKU büyük/küçük harf farkıyla birden fazla ürüne eşleşiyor.",
      });
      continue;
    }

    const product = matches[0];
    if (seenProductIds.has(product.id)) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        matched_sku: product.sku,
        status: "skipped",
        code: "DUPLICATE_SKU_IN_BATCH",
        message: "Bu SKU için aynı yüklemede zaten bir görsel işlendi.",
      });
      continue;
    }
    seenProductIds.add(product.id);

    const targetName = `${sanitizeSkuFilename(product.sku)}${inspection.extension}`;
    const targetPath = path.resolve(productsDir, targetName);
    if (!isInside(productsDir, targetPath)) {
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        matched_sku: product.sku,
        status: "skipped",
        code: "UNSAFE_TARGET_PATH",
        message: "Güvenli hedef dosya yolu oluşturulamadı.",
      });
      continue;
    }

    const publicPath = `/uploads/products/${targetName}`;
    const oldImages = existingImages.all(product.id) as Array<{ id: string; path: string }>;
    const backupPath = fs.existsSync(targetPath) ? `${targetPath}.backup-${crypto.randomUUID()}` : null;

    try {
      if (backupPath) fs.renameSync(targetPath, backupPath);
      fs.renameSync(stagedPath, targetPath);

      db.transaction(() => {
        deleteImages.run(product.id);
        insertImage.run(crypto.randomUUID(), product.id, publicPath);
      })();

      if (backupPath) removeFile(backupPath);
      for (const oldImage of oldImages) {
        const oldPath = resolveStoredUpload(uploadsDir, oldImage.path);
        if (oldPath.status === "resolved" && path.resolve(oldPath.absolutePath) !== targetPath) {
          removeStoredUpload(uploadsDir, oldImage.path);
        }
      }

      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        matched_sku: product.sku,
        status: "uploaded",
        code: oldImages.length > 0 ? "IMAGE_REPLACED" : "IMAGE_CREATED",
        message: oldImages.length > 0 ? "Mevcut görsel değiştirildi." : "Görsel yüklendi.",
        image_path: publicPath,
      });
    } catch (error: any) {
      removeFile(targetPath);
      if (backupPath && fs.existsSync(backupPath)) fs.renameSync(backupPath, targetPath);
      removeFile(stagedPath);
      results.push({
        original_filename: file.originalname,
        sku: inspection.sku,
        matched_sku: product.sku,
        status: "skipped",
        code: "UPLOAD_FAILED",
        message: error?.message || "Görsel yüklenemedi.",
      });
    }
  }

  const uploaded = results.filter((result) => result.status === "uploaded").length;
  return { total: files.length, uploaded, skipped: files.length - uploaded, results };
}

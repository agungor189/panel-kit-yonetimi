import fs from "fs";
import path from "path";

type ZipEntryLike = {
  entryName: string;
  isDirectory: boolean;
  getData: () => Buffer;
};

export function getSafeUploadsRestorePath(entryName: string, cwd = process.cwd()): string | null {
  if (!entryName.startsWith("uploads/")) return null;

  const uploadsRoot = path.resolve(cwd, "uploads");
  const destPath = path.resolve(cwd, entryName);

  if (!destPath.startsWith(`${uploadsRoot}${path.sep}`)) {
    return null;
  }

  return destPath;
}

export function restoreUploadEntry(entry: ZipEntryLike, cwd = process.cwd()): boolean {
  if (entry.isDirectory) return false;

  const destPath = getSafeUploadsRestorePath(entry.entryName, cwd);
  if (!destPath) return false;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, entry.getData());
  return true;
}

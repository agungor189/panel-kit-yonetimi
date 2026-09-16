export const PRODUCT_IMAGE_CLIENT_BATCH_SIZE = 25;
export const PRODUCT_IMAGE_SERVER_BATCH_LIMIT = 50;

export function chunkItems<T>(items: readonly T[], size = PRODUCT_IMAGE_CLIENT_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("Batch size must be a positive integer");
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

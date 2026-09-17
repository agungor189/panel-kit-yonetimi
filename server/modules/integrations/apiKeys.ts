import crypto from "node:crypto";

export function createApiKeyHasher(secret: string) {
  if (!secret) throw new Error("Panel API hash secret is required.");
  return (clearKey: string) => crypto.createHmac("sha256", secret).update(clearKey).digest("hex");
}


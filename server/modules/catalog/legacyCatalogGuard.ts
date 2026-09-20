import type { RequestHandler } from "express";

const blockedPostPaths = new Set(["/", "/import", "/bulk-import"]);

/**
 * Legacy product endpoints cannot safely create catalog snapshots or command
 * audit records. Canonical identity writes are available only through
 * /api/catalog-admin/v1/products.
 */
export const rejectLegacyCatalogMutation: RequestHandler = (req, res, next) => {
  const path = req.path || "/";
  const productIdentityPath = path === "/" || /^\/[^/]+$/.test(path);
  const blocked = (req.method === "POST" && blockedPostPaths.has(path))
    || (["PUT", "PATCH", "DELETE"].includes(req.method) && productIdentityPath);
  if (!blocked) return next();
  return res.status(409).json({
    success: false,
    error: {
      code: "CANONICAL_CATALOG_COMMAND_REQUIRED",
      message: "Catalog identity mutations must use /api/catalog-admin/v1/products with an operation identity.",
    },
  });
};

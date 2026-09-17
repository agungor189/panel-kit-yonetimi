export const validUserRoles = new Set(["admin", "user", "readonly"]);

const appPermissionKeys = new Set([
  "warehouse:receive", "warehouse:print_labels", "warehouse:place_packages", "warehouse:move_stock",
  "warehouse:manage_locations", "warehouse:count_stock", "warehouse:edit_label_templates",
  "warehouse:view_map", "warehouse:view_analytics",
  "labels:view", "labels:edit", "labels:admin",
]);

export function parseUserPermissions(permissions: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(permissions || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function sanitizePermissions(value: unknown, fallback: Record<string, unknown> = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const result = { ...fallback };
  for (const key of appPermissionKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key] === true;
  }
  return result;
}


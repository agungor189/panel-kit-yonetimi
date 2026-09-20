export const validUserRoles = new Set(["admin", "user", "readonly"]);

const appPermissionKeys = new Set([
  "panel:read", "panel:write", "identity:admin", "integrations:admin", "backup:admin",
  "warehouse:pick_orders", "warehouse:receive", "warehouse:manage_receiving_sessions",
  "warehouse:print_labels", "warehouse:place_packages", "warehouse:move_stock",
  "warehouse:manage_locations", "warehouse:count_stock", "warehouse:edit_label_templates",
  "warehouse:view_map", "warehouse:view_analytics",
  "labels:view", "labels:edit", "labels:admin",
  "kits:view", "kits:write", "kits:approve",
]);

export function userHasCapability(
  user: { role: string; permissions: Record<string, unknown> },
  capability: string,
): boolean {
  if (user.role === "admin") return true;
  if (user.permissions?.[capability] === true) return true;
  if (capability === "panel:read") return user.role === "user" || user.role === "readonly";
  if (capability === "panel:write") return user.role === "user";
  return false;
}

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

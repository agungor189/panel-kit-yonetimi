export const validUserRoles = new Set(["admin", "user", "readonly"]);

export const CAPABILITY_REGISTRY = Object.freeze({
  "panel:read": { description: "Panel query access" },
  "panel:write": { description: "Panel mutation access" },
  "identity:admin": { description: "Human identity administration" },
  "integrations:admin": { description: "Connector and service-principal administration" },
  "backup:admin": { description: "Backup and restore administration" },
  "catalog:admin": { description: "Destructive catalog administration" },
  "settings:admin": { description: "System settings administration" },
  "maintenance:admin": { description: "Explicit maintenance operations" },
  "finance:write": { description: "Manual expense and cash mutations" },
  "warehouse:pick_orders": { description: "Warehouse order picking" },
  "warehouse:receive": { description: "Warehouse receiving" },
  "warehouse:manage_receiving_sessions": { description: "Warehouse receiving-session administration" },
  "warehouse:print_labels": { description: "Warehouse label rendering and print intent" },
  "warehouse:place_packages": { description: "Warehouse package placement" },
  "warehouse:move_stock": { description: "Warehouse internal movement" },
  "warehouse:manage_locations": { description: "Warehouse location administration" },
  "warehouse:count_stock": { description: "Warehouse stock counts" },
  "warehouse:edit_label_templates": { description: "Warehouse label-template administration" },
  "warehouse:view_map": { description: "Warehouse map queries" },
  "warehouse:view_analytics": { description: "Warehouse analytics queries" },
  "labels:view": { description: "Label template queries" },
  "labels:edit": { description: "Label template mutations" },
  "labels:admin": { description: "Label administration" },
  "kits:view": { description: "Kit workspace queries" },
  "kits:write": { description: "Kit workspace mutations" },
  "kits:approve": { description: "Kit approval" },
} as const);

const appPermissionKeys = new Set<string>(Object.keys(CAPABILITY_REGISTRY));

export function userHasCapability(
  user: { role: string; permissions: Record<string, unknown> },
  capability: string,
): boolean {
  if (!appPermissionKeys.has(capability)) return false;
  if (user.role === "admin") return true;
  return user.permissions?.[capability] === true;
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

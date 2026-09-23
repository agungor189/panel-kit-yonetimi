export const validUserRoles = new Set(["admin", "user", "readonly"]);

export const CAPABILITY_REGISTRY = Object.freeze({
  "panel:read": { description: "Panel query access" },
  "panel:write": { description: "Panel mutation access" },
  "identity:admin": { description: "Human identity administration" },
  "integrations:admin": { description: "Connector and service-principal administration" },
  "backup:admin": { description: "Backup and restore administration" },
  "catalog:admin": { description: "Destructive catalog administration" },
  "catalog:write": { description: "Versioned catalog maintenance" },
  "settings:admin": { description: "System settings administration" },
  "maintenance:admin": { description: "Explicit maintenance operations" },
  "finance:write": { description: "Manual expense and cash mutations" },
  "returns:create": { description: "Create an approved post-dispatch return request" },
  "returns:approve_refund": { description: "Explicitly approve and post a return refund" },
  "warehouse:accept_returns": { description: "Physically inspect and disposition approved returns" },
  "fx:write": { description: "Current FX observation administration" },
  "procurement:write": { description: "Supplier and purchase-order maintenance" },
  "acquisition-cost:approve": { description: "Immutable acquisition-cost finalization" },
  "inventory:receive": { description: "Approved goods receipt inventory posting" },
  "inventory:reserve": { description: "Order inventory reservation" },
  "inventory:release": { description: "Reservation cancellation and release" },
  "inventory:correct": { description: "Approved inventory count correction" },
  "shipping:dispatch": { description: "Approved shipment dispatch inventory posting" },
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

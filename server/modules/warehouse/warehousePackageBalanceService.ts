import type Database from "better-sqlite3";

export class WarehousePackageBalanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WarehousePackageBalanceError";
  }
}

export class WarehousePackageBalanceService {
  constructor(private readonly db: Database.Database) {}

  consumePicking(input: { lotId: string; locationId: string; quantityBaseInt: number; occurredAt: string }): void {
    const warehouseManaged = this.db.prepare(`SELECT 1 FROM warehouse_execution_packages
      WHERE inventory_lot_id=? AND disposition='ACCEPTED' LIMIT 1`).get(input.lotId);
    if (!warehouseManaged) return;

    const packages = this.db.prepare(`SELECT id,remaining_quantity_base_int FROM warehouse_execution_packages
      WHERE inventory_lot_id=? AND current_slot_id=? AND disposition='ACCEPTED' AND status='PICKING'
        AND remaining_quantity_base_int>0
      ORDER BY datetime(created_at),created_at,id`).all(input.lotId, input.locationId) as Array<{
        id: string;
        remaining_quantity_base_int: number;
      }>;
    const available = packages.reduce((sum, pkg) => sum + Number(pkg.remaining_quantity_base_int), 0);
    if (available < input.quantityBaseInt) {
      throw new WarehousePackageBalanceError(
        "WAREHOUSE_PACKAGE_BALANCE_CONFLICT",
        "Picking warehouse packages cannot satisfy dispatch without breaking package reconciliation.",
      );
    }

    let remaining = input.quantityBaseInt;
    const decrement = this.db.prepare(`UPDATE warehouse_execution_packages
      SET remaining_quantity_base_int=remaining_quantity_base_int-?,updated_at=?
      WHERE id=? AND remaining_quantity_base_int>=?`);
    for (const pkg of packages) {
      if (remaining === 0) break;
      const take = Math.min(remaining, Number(pkg.remaining_quantity_base_int));
      const changed = decrement.run(take, input.occurredAt, pkg.id, take);
      if (changed.changes !== 1) {
        throw new WarehousePackageBalanceError(
          "WAREHOUSE_PACKAGE_BALANCE_CONFLICT",
          "Picking warehouse package balance changed during dispatch.",
        );
      }
      remaining -= take;
    }
  }
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export class WarehousePackageBalanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WarehousePackageBalanceError";
  }
}

export type ReplenishmentState = "HEALTHY" | "LOW_WATCH" | "PREPARE_REPLENISHMENT" | "CRITICAL_NO_RESERVE" | "STOCK_DISCREPANCY";

export type ReplenishmentEvaluation = {
  id?: string;
  state: ReplenishmentState;
  productId: string;
  lotId: string;
  pickPackageId: string;
  sourcePackageId: string | null;
  currentPct: number;
};

type PickPackageRow = {
  id: string;
  product_id: string;
  inventory_lot_id: string;
  current_slot_id: string;
  remaining_quantity_base_int: number;
  target_quantity_base_int: number;
};

const OPEN_TASK_STATES = "'LOW_WATCH','PREPARE_REPLENISHMENT','CRITICAL_NO_RESERVE','STOCK_DISCREPANCY'";

export class WarehousePackageBalanceService {
  constructor(private readonly db: Database.Database) {}

  consumeSpecificPicking(input: { packageId: string; lotId: string; locationId: string; quantityBaseInt: number; occurredAt: string; operationId: string }) {
    const pkg = this.db.prepare(`SELECT id,product_id,inventory_lot_id,current_slot_id,
        remaining_quantity_base_int,target_quantity_base_int FROM warehouse_execution_packages
      WHERE id=? AND inventory_lot_id=? AND current_slot_id=? AND disposition='ACCEPTED' AND status='PICKING'`)
      .get(input.packageId, input.lotId, input.locationId) as PickPackageRow | undefined;
    if (!pkg || !Number.isSafeInteger(input.quantityBaseInt) || input.quantityBaseInt <= 0
      || Number(pkg.remaining_quantity_base_int) < input.quantityBaseInt) {
      throw new WarehousePackageBalanceError(
        "WAREHOUSE_PACKAGE_BALANCE_CONFLICT",
        "The proven source package cannot satisfy the physical profile consumption.",
      );
    }
    const changed = this.db.prepare(`UPDATE warehouse_execution_packages
      SET remaining_quantity_base_int=remaining_quantity_base_int-?,updated_at=?
      WHERE id=? AND remaining_quantity_base_int>=?`).run(
        input.quantityBaseInt, input.occurredAt, pkg.id, input.quantityBaseInt,
      );
    if (changed.changes !== 1) throw new WarehousePackageBalanceError("WAREHOUSE_PACKAGE_BALANCE_CONFLICT", "Source package changed during profile cutting.");
    const currentQuantity = Number(pkg.remaining_quantity_base_int) - input.quantityBaseInt;
    const evaluation = this.evaluatePickPackage({ ...pkg, remaining_quantity_base_int: currentQuantity }, `${input.operationId}:replenishment:${pkg.id}`);
    if (currentQuantity === 0) {
      this.db.prepare(`UPDATE warehouse_execution_packages SET current_slot_id=NULL,updated_at=?
        WHERE id=? AND remaining_quantity_base_int=0`).run(input.occurredAt, pkg.id);
    }
    return evaluation;
  }

  consumePicking(input: { lotId: string; locationId: string; quantityBaseInt: number; occurredAt: string; operationId: string }): ReplenishmentEvaluation[] {
    const warehouseManaged = this.db.prepare(`SELECT 1 FROM warehouse_execution_packages
      WHERE inventory_lot_id=? AND disposition='ACCEPTED' LIMIT 1`).get(input.lotId);
    if (!warehouseManaged) return [];

    const packages = this.db.prepare(`SELECT id,product_id,inventory_lot_id,current_slot_id,
        remaining_quantity_base_int,target_quantity_base_int FROM warehouse_execution_packages
      WHERE inventory_lot_id=? AND current_slot_id=? AND disposition='ACCEPTED' AND status='PICKING'
        AND remaining_quantity_base_int>0
      ORDER BY datetime(created_at),created_at,id`).all(input.lotId, input.locationId) as PickPackageRow[];
    const available = packages.reduce((sum, pkg) => sum + Number(pkg.remaining_quantity_base_int), 0);
    if (available < input.quantityBaseInt) {
      throw new WarehousePackageBalanceError(
        "WAREHOUSE_PACKAGE_BALANCE_CONFLICT",
        "Picking warehouse packages cannot satisfy dispatch without breaking package reconciliation.",
      );
    }

    let remaining = input.quantityBaseInt;
    const results: ReplenishmentEvaluation[] = [];
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
      const currentQuantity = Number(pkg.remaining_quantity_base_int) - take;
      results.push(this.evaluatePickPackage({ ...pkg, remaining_quantity_base_int: currentQuantity }, `${input.operationId}:replenishment:${pkg.id}`));
      if (currentQuantity === 0) {
        this.db.prepare(`UPDATE warehouse_execution_packages SET current_slot_id=NULL,updated_at=?
          WHERE id=? AND remaining_quantity_base_int=0`).run(input.occurredAt, pkg.id);
      }
      remaining -= take;
    }
    return results;
  }

  evaluateProduct(productId: string, operationId: string): ReplenishmentEvaluation {
    const lot = this.db.prepare(`SELECT id FROM inventory_lots WHERE product_id=? AND on_hand_base_int>0
      ORDER BY datetime(received_at),received_at,id LIMIT 1`).get(productId) as { id: string } | undefined;
    if (!lot) throw new WarehousePackageBalanceError("STOCK_NOT_FOUND", "No on-hand FIFO lot exists for replenishment.");
    const pick = this.db.prepare(`SELECT p.id,p.product_id,p.inventory_lot_id,p.current_slot_id,
        p.remaining_quantity_base_int,p.target_quantity_base_int
      FROM warehouse_execution_packages p JOIN warehouse_location_slots s ON s.id=p.current_slot_id
      WHERE p.product_id=? AND p.inventory_lot_id=? AND p.status='PICKING' AND s.is_front=1
      ORDER BY (p.remaining_quantity_base_int>0) DESC,p.created_at,p.id LIMIT 1`).get(productId, lot.id) as PickPackageRow | undefined;
    if (!pick) throw new WarehousePackageBalanceError("MANDATORY_PICK_FACE_MISSING", "The FIFO lot has no accessible front pick face.");
    return this.evaluatePickPackage(pick, operationId);
  }

  private evaluatePickPackage(pick: PickPackageRow, operationId: string): ReplenishmentEvaluation {
    const settings = this.db.prepare(`SELECT watch_threshold_pct,prepare_threshold_pct
      FROM warehouse_execution_settings WHERE id='default'`).get() as { watch_threshold_pct: number; prepare_threshold_pct: number } | undefined;
    if (!settings) throw new WarehousePackageBalanceError("WAREHOUSE_SETTINGS_NOT_CONFIGURED", "Persisted warehouse execution settings are required.");
    const currentPct = Math.floor(Number(pick.remaining_quantity_base_int) * 100 / Number(pick.target_quantity_base_int));
    const base = { productId: pick.product_id, lotId: pick.inventory_lot_id, pickPackageId: pick.id, sourcePackageId: null, currentPct };
    if (currentPct > Number(settings.watch_threshold_pct)) return { state: "HEALTHY", ...base };

    let state: Exclude<ReplenishmentState, "HEALTHY"> = "LOW_WATCH";
    let sourcePackageId: string | null = null;
    let thresholdPct = Number(settings.watch_threshold_pct);
    if (currentPct <= Number(settings.prepare_threshold_pct)) {
      thresholdPct = Number(settings.prepare_threshold_pct);
      const canonicalReserve = Number(this.db.prepare(`SELECT COALESCE(SUM(quantity_base_int),0)
        FROM inventory_lot_location_balances
        WHERE lot_id=? AND location_kind='RESERVE' AND active=1 AND physical_state='CONFIRMED' AND quantity_base_int>0`)
        .pluck().get(pick.inventory_lot_id));
      if (canonicalReserve === 0) {
        state = "CRITICAL_NO_RESERVE";
      } else {
        const physical = this.db.prepare(`SELECT p.id,p.remaining_quantity_base_int,b.quantity_base_int AS location_quantity
          FROM warehouse_execution_packages p
          JOIN warehouse_location_slots s ON s.id=p.current_slot_id
          JOIN inventory_lot_location_balances b ON b.lot_id=p.inventory_lot_id AND b.location_id=p.current_slot_id
            AND b.location_kind='RESERVE' AND b.active=1 AND b.physical_state='CONFIRMED'
          WHERE p.inventory_lot_id=? AND p.product_id=? AND p.disposition='ACCEPTED' AND p.status='RESERVE'
            AND p.remaining_quantity_base_int>0 AND (s.is_front=0 OR s.role='RESERVE')
          ORDER BY datetime(p.created_at),p.created_at,p.id`).all(pick.inventory_lot_id, pick.product_id) as Array<{
            id: string;
            remaining_quantity_base_int: number;
            location_quantity: number;
          }>;
        const physicalReserve = physical.reduce((sum, pkg) => sum + Number(pkg.remaining_quantity_base_int), 0);
        const reconciled = physicalReserve === canonicalReserve
          && physical.every((pkg) => Number(pkg.remaining_quantity_base_int) === Number(pkg.location_quantity));
        if (!reconciled || physical.length === 0) {
          state = "STOCK_DISCREPANCY";
          const existingDiscrepancy = this.db.prepare(`SELECT id FROM warehouse_stock_discrepancies_v2
            WHERE inventory_lot_id=? AND status<>'RESOLVED' AND reason='EXPECTED_SAME_LOT_RESERVE_NOT_FOUND' LIMIT 1`)
            .get(pick.inventory_lot_id);
          if (!existingDiscrepancy) {
            this.db.prepare(`INSERT INTO warehouse_stock_discrepancies_v2
              (id,operation_id,product_id,inventory_lot_id,package_id,location_id,reason,status)
              VALUES (?,?,?,?,?,?,?,'COUNT_REQUIRED')`).run(
                randomUUID(), `${operationId}:discrepancy`, pick.product_id, pick.inventory_lot_id, null,
                pick.current_slot_id, "EXPECTED_SAME_LOT_RESERVE_NOT_FOUND",
              );
          }
          this.db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(pick.inventory_lot_id);
        } else {
          state = "PREPARE_REPLENISHMENT";
          sourcePackageId = physical[0].id;
        }
      }
    }

    const existing = this.db.prepare(`SELECT id FROM warehouse_replenishment_tasks
      WHERE pick_package_id=? AND inventory_lot_id=? AND status IN (${OPEN_TASK_STATES}) LIMIT 1`)
      .get(pick.id, pick.inventory_lot_id) as { id: string } | undefined;
    const taskId = existing?.id ?? randomUUID();
    if (existing) {
      this.db.prepare(`UPDATE warehouse_replenishment_tasks
        SET source_package_id=?,target_slot_id=?,threshold_pct=?,current_pct=?,status=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(sourcePackageId, pick.current_slot_id, thresholdPct, currentPct, state, taskId);
    } else {
      this.db.prepare(`INSERT INTO warehouse_replenishment_tasks
        (id,operation_id,product_id,inventory_lot_id,pick_package_id,source_package_id,target_slot_id,threshold_pct,current_pct,status)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          taskId, operationId, pick.product_id, pick.inventory_lot_id, pick.id, sourcePackageId,
          pick.current_slot_id, thresholdPct, currentPct, state,
        );
    }
    return { id: taskId, state, ...base, sourcePackageId };
  }
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { WarehousePackageBalanceError, WarehousePackageBalanceService } from "../warehouse/warehousePackageBalanceService.js";
import { ProfileCutInventoryService, type ProfileCutPlanInput } from "./profileCutInventoryService.js";

type LocationKind = "PICKING" | "RESERVE";
type ReservationStatus = "ACTIVE" | "PICKED" | "PACKED" | "RELEASED" | "DISPATCHED" | "STOCK_DISCREPANCY";

export class InventoryValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "InventoryValidationError";
  }
}

const text = (value: unknown, field: string, max = 200) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return normalized;
};

const positiveInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new InventoryValidationError("INVALID_BASE_QUANTITY", `${field} must be a positive base-unit integer.`);
  }
  return Number(value);
};

const timestamp = (value: unknown, field: string) => {
  const normalized = text(value, field, 50);
  if (!Number.isFinite(new Date(normalized).getTime())) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", `${field} must be an ISO timestamp.`);
  return normalized;
};

export class InventoryService {
  constructor(private readonly db: Database.Database) {}

  private syncProjection(productId: string) {
    this.db.prepare(`UPDATE products SET central_stock=COALESCE((
      SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id=?
    ),0), updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(productId, productId);
  }

  receiveCostedLot(input: {
    receiptId: string;
    costSnapshotId: string;
    receivedAt: string;
    location: { id: string; kind: LocationKind };
    operationId: string;
    acceptedQuantityBaseInt?: number;
    lotId?: string;
  }) {
    const receiptId = text(input.receiptId, "receiptId");
    const costSnapshotId = text(input.costSnapshotId, "costSnapshotId");
    const operationId = text(input.operationId, "operationId");
    const receivedAt = timestamp(input.receivedAt, "receivedAt");
    const locationId = text(input.location?.id, "location.id");
    if (!(["PICKING", "RESERVE"] as const).includes(input.location?.kind)) {
      throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "location.kind must be PICKING or RESERVE.");
    }
    return this.db.transaction(() => {
      const snapshot = this.db.prepare(`SELECT l.id,l.purchase_order_id,l.purchase_line_id,l.product_id,l.state,
        l.quantity_base_int,l.base_uom_code_snapshot,p.status AS purchase_status
        FROM acquisition_lot_cost_snapshots l JOIN purchase_orders p ON p.id=l.purchase_order_id WHERE l.id=?`).get(costSnapshotId) as any;
      if (!snapshot) throw new InventoryValidationError("COST_SNAPSHOT_NOT_FOUND", "The acquisition-cost snapshot was not found.", 404);
      if (snapshot.state !== "COSTED_PENDING_RECEIPT" || snapshot.purchase_status !== "APPROVED") {
        throw new InventoryValidationError("COST_SNAPSHOT_NOT_RECEIVABLE", "Only an approved COSTED_PENDING_RECEIPT snapshot may create inventory.", 409);
      }
      const quantity = input.acceptedQuantityBaseInt === undefined
        ? Number(snapshot.quantity_base_int)
        : positiveInteger(input.acceptedQuantityBaseInt, "acceptedQuantityBaseInt");
      const lotId = input.lotId ? text(input.lotId, "lotId") : `inventory-lot:${receiptId}`;
      this.db.prepare(`INSERT INTO inventory_lots (
        id,receipt_id,acquisition_cost_snapshot_id,purchase_order_id,purchase_line_id,product_id,
        base_uom_code_snapshot,received_quantity_base_int,on_hand_base_int,reserved_base_int,status,
        received_at,receipt_operation_id,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,0,'USABLE',?,?,?)`).run(
        lotId, receiptId, snapshot.id, snapshot.purchase_order_id, snapshot.purchase_line_id,
        snapshot.product_id, snapshot.base_uom_code_snapshot, quantity,
        quantity, receivedAt, operationId, receivedAt,
      );
      this.db.prepare(`INSERT INTO inventory_lot_location_balances
        (id,lot_id,location_id,location_kind,quantity_base_int,active,physical_state,updated_at)
        VALUES (?,?,?,?,?,1,'CONFIRMED',?)`).run(randomUUID(), lotId, locationId, input.location.kind, quantity, receivedAt);
      this.db.prepare(`INSERT INTO inventory_ledger_events (
        id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,
        reason_code,reference_type,reference_id,occurred_at
      ) VALUES (?,?,'RECEIPT',?,?,?,?, 'APPROVED_GOODS_RECEIPT','goods_receipt',?,?)`).run(
        randomUUID(), operationId, snapshot.product_id, lotId, quantity,
        snapshot.base_uom_code_snapshot, receiptId, receivedAt,
      );
      new ProfileCutInventoryService(this.db).createReceiptPieces(lotId, operationId);
      this.syncProjection(snapshot.product_id);
      return {
        lot: {
          id: lotId,
          receiptId,
          costSnapshotId,
          productId: snapshot.product_id,
          baseUomCode: snapshot.base_uom_code_snapshot,
          receivedQuantityBaseInt: quantity,
          onHandBaseInt: quantity,
          reservedBaseInt: 0,
          receivedAt,
          status: "USABLE" as const,
        },
        availability: this.getProductAvailability(snapshot.product_id),
      };
    }).immediate();
  }

  getProductAvailability(productIdValue: string) {
    const productId = text(productIdValue, "productId");
    const product = this.db.prepare("SELECT id,base_uom_code FROM products WHERE id=?").get(productId) as any;
    if (!product) throw new InventoryValidationError("PRODUCT_NOT_FOUND", "Product was not found.", 404);
    const balance = this.db.prepare(`SELECT COALESCE(SUM(on_hand_base_int),0) AS on_hand,
      COALESCE(SUM(reserved_base_int),0) AS reserved FROM inventory_lots WHERE product_id=?`).get(productId) as any;
    return {
      productId,
      baseUomCode: product.base_uom_code,
      onHandBaseInt: Number(balance.on_hand),
      reservedBaseInt: Number(balance.reserved),
      availableBaseInt: Number(balance.on_hand) - Number(balance.reserved),
    };
  }

  getProductReconciliation(productIdValue: string) {
    const availability = this.getProductAvailability(productIdValue);
    const ledgerOnHandBaseInt = Number(this.db.prepare(`SELECT COALESCE(SUM(quantity_delta_base_int),0)
      FROM inventory_ledger_events WHERE product_id=?`).pluck().get(availability.productId));
    const locationOnHandBaseInt = Number(this.db.prepare(`SELECT COALESCE(SUM(b.quantity_base_int),0)
      FROM inventory_lot_location_balances b JOIN inventory_lots l ON l.id=b.lot_id WHERE l.product_id=?`).pluck().get(availability.productId));
    const centralStockProjectionBaseInt = Number(this.db.prepare("SELECT central_stock FROM products WHERE id=?").pluck().get(availability.productId));
    return {
      ...availability,
      ledgerOnHandBaseInt,
      locationOnHandBaseInt,
      centralStockProjectionBaseInt,
      reconciled: ledgerOnHandBaseInt === availability.onHandBaseInt
        && locationOnHandBaseInt === availability.onHandBaseInt
        && centralStockProjectionBaseInt === availability.onHandBaseInt,
    };
  }

  reserveOrder(input: {
    reservationId: string;
    orderId: string;
    lines: Array<{ productId: string; quantityBaseInt: number }>;
    profileCutPlans?: ProfileCutPlanInput[];
    operationId: string;
    createdAt?: string;
  }) {
    const reservationId = text(input.reservationId, "reservationId");
    const orderId = text(input.orderId, "orderId");
    const operationId = text(input.operationId, "operationId");
    const createdAt = input.createdAt ? timestamp(input.createdAt, "createdAt") : new Date().toISOString();
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "At least one reservation line is required.");
    const lines = input.lines.map((line) => ({ productId: text(line.productId, "lines.productId"), quantityBaseInt: positiveInteger(line.quantityBaseInt, "lines.quantityBaseInt") }));
    if (new Set(lines.map(({ productId }) => productId)).size !== lines.length) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "Reservation product lines must be unique.");
    return this.db.transaction(() => {
      const profileCutInventory = new ProfileCutInventoryService(this.db);
      const physicalPlans = [] as ReturnType<ProfileCutInventoryService["plan"]>;
      const excludedPieceIds = new Set<string>();
      for (const cutPlan of input.profileCutPlans || []) {
        const planned = profileCutInventory.plan(cutPlan, excludedPieceIds);
        planned.forEach((piece) => excludedPieceIds.add(piece.pieceId));
        physicalPlans.push(...planned);
      }
      const physicalQuantityByProduct = new Map<string, number>();
      for (const plan of physicalPlans) physicalQuantityByProduct.set(plan.productId, (physicalQuantityByProduct.get(plan.productId) || 0) + plan.consumedLengthMm);
      for (const [productId, quantity] of physicalQuantityByProduct) {
        if (lines.find((line) => line.productId === productId)?.quantityBaseInt !== quantity) {
          throw new InventoryValidationError("PROFILE_CUT_PLAN_MISMATCH", `Profile cut plan quantity does not match reservation quantity for ${productId}.`, 409);
        }
      }
      const plans = lines.map((line) => {
        const product = this.db.prepare("SELECT id,base_uom_code FROM products WHERE id=?").get(line.productId) as any;
        if (!product) throw new InventoryValidationError("PRODUCT_NOT_FOUND", `Product ${line.productId} was not found.`, 404);
        const discrepancy = this.db.prepare("SELECT id FROM inventory_lots WHERE product_id=? AND status='STOCK_DISCREPANCY' AND on_hand_base_int>0 ORDER BY received_at,id LIMIT 1").get(line.productId) as any;
        if (discrepancy) throw new InventoryValidationError("STOCK_DISCREPANCY", `Product ${line.productId} has unresolved physical stock discrepancy.`, 409);
        const physical = physicalPlans.filter((piece) => piece.productId === line.productId);
        if (physical.length > 0) {
          const byLot = new Map<string, number>();
          for (const piece of physical) byLot.set(piece.lotId, (byLot.get(piece.lotId) || 0) + piece.consumedLengthMm);
          const allocations = [...byLot].sort(([left], [right]) => left.localeCompare(right))
            .map(([lotId, quantityBaseInt], fifoSequence) => ({ lotId, quantityBaseInt, fifoSequence }));
          return { ...line, baseUomCode: product.base_uom_code as string, allocations };
        }
        const lots = this.db.prepare(`SELECT id,on_hand_base_int,reserved_base_int,received_at FROM inventory_lots
          WHERE product_id=? AND status='USABLE' AND on_hand_base_int>reserved_base_int ORDER BY datetime(received_at),received_at,id`).all(line.productId) as any[];
        let needed = line.quantityBaseInt;
        const allocations: Array<{ lotId: string; quantityBaseInt: number; fifoSequence: number }> = [];
        for (const [fifoSequence, lot] of lots.entries()) {
          if (needed === 0) break;
          const quantity = Math.min(needed, Number(lot.on_hand_base_int) - Number(lot.reserved_base_int));
          if (quantity > 0) allocations.push({ lotId: lot.id, quantityBaseInt: quantity, fifoSequence });
          needed -= quantity;
        }
        if (needed > 0) throw new InventoryValidationError("INSUFFICIENT_AVAILABLE_STOCK", `Insufficient available stock for product ${line.productId}.`, 409);
        return { ...line, baseUomCode: product.base_uom_code as string, allocations };
      });
      this.db.prepare(`INSERT INTO inventory_reservations
        (id,order_id,status,reserve_operation_id,created_at,updated_at) VALUES (?,?,'ACTIVE',?,?,?)`)
        .run(reservationId, orderId, operationId, createdAt, createdAt);
      if (physicalPlans.length > 0) profileCutInventory.persistPlan(reservationId, physicalPlans);
      const insertLine = this.db.prepare(`INSERT INTO inventory_reservation_lines
        (id,reservation_id,product_id,quantity_base_int,base_uom_code_snapshot,created_at) VALUES (?,?,?,?,?,?)`);
      const insertAllocation = this.db.prepare(`INSERT INTO inventory_reservation_allocations
        (id,reservation_id,reservation_line_id,product_id,lot_id,quantity_base_int,fifo_sequence,created_at) VALUES (?,?,?,?,?,?,?,?)`);
      const allocations: Array<{ lotId: string; productId: string; quantityBaseInt: number }> = [];
      for (const plan of plans) {
        const lineId = randomUUID();
        insertLine.run(lineId, reservationId, plan.productId, plan.quantityBaseInt, plan.baseUomCode, createdAt);
        for (const allocation of plan.allocations) {
          const changed = this.db.prepare(`UPDATE inventory_lots SET reserved_base_int=reserved_base_int+?,updated_at=?
            WHERE id=? AND status='USABLE' AND on_hand_base_int-reserved_base_int>=?`).run(allocation.quantityBaseInt, createdAt, allocation.lotId, allocation.quantityBaseInt);
          if (changed.changes !== 1) throw new InventoryValidationError("INVENTORY_CONCURRENCY_CONFLICT", "Inventory changed during reservation.", 409);
          insertAllocation.run(randomUUID(), reservationId, lineId, plan.productId, allocation.lotId, allocation.quantityBaseInt, allocation.fifoSequence, createdAt);
          allocations.push({ lotId: allocation.lotId, productId: plan.productId, quantityBaseInt: allocation.quantityBaseInt });
        }
      }
      return { id: reservationId, orderId, status: "ACTIVE" as ReservationStatus, allocations };
    }).immediate();
  }

  getReservation(reservationIdValue: string) {
    const reservationId = text(reservationIdValue, "reservationId");
    const row = this.db.prepare("SELECT * FROM inventory_reservations WHERE id=?").get(reservationId) as any;
    if (!row) throw new InventoryValidationError("RESERVATION_NOT_FOUND", "Reservation was not found.", 404);
    const allocations = this.db.prepare(`SELECT lot_id AS lotId,product_id AS productId,quantity_base_int AS quantityBaseInt
      FROM inventory_reservation_allocations WHERE reservation_id=? ORDER BY fifo_sequence,lot_id`).all(reservationId) as any[];
    return { id: row.id, orderId: row.order_id, status: row.status as ReservationStatus, shipmentId: row.shipment_id, allocations };
  }

  releaseReservation(input: { reservationId: string; reason: string; operationId: string; releasedAt?: string }) {
    const reservationId = text(input.reservationId, "reservationId");
    const reason = text(input.reason, "reason", 500);
    const operationId = text(input.operationId, "operationId");
    const releasedAt = input.releasedAt ? timestamp(input.releasedAt, "releasedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const reservation = this.db.prepare("SELECT status FROM inventory_reservations WHERE id=?").get(reservationId) as any;
      if (!reservation) throw new InventoryValidationError("RESERVATION_NOT_FOUND", "Reservation was not found.", 404);
      if (!["ACTIVE", "PICKED", "PACKED", "STOCK_DISCREPANCY"].includes(reservation.status)) throw new InventoryValidationError("RESERVATION_STATE_CONFLICT", "Reservation cannot be released from its current state.", 409);
      const allocations = this.db.prepare("SELECT lot_id,quantity_base_int FROM inventory_reservation_allocations WHERE reservation_id=?").all(reservationId) as any[];
      for (const allocation of allocations) {
        const changed = this.db.prepare(`UPDATE inventory_lots SET reserved_base_int=reserved_base_int-?,updated_at=?
          WHERE id=? AND reserved_base_int>=?`).run(allocation.quantity_base_int, releasedAt, allocation.lot_id, allocation.quantity_base_int);
        if (changed.changes !== 1) throw new InventoryValidationError("INVENTORY_CONSERVATION_FAILED", "Reservation balance cannot be released safely.", 409);
      }
      new ProfileCutInventoryService(this.db).releaseReservation(reservationId);
      this.db.prepare(`UPDATE inventory_reservations SET status='RELEASED',release_operation_id=?,release_reason=?,released_at=?,updated_at=? WHERE id=?`)
        .run(operationId, reason, releasedAt, releasedAt, reservationId);
      return this.getReservation(reservationId);
    }).immediate();
  }

  private transition(reservationIdValue: string, from: ReservationStatus, to: ReservationStatus, column: "picked_at" | "packed_at", atValue?: string) {
    const reservationId = text(reservationIdValue, "reservationId");
    const at = atValue ? timestamp(atValue, column) : new Date().toISOString();
    const changed = this.db.prepare(`UPDATE inventory_reservations SET status=?,${column}=?,updated_at=? WHERE id=? AND status=?`)
      .run(to, at, at, reservationId, from);
    if (changed.changes !== 1) throw new InventoryValidationError("RESERVATION_STATE_CONFLICT", `Reservation must be ${from}.`, 409);
    return this.getReservation(reservationId);
  }

  markPicked(input: { reservationId: string; operationId: string; pickedAt?: string }) {
    text(input.operationId, "operationId");
    const unexecutedCuts = Number(this.db.prepare("SELECT COUNT(*) FROM profile_piece_reservations WHERE reservation_id=? AND status='ACTIVE'").pluck().get(input.reservationId));
    if (unexecutedCuts > 0) throw new InventoryValidationError("PROFILE_CUT_EXECUTION_REQUIRED", "Reserved profile cuts must be executed before picking.", 409);
    const fulfillment = this.getFulfillmentState(input.reservationId);
    if (fulfillment.status === "STOCK_DISCREPANCY") throw new InventoryValidationError("STOCK_DISCREPANCY", "Physical stock discrepancy blocks picking.", 409);
    if (fulfillment.requirements.some((item) => item.state === "REPLENISH_SAME_LOT")) {
      throw new InventoryValidationError("SAME_LOT_REPLENISHMENT_REQUIRED", "Reserved FIFO lot must be replenished to active picking stock before picking.", 409);
    }
    return this.transition(input.reservationId, "ACTIVE", "PICKED", "picked_at", input.pickedAt);
  }

  markPacked(input: { reservationId: string; operationId: string; packedAt?: string }) {
    text(input.operationId, "operationId");
    const fulfillment = this.getFulfillmentState(input.reservationId);
    if (fulfillment.status === "STOCK_DISCREPANCY") throw new InventoryValidationError("STOCK_DISCREPANCY", "Physical stock discrepancy blocks packing.", 409);
    if (fulfillment.requirements.some((item) => item.state === "REPLENISH_SAME_LOT")) {
      throw new InventoryValidationError("SAME_LOT_REPLENISHMENT_REQUIRED", "Reserved FIFO lot must be replenished to active picking stock before packing.", 409);
    }
    return this.transition(input.reservationId, "PICKED", "PACKED", "packed_at", input.packedAt);
  }

  dispatchReservation(input: { reservationId: string; shipmentId: string; dispatchedAt: string; operationId: string }) {
    const reservationId = text(input.reservationId, "reservationId");
    const shipmentId = text(input.shipmentId, "shipmentId");
    const operationId = text(input.operationId, "operationId");
    const dispatchedAt = timestamp(input.dispatchedAt, "dispatchedAt");
    return this.db.transaction(() => {
      const reservation = this.db.prepare("SELECT status,order_id FROM inventory_reservations WHERE id=?").get(reservationId) as any;
      if (!reservation) throw new InventoryValidationError("RESERVATION_NOT_FOUND", "Reservation was not found.", 404);
      if (reservation.status !== "PACKED") throw new InventoryValidationError("RESERVATION_STATE_CONFLICT", "Only a packed reservation may be dispatched.", 409);
      const fulfillment = this.getFulfillmentState(reservationId);
      if (fulfillment.status === "STOCK_DISCREPANCY") throw new InventoryValidationError("STOCK_DISCREPANCY", "Physical stock discrepancy blocks dispatch.", 409);
      if (fulfillment.requirements.some((item) => item.state !== "READY_AT_PICKING")) {
        throw new InventoryValidationError("SAME_LOT_REPLENISHMENT_REQUIRED", "Reserved FIFO lot must be replenished to active picking stock before dispatch.", 409);
      }
      const allocations = this.db.prepare(`SELECT a.lot_id,a.product_id,a.quantity_base_int,l.base_uom_code_snapshot
        FROM inventory_reservation_allocations a JOIN inventory_lots l ON l.id=a.lot_id
        WHERE a.reservation_id=? ORDER BY a.fifo_sequence,a.lot_id`).all(reservationId) as any[];
      const products = new Set<string>();
      for (const allocation of allocations) {
        const changed = this.db.prepare(`UPDATE inventory_lots SET on_hand_base_int=on_hand_base_int-?,reserved_base_int=reserved_base_int-?,updated_at=?
          WHERE id=? AND on_hand_base_int>=? AND reserved_base_int>=? AND status='USABLE'`)
          .run(allocation.quantity_base_int, allocation.quantity_base_int, dispatchedAt, allocation.lot_id, allocation.quantity_base_int, allocation.quantity_base_int);
        if (changed.changes !== 1) throw new InventoryValidationError("INVENTORY_CONSERVATION_FAILED", "Dispatch would create negative or inconsistent stock.", 409);
        let remaining = Number(allocation.quantity_base_int);
        const positions = this.db.prepare(`SELECT id,location_id,quantity_base_int FROM inventory_lot_location_balances
          WHERE lot_id=? AND location_kind='PICKING' AND active=1 AND physical_state='CONFIRMED' AND quantity_base_int>0
          ORDER BY location_id`).all(allocation.lot_id) as any[];
        for (const position of positions) {
          if (remaining === 0) break;
          const take = Math.min(remaining, Number(position.quantity_base_int));
          this.db.prepare("UPDATE inventory_lot_location_balances SET quantity_base_int=quantity_base_int-?,updated_at=? WHERE id=?").run(take, dispatchedAt, position.id);
          try {
            new WarehousePackageBalanceService(this.db).consumePicking({
              lotId: allocation.lot_id,
              locationId: position.location_id,
              quantityBaseInt: take,
              occurredAt: dispatchedAt,
              operationId,
            });
          } catch (error) {
            if (error instanceof WarehousePackageBalanceError) {
              throw new InventoryValidationError(error.code, error.message, 409);
            }
            throw error;
          }
          remaining -= take;
        }
        if (remaining !== 0) throw new InventoryValidationError("INVENTORY_CONSERVATION_FAILED", "Picking location balance cannot satisfy dispatch.", 409);
        this.db.prepare(`INSERT INTO inventory_ledger_events (
          id,operation_id,event_type,product_id,lot_id,reservation_id,order_id,shipment_id,quantity_delta_base_int,
          base_uom_code_snapshot,reason_code,reference_type,reference_id,occurred_at
        ) VALUES (?,?,'DISPATCH',?,?,?,?,?, ?,?,'APPROVED_SHIPMENT_DISPATCH','shipment',?,?)`).run(
          randomUUID(), operationId, allocation.product_id, allocation.lot_id, reservationId, reservation.order_id,
          shipmentId, -Number(allocation.quantity_base_int), allocation.base_uom_code_snapshot, shipmentId, dispatchedAt,
        );
        products.add(allocation.product_id);
      }
      this.db.prepare(`UPDATE inventory_reservations SET status='DISPATCHED',dispatch_operation_id=?,shipment_id=?,dispatched_at=?,updated_at=? WHERE id=? AND status='PACKED'`)
        .run(operationId, shipmentId, dispatchedAt, dispatchedAt, reservationId);
      this.db.prepare("UPDATE profile_piece_reservations SET status='DISPATCHED',updated_at=? WHERE reservation_id=? AND status='EXECUTED'")
        .run(dispatchedAt, reservationId);
      for (const productId of products) this.syncProjection(productId);
      return this.getReservation(reservationId);
    }).immediate();
  }

  getFulfillmentState(reservationIdValue: string) {
    const reservation = this.getReservation(reservationIdValue);
    const requirements = reservation.allocations.map((allocation) => {
      const positions = this.db.prepare(`SELECT location_kind,quantity_base_int,physical_state,active
        FROM inventory_lot_location_balances WHERE lot_id=?`).all(allocation.lotId) as any[];
      const missing = positions.some((position) => position.physical_state === "MISSING" && Number(position.quantity_base_int) > 0);
      const picking = positions.filter((position) => position.location_kind === "PICKING" && position.active === 1 && position.physical_state === "CONFIRMED")
        .reduce((sum, position) => sum + Number(position.quantity_base_int), 0);
      const reserve = positions.filter((position) => position.location_kind === "RESERVE" && position.active === 1 && position.physical_state === "CONFIRMED")
        .reduce((sum, position) => sum + Number(position.quantity_base_int), 0);
      const replenishment = Math.max(0, allocation.quantityBaseInt - picking);
      const state = missing || reservation.status === "STOCK_DISCREPANCY"
        ? "STOCK_DISCREPANCY"
        : replenishment === 0
          ? "READY_AT_PICKING"
          : reserve >= replenishment
            ? "REPLENISH_SAME_LOT"
            : "STOCK_DISCREPANCY";
      return {
        lotId: allocation.lotId,
        productId: allocation.productId,
        quantityBaseInt: allocation.quantityBaseInt,
        state,
        pickingQuantityBaseInt: picking,
        reserveQuantityBaseInt: reserve,
        replenishmentQuantityBaseInt: state === "REPLENISH_SAME_LOT" ? replenishment : 0,
      };
    });
    return {
      reservationId: reservation.id,
      status: requirements.some(({ state }) => state === "STOCK_DISCREPANCY") ? "STOCK_DISCREPANCY" : reservation.status,
      requirements,
    };
  }

  reportStockDiscrepancy(input: { reservationId: string; lotId: string; locationId: string; reason: string; operationId: string }) {
    const reservationId = text(input.reservationId, "reservationId");
    const lotId = text(input.lotId, "lotId");
    const locationId = text(input.locationId, "locationId");
    const reason = text(input.reason, "reason", 500);
    text(input.operationId, "operationId");
    return this.db.transaction(() => {
      const allocation = this.db.prepare("SELECT 1 FROM inventory_reservation_allocations WHERE reservation_id=? AND lot_id=?").get(reservationId, lotId);
      if (!allocation) throw new InventoryValidationError("RESERVATION_ALLOCATION_NOT_FOUND", "Reservation does not contain the reported lot.", 404);
      const changed = this.db.prepare(`UPDATE inventory_lot_location_balances SET physical_state='MISSING',discrepancy_reason=?,updated_at=CURRENT_TIMESTAMP
        WHERE lot_id=? AND location_id=? AND quantity_base_int>0`).run(reason, lotId, locationId);
      if (changed.changes !== 1) throw new InventoryValidationError("LOT_LOCATION_NOT_FOUND", "Lot location balance was not found.", 404);
      this.db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lotId);
      return this.getFulfillmentState(reservationId);
    }).immediate();
  }

  correctLot(input: {
    lotId: string;
    locationId: string;
    expectedOnHandBaseInt: number;
    observedOnHandBaseInt: number;
    reason: string;
    approvalReference: string;
    operationId: string;
    correctedAt?: string;
  }) {
    const lotId = text(input.lotId, "lotId");
    const locationId = text(input.locationId, "locationId");
    if (!Number.isSafeInteger(input.expectedOnHandBaseInt) || input.expectedOnHandBaseInt < 0) throw new InventoryValidationError("INVALID_BASE_QUANTITY", "expectedOnHandBaseInt must be a non-negative base-unit integer.");
    const expected = Number(input.expectedOnHandBaseInt);
    if (!Number.isSafeInteger(input.observedOnHandBaseInt) || input.observedOnHandBaseInt < 0) throw new InventoryValidationError("INVALID_BASE_QUANTITY", "observedOnHandBaseInt must be a non-negative base-unit integer.");
    const observed = Number(input.observedOnHandBaseInt);
    const reason = text(input.reason, "reason", 500);
    const approvalReference = text(input.approvalReference, "approvalReference");
    const operationId = text(input.operationId, "operationId");
    const correctedAt = input.correctedAt ? timestamp(input.correctedAt, "correctedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const lot = this.db.prepare("SELECT * FROM inventory_lots WHERE id=?").get(lotId) as any;
      if (!lot) throw new InventoryValidationError("LOT_NOT_FOUND", "Inventory lot was not found.", 404);
      if (Number(lot.on_hand_base_int) !== expected) throw new InventoryValidationError("INVENTORY_CONCURRENCY_CONFLICT", "Expected lot balance no longer matches.", 409);
      if (observed < Number(lot.reserved_base_int)) throw new InventoryValidationError("CORRECTION_BELOW_RESERVED", "Correction cannot reduce on-hand below active reservations.", 409);
      const delta = observed - expected;
      if (delta === 0) throw new InventoryValidationError("ZERO_CORRECTION", "Correction requires a non-zero observed difference.");
      const position = this.db.prepare("SELECT id FROM inventory_lot_location_balances WHERE lot_id=? AND location_id=?").get(lotId, locationId) as any;
      if (!position) throw new InventoryValidationError("LOT_LOCATION_NOT_FOUND", "Lot location balance was not found.", 404);
      this.db.prepare(`UPDATE inventory_lots SET on_hand_base_int=?,status='USABLE',updated_at=? WHERE id=?`).run(observed, correctedAt, lotId);
      const positionQuantity = Number(this.db.prepare("SELECT quantity_base_int FROM inventory_lot_location_balances WHERE id=?").pluck().get(position.id));
      if (positionQuantity + delta < 0) throw new InventoryValidationError("CORRECTION_LOCATION_MISMATCH", "Correction exceeds the selected location balance.", 409);
      this.db.prepare(`UPDATE inventory_lot_location_balances SET quantity_base_int=quantity_base_int+?,physical_state='CONFIRMED',
        discrepancy_reason=NULL,updated_at=? WHERE id=?`).run(delta, correctedAt, position.id);
      this.db.prepare(`INSERT INTO inventory_ledger_events (
        id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,reason_code,
        reference_type,reference_id,occurred_at
      ) VALUES (?,?,'CORRECTION',?,?,?,?,?,'approved_inventory_correction',?,?)`).run(
        randomUUID(), operationId, lot.product_id, lotId, delta, lot.base_uom_code_snapshot,
        reason, approvalReference, correctedAt,
      );
      this.syncProjection(lot.product_id);
      return { lotId, expectedOnHandBaseInt: expected, observedOnHandBaseInt: observed, deltaBaseInt: delta, approvalReference };
    }).immediate();
  }
}

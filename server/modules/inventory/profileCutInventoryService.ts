import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { InventoryValidationError } from "./inventoryService.js";
import { WarehousePackageBalanceError, WarehousePackageBalanceService } from "../warehouse/warehousePackageBalanceService.js";
import { enqueueCanonicalChannelChanges } from "../channels/channelOutboundProjection.js";

export type ProfileCutPlanInput = {
  publishedKitVersionId: string;
  productId: string;
  kerfMm: number;
  cuts: Array<{ lengthMm: number }>;
};

export type PlannedProfilePiece = {
  publishedKitVersionId: string;
  productId: string;
  pieceId: string;
  lotId: string;
  originalLengthMm: number;
  cuts: Array<{ lengthMm: number; kerfMm: number }>;
  cutLengthTotalMm: number;
  kerfTotalMm: number;
  consumedLengthMm: number;
  remnantLengthMm: number;
};

const requiredText = (value: unknown, field: string) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > 250) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", `${field} is invalid.`);
  return result;
};

const integer = (value: unknown, field: string, allowZero = false) => {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) throw new InventoryValidationError("INVALID_BASE_QUANTITY", `${field} must be ${allowZero ? "a non-negative" : "a positive"} integer millimeter value.`);
  return Number(value);
};

const allocateInteger = (total: number, weights: number[]) => {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)) {
    throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "Historical cost allocation requires non-negative safe integers.");
  }
  const totalExact = BigInt(total);
  const exactWeights = weights.map(BigInt);
  const sum = exactWeights.reduce((value, weight) => value + weight, 0n);
  if (sum <= 0n) return weights.map(() => 0);
  const allocated = exactWeights.map((weight) => totalExact * weight / sum);
  let remainder = totalExact - allocated.reduce((value, item) => value + item, 0n);
  for (let index = 0; remainder > 0n; index = (index + 1) % allocated.length) {
    allocated[index] += 1n;
    remainder -= 1n;
  }
  return allocated.map((value) => Number(value));
};

export class ProfileCutInventoryService {
  constructor(private readonly db: Database.Database) {}

  assertRepresented(productIdValue?: string) {
    const productId = productIdValue ? requiredText(productIdValue, "productId") : null;
    const blocked = this.db.prepare(`SELECT b.inventory_lot_id,b.reason_code FROM profile_piece_migration_blocks b
      JOIN inventory_lots l ON l.id=b.inventory_lot_id
      WHERE l.on_hand_base_int>0 AND (? IS NULL OR b.product_id=?) ORDER BY b.inventory_lot_id LIMIT 1`).get(productId, productId) as any;
    if (blocked) throw new InventoryValidationError("PROFILE_PIECE_MIGRATION_REQUIRED", `Profile lot ${blocked.inventory_lot_id} has no trustworthy physical-piece representation.`, 409);
    const mismatch = this.db.prepare(`SELECT l.id FROM inventory_lots l JOIN products p ON p.id=l.product_id
      LEFT JOIN profile_inventory_pieces piece ON piece.inventory_lot_id=l.id
      WHERE p.catalog_type='profile' AND l.on_hand_base_int>0 AND (? IS NULL OR l.product_id=?)
      GROUP BY l.id,l.on_hand_base_int,l.reserved_base_int
      HAVING COALESCE(SUM(piece.current_length_mm),0)<>l.on_hand_base_int
        OR COALESCE(SUM(piece.reserved_length_mm),0)<>l.reserved_base_int
      ORDER BY l.id LIMIT 1`).get(productId, productId) as any;
    if (mismatch) throw new InventoryValidationError("PROFILE_PIECE_MIGRATION_REQUIRED", `Profile lot ${mismatch.id} does not reconcile to proven physical pieces.`, 409);
  }

  createReceiptPieces(lotIdValue: string, operationIdValue: string) {
    const lotId = requiredText(lotIdValue, "lotId");
    const operationId = requiredText(operationIdValue, "operationId");
    const lot = this.db.prepare(`SELECT l.id,l.product_id,l.received_quantity_base_int,l.acquisition_cost_snapshot_id,
      p.catalog_type,pol.profile_length_mm,c.landed_cost_try_minor
      FROM inventory_lots l JOIN products p ON p.id=l.product_id
      JOIN purchase_order_lines pol ON pol.id=l.purchase_line_id
      JOIN acquisition_lot_cost_snapshots c ON c.id=l.acquisition_cost_snapshot_id
      WHERE l.id=?`).get(lotId) as any;
    if (!lot) throw new InventoryValidationError("LOT_NOT_FOUND", "Inventory lot was not found.", 404);
    if (lot.catalog_type !== "profile") return [];
    const length = integer(lot.profile_length_mm, "profileLengthMm");
    const totalLength = integer(lot.received_quantity_base_int, "receivedQuantityBaseInt");
    if (totalLength % length !== 0) throw new InventoryValidationError("PROFILE_PIECE_LENGTH_MISMATCH", "Received profile length must resolve to whole physical pieces.", 409);
    const count = totalLength / length;
    const existing = this.db.prepare("SELECT * FROM profile_inventory_pieces WHERE inventory_lot_id=? ORDER BY piece_sequence").all(lotId) as any[];
    if (existing.length > 0) return existing;
    const costs = allocateInteger(Number(lot.landed_cost_try_minor), Array.from({ length: count }, () => length));
    const insert = this.db.prepare(`INSERT INTO profile_inventory_pieces (
      id,product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
      original_length_mm,current_length_mm,reserved_length_mm,historical_cost_minor,status,created_operation_id
    ) VALUES (?,?,?,?,?,?,?, ?,?,0,?,'AVAILABLE',?)`);
    const created = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      insert.run(id, lot.product_id, lotId, lot.acquisition_cost_snapshot_id, id, null, index + 1, length, length, costs[index], operationId);
      created.push(this.db.prepare("SELECT * FROM profile_inventory_pieces WHERE id=?").get(id));
    }
    return created;
  }

  plan(input: ProfileCutPlanInput, excludedPieceIds: ReadonlySet<string> = new Set()): PlannedProfilePiece[] {
    const publishedKitVersionId = requiredText(input.publishedKitVersionId, "publishedKitVersionId");
    const productId = requiredText(input.productId, "productId");
    this.assertRepresented(productId);
    const kerfMm = integer(input.kerfMm, "kerfMm", true);
    if (!Array.isArray(input.cuts) || input.cuts.length === 0) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "Profile cut plan cannot be empty.");
    const cuts = input.cuts.map((cut, index) => ({ lengthMm: integer(cut.lengthMm, `cuts[${index}].lengthMm`), kerfMm }))
      .sort((left, right) => right.lengthMm - left.lengthMm);
    const version = this.db.prepare("SELECT effective_kerf_mm FROM published_kit_versions WHERE id=?").get(publishedKitVersionId) as any;
    const frozenCuts = this.db.prepare(`SELECT profile_product_id,length_mm,quantity,kerf_mm
      FROM published_kit_version_cuts WHERE published_kit_version_id=? ORDER BY cut_sequence`).all(publishedKitVersionId) as any[];
    if (!version || frozenCuts.length === 0) {
      throw new InventoryValidationError("PROFILE_CUT_PLAN_INVALID", "Published kit version has no canonical profile cut plan.", 409);
    }
    if (Number(version.effective_kerf_mm) !== kerfMm || frozenCuts.some((cut) => cut.profile_product_id !== productId || Number(cut.kerf_mm) !== kerfMm)) {
      throw new InventoryValidationError("PROFILE_CUT_PLAN_INVALID", "Requested profile identity or kerf differs from the immutable published cut plan.", 409);
    }
    const canonicalCounts = new Map<number, number>();
    for (const cut of frozenCuts) canonicalCounts.set(Number(cut.length_mm), (canonicalCounts.get(Number(cut.length_mm)) || 0) + Number(cut.quantity));
    const requestedCounts = new Map<number, number>();
    for (const cut of cuts) requestedCounts.set(cut.lengthMm, (requestedCounts.get(cut.lengthMm) || 0) + 1);
    const firstCanonical = canonicalCounts.entries().next().value as [number, number] | undefined;
    const multiplier = firstCanonical && requestedCounts.has(firstCanonical[0])
      ? (requestedCounts.get(firstCanonical[0]) as number) / firstCanonical[1]
      : 0;
    if (!Number.isSafeInteger(multiplier) || multiplier <= 0 || requestedCounts.size !== canonicalCounts.size
      || [...canonicalCounts].some(([lengthMm, quantity]) => requestedCounts.get(lengthMm) !== quantity * multiplier)) {
      throw new InventoryValidationError("PROFILE_CUT_PLAN_INVALID", "Requested cuts must be an exact whole-order multiple of the immutable published cut plan.", 409);
    }
    const pieces = (this.db.prepare(`SELECT id,inventory_lot_id,current_length_mm FROM profile_inventory_pieces
      WHERE product_id=? AND status='AVAILABLE' AND reserved_length_mm=0 AND current_length_mm>0
      ORDER BY current_length_mm,id`).all(productId) as any[])
      .filter((piece) => !excludedPieceIds.has(piece.id))
      .map((piece) => ({ id: piece.id as string, lotId: piece.inventory_lot_id as string, originalLengthMm: Number(piece.current_length_mm), remaining: Number(piece.current_length_mm), cuts: [] as Array<{ lengthMm: number; kerfMm: number }> }));
    for (const cut of cuts) {
      const required = cut.lengthMm + cut.kerfMm;
      const piece = pieces.filter((candidate) => candidate.remaining >= required).sort((left, right) => left.remaining - right.remaining || left.id.localeCompare(right.id))[0];
      if (!piece) throw new InventoryValidationError("INSUFFICIENT_PROFILE_PIECES", `No available physical profile piece can satisfy ${cut.lengthMm} mm plus ${cut.kerfMm} mm kerf.`, 409);
      piece.cuts.push(cut);
      piece.remaining -= required;
    }
    return pieces.filter((piece) => piece.cuts.length > 0).map((piece) => {
      const cutLengthTotalMm = piece.cuts.reduce((sum, cut) => sum + cut.lengthMm, 0);
      const kerfTotalMm = piece.cuts.reduce((sum, cut) => sum + cut.kerfMm, 0);
      return {
        publishedKitVersionId, productId, pieceId: piece.id, lotId: piece.lotId,
        originalLengthMm: piece.originalLengthMm, cuts: piece.cuts, cutLengthTotalMm, kerfTotalMm,
        consumedLengthMm: cutLengthTotalMm + kerfTotalMm, remnantLengthMm: piece.remaining,
      };
    });
  }

  persistPlan(reservationIdValue: string, plans: PlannedProfilePiece[]) {
    const reservationId = requiredText(reservationIdValue, "reservationId");
    const insertReservation = this.db.prepare(`INSERT INTO profile_piece_reservations (
      id,reservation_id,published_kit_version_id,profile_piece_id,product_id,cut_length_total_mm,
      kerf_total_mm,consumed_length_mm,planned_remnant_length_mm,status
    ) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')`);
    const insertCut = this.db.prepare(`INSERT INTO profile_piece_reservation_cuts (
      id,profile_piece_reservation_id,cut_sequence,length_mm,kerf_mm
    ) VALUES (?,?,?,?,?)`);
    for (const plan of plans) {
      const changed = this.db.prepare(`UPDATE profile_inventory_pieces SET reserved_length_mm=?,status='RESERVED',updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='AVAILABLE' AND reserved_length_mm=0 AND current_length_mm=?`).run(plan.consumedLengthMm, plan.pieceId, plan.originalLengthMm);
      if (changed.changes !== 1) throw new InventoryValidationError("INVENTORY_CONCURRENCY_CONFLICT", "Profile piece changed during reservation.", 409);
      const id = randomUUID();
      insertReservation.run(id, reservationId, plan.publishedKitVersionId, plan.pieceId, plan.productId,
        plan.cutLengthTotalMm, plan.kerfTotalMm, plan.consumedLengthMm, plan.remnantLengthMm);
      plan.cuts.forEach((cut, sequence) => insertCut.run(randomUUID(), id, sequence, cut.lengthMm, cut.kerfMm));
    }
  }

  releaseReservation(reservationIdValue: string) {
    const reservationId = requiredText(reservationIdValue, "reservationId");
    const rows = this.db.prepare("SELECT id,profile_piece_id,status FROM profile_piece_reservations WHERE reservation_id=?").all(reservationId) as any[];
    for (const row of rows) {
      if (row.status === "ACTIVE") {
        this.db.prepare("UPDATE profile_inventory_pieces SET reserved_length_mm=0,status='AVAILABLE',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='RESERVED'").run(row.profile_piece_id);
        this.db.prepare("UPDATE profile_piece_reservations SET status='RELEASED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      } else if (row.status === "EXECUTED") {
        this.db.prepare(`UPDATE profile_inventory_pieces SET reserved_length_mm=0,status='AVAILABLE',updated_at=CURRENT_TIMESTAMP
          WHERE id IN (SELECT o.inventory_piece_id FROM profile_cut_outputs o JOIN profile_cut_executions e ON e.id=o.execution_id
            WHERE e.profile_piece_reservation_id=? AND o.output_kind='CUT') AND status='RESERVED'`).run(row.id);
        this.db.prepare("UPDATE profile_piece_reservations SET status='RELEASED',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
      }
    }
  }

  markDispatched(reservationIdValue: string, dispatchedAtValue: string) {
    const reservationId = requiredText(reservationIdValue, "reservationId");
    const dispatchedAt = requiredText(dispatchedAtValue, "dispatchedAt");
    const expected = Number(this.db.prepare(`SELECT COALESCE(SUM(cut_length_total_mm),0) FROM profile_piece_reservations
      WHERE reservation_id=? AND status='EXECUTED'`).pluck().get(reservationId));
    const actual = Number(this.db.prepare(`SELECT COALESCE(SUM(p.current_length_mm),0)
      FROM profile_piece_reservations r JOIN profile_cut_executions e ON e.profile_piece_reservation_id=r.id
      JOIN profile_cut_outputs o ON o.execution_id=e.id AND o.output_kind='CUT'
      JOIN profile_inventory_pieces p ON p.id=o.inventory_piece_id
      WHERE r.reservation_id=? AND r.status='EXECUTED' AND p.status='RESERVED'
        AND p.reserved_length_mm=p.current_length_mm`).pluck().get(reservationId));
    if (expected !== actual) throw new InventoryValidationError("INVENTORY_CONSERVATION_FAILED", "Reserved profile delivery pieces do not match the dispatch quantity.", 409);
    this.db.prepare(`UPDATE profile_inventory_pieces SET current_length_mm=0,reserved_length_mm=0,status='CONSUMED',updated_at=?
      WHERE id IN (SELECT o.inventory_piece_id FROM profile_piece_reservations r
        JOIN profile_cut_executions e ON e.profile_piece_reservation_id=r.id
        JOIN profile_cut_outputs o ON o.execution_id=e.id AND o.output_kind='CUT'
        WHERE r.reservation_id=? AND r.status='EXECUTED')`).run(dispatchedAt, reservationId);
    this.db.prepare("UPDATE profile_piece_reservations SET status='DISPATCHED',updated_at=? WHERE reservation_id=? AND status='EXECUTED'")
      .run(dispatchedAt, reservationId);
  }

  restoreReturnedPieces(input: {
    receiptAllocationId: string; productId: string; lotId: string; dispatchOperationId: string;
    quantityBaseInt: number; historicalCostMinor: number; locationId: string; packageId: string;
    operationId: string; restoredAt: string;
  }) {
    const quantity = integer(input.quantityBaseInt, "quantityBaseInt");
    const sources = this.db.prepare(`SELECT p.* FROM profile_inventory_pieces p
      JOIN profile_cut_outputs o ON o.inventory_piece_id=p.id AND o.output_kind='CUT'
      JOIN profile_cut_executions e ON e.id=o.execution_id
      JOIN profile_piece_reservations r ON r.id=e.profile_piece_reservation_id
      JOIN inventory_reservations ir ON ir.id=r.reservation_id
      WHERE p.product_id=? AND p.inventory_lot_id=? AND p.status='CONSUMED'
        AND ir.dispatch_operation_id=?
        AND NOT EXISTS (SELECT 1 FROM profile_return_piece_restorations x WHERE x.source_delivery_piece_id=p.id)
      ORDER BY p.piece_sequence,p.id`).all(input.productId, input.lotId, input.dispatchOperationId) as any[];
    const selected: any[] = [];
    let remaining = quantity;
    for (const source of sources) {
      if (remaining === 0) break;
      if (Number(source.original_length_mm) > remaining) {
        throw new InventoryValidationError("PROFILE_RETURN_PIECE_PROVENANCE_REQUIRED", "Returned profile quantity must match whole delivered cut pieces.", 409);
      }
      selected.push(source);
      remaining -= Number(source.original_length_mm);
    }
    if (remaining !== 0) throw new InventoryValidationError("PROFILE_RETURN_PIECE_PROVENANCE_REQUIRED", "Returned profile pieces cannot be proven from the original dispatch.", 409);
    const costs = allocateInteger(input.historicalCostMinor, selected.map((source) => Number(source.original_length_mm)));
    let nextSequence = Number(this.db.prepare("SELECT COALESCE(MAX(piece_sequence),0)+1 FROM profile_inventory_pieces WHERE inventory_lot_id=?").pluck().get(input.lotId));
    selected.forEach((source, index) => {
      const returnedPieceId = randomUUID();
      const length = Number(source.original_length_mm);
      this.db.prepare(`INSERT INTO profile_inventory_pieces (
        id,product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
        original_length_mm,current_length_mm,reserved_length_mm,historical_cost_minor,status,created_operation_id,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?, ?,?,0,?,'AVAILABLE',?,?,?)`).run(returnedPieceId, input.productId, input.lotId,
        source.acquisition_cost_snapshot_id, source.origin_piece_id, source.id, nextSequence++, length, length,
        costs[index], input.operationId, input.restoredAt, input.restoredAt);
      this.db.prepare(`INSERT INTO profile_return_piece_restorations (
        id,return_receipt_inventory_allocation_id,source_delivery_piece_id,returned_piece_id,inventory_lot_id,
        location_id,warehouse_package_id,length_mm,historical_cost_minor,operation_id,restored_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.receiptAllocationId, source.id, returnedPieceId,
        input.lotId, input.locationId, input.packageId, length, costs[index], input.operationId, input.restoredAt);
    });
    this.assertRepresented(input.productId);
  }

  executeReservationCuts(input: { reservationId: string; operationId: string; actorId: string; executedAt?: string }) {
    const reservationId = requiredText(input.reservationId, "reservationId");
    const operationId = requiredText(input.operationId, "operationId");
    const actorId = requiredText(input.actorId, "actorId");
    const executedAt = input.executedAt || new Date().toISOString();
    if (!Number.isFinite(Date.parse(executedAt))) throw new InventoryValidationError("INVENTORY_VALIDATION_FAILED", "executedAt must be an ISO timestamp.");
    return this.db.transaction(() => {
      const prior = this.executionResult(reservationId, operationId);
      if (prior.executions.length > 0) return prior;
      const reservations = this.db.prepare(`SELECT r.*,p.current_length_mm,p.historical_cost_minor,p.inventory_lot_id,
        p.acquisition_cost_snapshot_id,p.origin_piece_id,p.piece_sequence
        FROM profile_piece_reservations r JOIN profile_inventory_pieces p ON p.id=r.profile_piece_id
        WHERE r.reservation_id=? ORDER BY r.id`).all(reservationId) as any[];
      if (reservations.length === 0) throw new InventoryValidationError("PROFILE_CUT_RESERVATION_NOT_FOUND", "Reservation has no profile cut plan.", 404);
      const executions = [];
      for (const reservation of reservations) {
        if (reservation.status !== "ACTIVE" || Number(reservation.current_length_mm) !== Number(reservation.consumed_length_mm) + Number(reservation.planned_remnant_length_mm)) {
          throw new InventoryValidationError("PROFILE_CUT_STATE_CONFLICT", "Profile piece is not available for the planned cut.", 409);
        }
        const cuts = this.db.prepare("SELECT length_mm,kerf_mm FROM profile_piece_reservation_cuts WHERE profile_piece_reservation_id=? ORDER BY cut_sequence").all(reservation.id) as any[];
        const originalCost = Number(reservation.historical_cost_minor);
        const currentLength = BigInt(integer(reservation.current_length_mm, "currentLengthMm"));
        const consumedLength = BigInt(integer(reservation.consumed_length_mm, "consumedLengthMm"));
        const originalCostExact = BigInt(integer(originalCost, "historicalCostMinor", true));
        const consumedCost = Number((originalCostExact * consumedLength + currentLength / 2n) / currentLength);
        const remnantCost = originalCost - consumedCost;
        const executionId = randomUUID();
        const locations = this.db.prepare(`SELECT id,location_id FROM inventory_lot_location_balances
          WHERE lot_id=? AND location_kind='PICKING' AND active=1 AND physical_state='CONFIRMED' AND quantity_base_int>=?
          ORDER BY location_id`).all(reservation.inventory_lot_id, reservation.current_length_mm) as any[];
        if (locations.length !== 1) throw new InventoryValidationError("PROFILE_SOURCE_PROVENANCE_REQUIRED", "Cut execution requires exactly one proven source picking location.", 409);
        const sourceLocation = locations[0];
        const managed = this.db.prepare(`SELECT id FROM warehouse_execution_packages WHERE inventory_lot_id=? AND disposition='ACCEPTED' LIMIT 1`)
          .get(reservation.inventory_lot_id);
        let sourcePackageId: string | null = null;
        if (managed) {
          const packages = this.db.prepare(`SELECT id FROM warehouse_execution_packages
            WHERE inventory_lot_id=? AND current_slot_id=? AND disposition='ACCEPTED' AND status='PICKING'
              AND remaining_quantity_base_int>=? ORDER BY id`).all(
                reservation.inventory_lot_id, sourceLocation.location_id, reservation.current_length_mm,
              ) as any[];
          if (packages.length !== 1) throw new InventoryValidationError("PROFILE_SOURCE_PROVENANCE_REQUIRED", "Cut execution requires exactly one proven source package.", 409);
          sourcePackageId = packages[0].id;
        }
        this.db.prepare(`INSERT INTO profile_cut_executions (
          id,profile_piece_reservation_id,source_piece_id,operation_id,original_length_mm,cut_length_total_mm,
          kerf_total_mm,consumed_length_mm,remnant_length_mm,original_cost_minor,consumed_cost_minor,
          remnant_cost_minor,executed_by_actor_id,executed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(executionId, reservation.id, reservation.profile_piece_id,
          operationId, reservation.current_length_mm, reservation.cut_length_total_mm, reservation.kerf_total_mm,
          reservation.consumed_length_mm, reservation.planned_remnant_length_mm, originalCost, consumedCost,
          remnantCost, actorId, executedAt);
        this.db.prepare("UPDATE profile_inventory_pieces SET current_length_mm=0,reserved_length_mm=0,status='CUT',updated_at=? WHERE id=? AND status='RESERVED'")
          .run(executedAt, reservation.profile_piece_id);
        const cutCosts = allocateInteger(consumedCost, cuts.map((cut) => Number(cut.length_mm) + Number(cut.kerf_mm)));
        let nextSequence = Number(this.db.prepare("SELECT COALESCE(MAX(piece_sequence),0)+1 FROM profile_inventory_pieces WHERE inventory_lot_id=?").pluck().get(reservation.inventory_lot_id));
        cuts.forEach((cut, sequence) => {
          const cutPieceId = randomUUID();
          this.db.prepare(`INSERT INTO profile_inventory_pieces (
            id,product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
            original_length_mm,current_length_mm,reserved_length_mm,historical_cost_minor,status,created_operation_id,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,'RESERVED',?,?,?)`).run(cutPieceId, reservation.product_id,
            reservation.inventory_lot_id, reservation.acquisition_cost_snapshot_id, reservation.origin_piece_id,
            reservation.profile_piece_id, nextSequence++, cut.length_mm, cut.length_mm, cut.length_mm,
            cutCosts[sequence], operationId, executedAt, executedAt);
          this.db.prepare(`INSERT INTO profile_cut_outputs (
            id,execution_id,output_kind,output_sequence,length_mm,historical_cost_minor,inventory_piece_id
          ) VALUES (?,?,'CUT',?,?,?,?)`).run(randomUUID(), executionId, sequence, cut.length_mm, cutCosts[sequence], cutPieceId);
        });
        if (Number(reservation.planned_remnant_length_mm) > 0) {
          const remnantId = randomUUID();
          this.db.prepare(`INSERT INTO profile_inventory_pieces (
            id,product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
            original_length_mm,current_length_mm,reserved_length_mm,historical_cost_minor,status,created_operation_id,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?, ?,?,0,?,'AVAILABLE',?,?,?)`).run(remnantId, reservation.product_id,
            reservation.inventory_lot_id, reservation.acquisition_cost_snapshot_id, reservation.origin_piece_id,
            reservation.profile_piece_id, nextSequence++, reservation.planned_remnant_length_mm,
            reservation.planned_remnant_length_mm, remnantCost, operationId, executedAt, executedAt);
          this.db.prepare(`INSERT INTO profile_cut_outputs (
            id,execution_id,output_kind,output_sequence,length_mm,historical_cost_minor,inventory_piece_id
          ) VALUES (?,?,'REMNANT',0,?,?,?)`).run(randomUUID(), executionId,
            reservation.planned_remnant_length_mm, remnantCost, remnantId);
        }
        const kerf = Number(reservation.kerf_total_mm);
        if (kerf > 0) {
          const lotChanged = this.db.prepare(`UPDATE inventory_lots SET on_hand_base_int=on_hand_base_int-?,reserved_base_int=reserved_base_int-?,updated_at=?
            WHERE id=? AND on_hand_base_int>=? AND reserved_base_int>=?`).run(kerf, kerf, executedAt,
              reservation.inventory_lot_id, kerf, kerf);
          const locationChanged = this.db.prepare(`UPDATE inventory_lot_location_balances SET quantity_base_int=quantity_base_int-?,updated_at=?
            WHERE id=? AND quantity_base_int>=?`).run(kerf, executedAt, sourceLocation.id, kerf);
          if (lotChanged.changes !== 1 || locationChanged.changes !== 1) throw new InventoryValidationError("INVENTORY_CONSERVATION_FAILED", "Kerf waste could not be posted safely.", 409);
          if (sourcePackageId) {
            try {
              new WarehousePackageBalanceService(this.db).consumeSpecificPicking({ packageId: sourcePackageId,
                lotId: reservation.inventory_lot_id, locationId: sourceLocation.location_id, quantityBaseInt: kerf,
                occurredAt: executedAt, operationId });
            } catch (error) {
              if (error instanceof WarehousePackageBalanceError) throw new InventoryValidationError(error.code, error.message, 409);
              throw error;
            }
          }
          const ledgerId = randomUUID();
          const baseUom = this.db.prepare("SELECT base_uom_code_snapshot FROM inventory_lots WHERE id=?").pluck().get(reservation.inventory_lot_id);
          this.db.prepare(`INSERT INTO inventory_ledger_events (
            id,operation_id,event_type,product_id,lot_id,reservation_id,quantity_delta_base_int,base_uom_code_snapshot,
            reason_code,reference_type,reference_id,occurred_at
          ) VALUES (?,?,'CORRECTION',?,?,?, ?,?,'PROFILE_CUT_KERF_WASTE','profile_cut_execution',?,?)`).run(
            ledgerId, `${operationId}:kerf:${executionId}`, reservation.product_id, reservation.inventory_lot_id,
            reservationId, -kerf, baseUom, executionId, executedAt,
          );
          const pureCutCost = Number((originalCostExact * BigInt(Number(reservation.cut_length_total_mm)) + currentLength / 2n) / currentLength);
          this.db.prepare(`INSERT INTO profile_cut_waste_facts (
            id,execution_id,product_id,inventory_lot_id,source_location_id,source_package_id,waste_length_mm,
            cost_absorbed_by_deliverables_minor,inventory_ledger_event_id,operation_id,occurred_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), executionId, reservation.product_id,
            reservation.inventory_lot_id, sourceLocation.location_id, sourcePackageId, kerf,
            Math.max(0, consumedCost - pureCutCost), ledgerId, operationId, executedAt);
          this.db.prepare(`UPDATE products SET central_stock=(SELECT COALESCE(SUM(on_hand_base_int),0) FROM inventory_lots WHERE product_id=?),updated_at=? WHERE id=?`)
            .run(reservation.product_id, executedAt, reservation.product_id);
          enqueueCanonicalChannelChanges(this.db, { productId: reservation.product_id, kinds: ["STOCK"], operationId, occurredAt: executedAt });
        }
        this.db.prepare("UPDATE profile_piece_reservations SET status='EXECUTED',updated_at=? WHERE id=?").run(executedAt, reservation.id);
        executions.push({ executionId, sourcePieceId: reservation.profile_piece_id,
          deliverableLengthMm: Number(reservation.cut_length_total_mm), kerfWasteLengthMm: kerf,
          consumedLengthMm: Number(reservation.consumed_length_mm), remnantLengthMm: Number(reservation.planned_remnant_length_mm),
          consumedCostMinor: consumedCost, remnantCostMinor: remnantCost });
      }
      this.assertRepresented();
      return { reservationId, operationId, executions };
    }).immediate();
  }

  private executionResult(reservationId: string, operationId: string) {
    const executions = (this.db.prepare(`SELECT e.id AS executionId,e.source_piece_id AS sourcePieceId,
      e.cut_length_total_mm AS deliverableLengthMm,e.kerf_total_mm AS kerfWasteLengthMm,
      e.consumed_length_mm AS consumedLengthMm,e.remnant_length_mm AS remnantLengthMm,
      e.consumed_cost_minor AS consumedCostMinor,e.remnant_cost_minor AS remnantCostMinor
      FROM profile_cut_executions e JOIN profile_piece_reservations r ON r.id=e.profile_piece_reservation_id
      WHERE r.reservation_id=? AND e.operation_id=? ORDER BY e.id`).all(reservationId, operationId) as any[]);
    return { reservationId, operationId, executions };
  }
}

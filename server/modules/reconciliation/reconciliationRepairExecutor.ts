import type Database from "better-sqlite3";
import { InventoryService } from "../inventory/inventoryService.js";
import { ReconciliationError, ReconciliationService } from "./reconciliationService.js";

export const REGISTERED_RECONCILIATION_REPAIR_COMMANDS = ["inventory.release-reservation.v1"] as const;

const snapshotReservation = (db: Database.Database, reservationId: string) => ({
  reservation: db.prepare("SELECT id,order_id,status,release_operation_id,release_reason,released_at FROM inventory_reservations WHERE id=?").get(reservationId) || null,
  lots: db.prepare(`SELECT a.lot_id,a.product_id,a.quantity_base_int,l.on_hand_base_int,l.reserved_base_int
    FROM inventory_reservation_allocations a JOIN inventory_lots l ON l.id=a.lot_id
    WHERE a.reservation_id=? ORDER BY a.lot_id`).all(reservationId),
});

export class ReconciliationRepairExecutor {
  constructor(private readonly db: Database.Database, private readonly reconciliation = new ReconciliationService(db)) {}

  execute(input: { proposalId:string; actorId:string; operationId:string }) {
    const proposal = this.db.prepare(`SELECT p.*,f.code,f.source_ref FROM reconciliation_repair_proposals p
      JOIN reconciliation_findings f ON f.id=p.finding_id WHERE p.id=?`).get(input.proposalId) as any;
    if (!proposal || proposal.status !== "APPROVED") {
      throw new ReconciliationError("REPAIR_STATE_CONFLICT", "Repair must be approved before execution.", 409);
    }
    if (!REGISTERED_RECONCILIATION_REPAIR_COMMANDS.includes(proposal.command_type as any)) {
      throw new ReconciliationError("REPAIR_COMMAND_UNSUPPORTED", `Approved repair command ${proposal.command_type} is not registered; no mutation was executed.`, 409);
    }
    if (proposal.command_type === "inventory.release-reservation.v1") {
      if (proposal.code !== "INVENTORY_RESERVED_MISMATCH") {
        throw new ReconciliationError("REPAIR_SCOPE_MISMATCH", "Reservation release is only registered for an inventory reserved-balance finding.", 409);
      }
      const payload = JSON.parse(proposal.command_payload_json) as { reservationId?: unknown };
      const reservationId = typeof payload.reservationId === "string" ? payload.reservationId.trim() : "";
      if (!reservationId) throw new ReconciliationError("REPAIR_PAYLOAD_INVALID", "reservationId is required.", 400);
      const linked = this.db.prepare(`SELECT 1 FROM inventory_reservation_allocations
        WHERE reservation_id=? AND lot_id=? LIMIT 1`).get(reservationId, proposal.source_ref);
      if (!linked) throw new ReconciliationError("REPAIR_SCOPE_MISMATCH", "Reservation does not affect the finding's exact lot.", 409);
      return this.db.transaction(() => {
        const before = snapshotReservation(this.db, reservationId);
        new InventoryService(this.db).releaseReservation({ reservationId, reason: proposal.reason, operationId: input.operationId });
        const after = snapshotReservation(this.db, reservationId);
        return this.reconciliation.markRepairApplied({ proposalId: proposal.id, before, after,
          reason: proposal.reason, actorId: input.actorId, operationId: input.operationId });
      }).immediate();
    }
    throw new ReconciliationError("REPAIR_COMMAND_UNSUPPORTED", "No registered authoritative repair command matched.", 409);
  }
}

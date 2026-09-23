import type Database from "better-sqlite3";

export type ReconciliationBlockScope = "SKU" | "ORDER";

export class ReconciliationScopeGuard {
  constructor(private readonly db: Database.Database) {}

  isBlocked(type: ReconciliationBlockScope, id: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM reconciliation_blocks
      WHERE affected_type=? AND affected_id=? AND status='ACTIVE' LIMIT 1`).get(type, id));
  }

  assertAllowed(type: ReconciliationBlockScope, id: string, error: (message: string) => Error) {
    if (this.isBlocked(type, id)) {
      throw error(`${type} ${id} has an active critical reconciliation finding.`);
    }
  }

  assertOrderForReservation(reservationId: string, error: (message: string) => Error) {
    const row = this.db.prepare("SELECT order_id FROM inventory_reservations WHERE id=?").get(reservationId) as { order_id: string } | undefined;
    if (row) this.assertAllowed("ORDER", row.order_id, error);
  }

  assertOrderForShipment(shipmentId: string, error: (message: string) => Error) {
    const row = this.db.prepare("SELECT order_id FROM shipment_preparations WHERE id=?").get(shipmentId) as { order_id: string } | undefined;
    if (row) this.assertAllowed("ORDER", row.order_id, error);
  }

  assertShipmentSkus(shipmentId: string, error: (message: string) => Error) {
    const row = this.db.prepare("SELECT reservation_id FROM shipment_preparations WHERE id=?").get(shipmentId) as { reservation_id: string } | undefined;
    if (row) this.assertReservationSkus(row.reservation_id, error);
  }

  assertOrderForReturn(returnId: string, error: (message: string) => Error) {
    const row = this.db.prepare("SELECT sale_id FROM return_requests WHERE id=?").get(returnId) as { sale_id: string } | undefined;
    if (row) this.assertAllowed("ORDER", row.sale_id, error);
  }

  assertReservationSkus(reservationId: string, error: (message: string) => Error) {
    const rows = this.db.prepare(`SELECT DISTINCT COALESCE(NULLIF(p.sku,''),p.id) affected_id
      FROM inventory_reservation_lines l JOIN products p ON p.id=l.product_id WHERE l.reservation_id=?`).all(reservationId) as Array<{ affected_id: string }>;
    for (const row of rows) this.assertAllowed("SKU", row.affected_id, error);
  }
}

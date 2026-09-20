// Frozen schema body for forward-only V2-07 migration v69.
export const INVENTORY_SCHEMA_V69 = `
  CREATE TABLE inventory_lots (
    id                           TEXT PRIMARY KEY,
    receipt_id                   TEXT NOT NULL UNIQUE,
    acquisition_cost_snapshot_id TEXT NOT NULL UNIQUE,
    purchase_order_id            TEXT NOT NULL,
    purchase_line_id             TEXT NOT NULL,
    product_id                   TEXT NOT NULL,
    base_uom_code_snapshot       TEXT NOT NULL,
    received_quantity_base_int   INTEGER NOT NULL CHECK(received_quantity_base_int > 0),
    on_hand_base_int             INTEGER NOT NULL CHECK(on_hand_base_int >= 0),
    reserved_base_int            INTEGER NOT NULL DEFAULT 0 CHECK(reserved_base_int >= 0),
    status                       TEXT NOT NULL DEFAULT 'USABLE' CHECK(status IN ('USABLE','STOCK_DISCREPANCY')),
    received_at                  DATETIME NOT NULL,
    receipt_operation_id         TEXT NOT NULL,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(reserved_base_int <= on_hand_base_int),
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE inventory_ledger_events (
    id                         TEXT PRIMARY KEY,
    operation_id               TEXT NOT NULL,
    event_type                 TEXT NOT NULL CHECK(event_type IN ('RECEIPT','DISPATCH','CORRECTION')),
    product_id                 TEXT NOT NULL,
    lot_id                     TEXT NOT NULL,
    reservation_id             TEXT,
    order_id                   TEXT,
    shipment_id                TEXT,
    quantity_delta_base_int    INTEGER NOT NULL CHECK(quantity_delta_base_int <> 0),
    base_uom_code_snapshot     TEXT NOT NULL,
    reason_code                TEXT NOT NULL,
    reference_type             TEXT NOT NULL,
    reference_id               TEXT NOT NULL,
    occurred_at                DATETIME NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(event_type, reference_type, reference_id, lot_id),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );

  CREATE TABLE inventory_lot_location_balances (
    id                    TEXT PRIMARY KEY,
    lot_id                TEXT NOT NULL,
    location_id           TEXT NOT NULL,
    location_kind         TEXT NOT NULL CHECK(location_kind IN ('PICKING','RESERVE')),
    quantity_base_int     INTEGER NOT NULL CHECK(quantity_base_int >= 0),
    active                INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    physical_state        TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK(physical_state IN ('CONFIRMED','MISSING')),
    discrepancy_reason    TEXT,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lot_id, location_id),
    FOREIGN KEY(lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );

  CREATE TABLE inventory_reservations (
    id                       TEXT PRIMARY KEY,
    order_id                 TEXT NOT NULL UNIQUE,
    status                   TEXT NOT NULL DEFAULT 'ACTIVE'
                             CHECK(status IN ('ACTIVE','PICKED','PACKED','RELEASED','DISPATCHED','STOCK_DISCREPANCY')),
    reserve_operation_id     TEXT NOT NULL,
    release_operation_id     TEXT,
    dispatch_operation_id    TEXT,
    shipment_id              TEXT UNIQUE,
    release_reason           TEXT,
    created_at               DATETIME NOT NULL,
    picked_at                DATETIME,
    packed_at                DATETIME,
    released_at              DATETIME,
    dispatched_at            DATETIME,
    updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE inventory_reservation_lines (
    id                         TEXT PRIMARY KEY,
    reservation_id             TEXT NOT NULL,
    product_id                 TEXT NOT NULL,
    quantity_base_int          INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot     TEXT NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reservation_id, product_id),
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE inventory_reservation_allocations (
    id                         TEXT PRIMARY KEY,
    reservation_id             TEXT NOT NULL,
    reservation_line_id        TEXT NOT NULL,
    product_id                 TEXT NOT NULL,
    lot_id                     TEXT NOT NULL,
    quantity_base_int          INTEGER NOT NULL CHECK(quantity_base_int > 0),
    fifo_sequence              INTEGER NOT NULL CHECK(fifo_sequence >= 0),
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reservation_id, reservation_line_id, lot_id),
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
    FOREIGN KEY(reservation_line_id) REFERENCES inventory_reservation_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_inventory_lots_product_fifo ON inventory_lots(product_id, received_at, id);
  CREATE INDEX idx_inventory_ledger_product ON inventory_ledger_events(product_id, occurred_at, id);
  CREATE INDEX idx_inventory_ledger_lot ON inventory_ledger_events(lot_id, occurred_at, id);
  CREATE INDEX idx_inventory_locations_lot_kind ON inventory_lot_location_balances(lot_id, location_kind, active, physical_state);
  CREATE INDEX idx_inventory_reservations_status ON inventory_reservations(status, created_at, id);
  CREATE INDEX idx_inventory_allocations_lot ON inventory_reservation_allocations(lot_id, reservation_id);

  CREATE TRIGGER trg_inventory_ledger_immutable_update BEFORE UPDATE ON inventory_ledger_events
    BEGIN SELECT RAISE(ABORT, 'inventory ledger events are immutable'); END;
  CREATE TRIGGER trg_inventory_ledger_immutable_delete BEFORE DELETE ON inventory_ledger_events
    BEGIN SELECT RAISE(ABORT, 'inventory ledger events are immutable'); END;
  CREATE TRIGGER trg_inventory_lot_identity_immutable BEFORE UPDATE OF
    receipt_id,acquisition_cost_snapshot_id,purchase_order_id,purchase_line_id,product_id,
    base_uom_code_snapshot,received_quantity_base_int,received_at,receipt_operation_id,created_at
    ON inventory_lots BEGIN SELECT RAISE(ABORT, 'inventory lot receipt and cost identity are immutable'); END;
  CREATE TRIGGER trg_inventory_lot_no_delete BEFORE DELETE ON inventory_lots
    BEGIN SELECT RAISE(ABORT, 'inventory lots cannot be deleted'); END;
  CREATE TRIGGER trg_inventory_reservation_line_immutable_update BEFORE UPDATE ON inventory_reservation_lines
    BEGIN SELECT RAISE(ABORT, 'inventory reservation lines are immutable'); END;
  CREATE TRIGGER trg_inventory_reservation_line_immutable_delete BEFORE DELETE ON inventory_reservation_lines
    BEGIN SELECT RAISE(ABORT, 'inventory reservation lines are immutable'); END;
  CREATE TRIGGER trg_inventory_allocation_immutable_update BEFORE UPDATE ON inventory_reservation_allocations
    BEGIN SELECT RAISE(ABORT, 'inventory reservation allocations are immutable'); END;
  CREATE TRIGGER trg_inventory_allocation_immutable_delete BEFORE DELETE ON inventory_reservation_allocations
    BEGIN SELECT RAISE(ABORT, 'inventory reservation allocations are immutable'); END;
  CREATE TRIGGER trg_inventory_central_stock_projection_guard BEFORE UPDATE OF central_stock ON products
    WHEN NEW.central_stock <> COALESCE((SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id=NEW.id),0)
    BEGIN SELECT RAISE(ABORT, 'products.central_stock is an inventory projection'); END;
  CREATE TRIGGER trg_inventory_central_stock_insert_guard BEFORE INSERT ON products
    WHEN COALESCE(NEW.central_stock,0) <> 0
    BEGIN SELECT RAISE(ABORT, 'products.central_stock is an inventory projection'); END;
`;

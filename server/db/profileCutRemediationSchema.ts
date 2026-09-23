// Forward-only V2-11 remediation schema for migration v78. Migration v77 is
// frozen; these records add explicit kerf waste, cut-location provenance,
// returned-piece provenance, and fail-closed legacy representation evidence.
export const PROFILE_CUT_REMEDIATION_SCHEMA_V78 = `
  CREATE TABLE profile_cut_waste_facts (
    id                                  TEXT PRIMARY KEY,
    execution_id                        TEXT NOT NULL UNIQUE,
    product_id                          TEXT NOT NULL,
    inventory_lot_id                    TEXT NOT NULL,
    source_location_id                  TEXT NOT NULL,
    source_package_id                   TEXT,
    waste_length_mm                     INTEGER NOT NULL CHECK(waste_length_mm > 0),
    cost_absorbed_by_deliverables_minor INTEGER NOT NULL CHECK(cost_absorbed_by_deliverables_minor >= 0),
    inventory_ledger_event_id            TEXT NOT NULL UNIQUE,
    operation_id                        TEXT NOT NULL,
    occurred_at                         DATETIME NOT NULL,
    created_at                          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(execution_id) REFERENCES profile_cut_executions(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_ledger_event_id) REFERENCES inventory_ledger_events(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_return_piece_restorations (
    id                                     TEXT PRIMARY KEY,
    return_receipt_inventory_allocation_id TEXT NOT NULL,
    source_delivery_piece_id               TEXT NOT NULL UNIQUE,
    returned_piece_id                      TEXT NOT NULL UNIQUE,
    inventory_lot_id                       TEXT NOT NULL,
    location_id                            TEXT NOT NULL,
    warehouse_package_id                   TEXT NOT NULL,
    length_mm                              INTEGER NOT NULL CHECK(length_mm > 0),
    historical_cost_minor                  INTEGER NOT NULL CHECK(historical_cost_minor >= 0),
    operation_id                           TEXT NOT NULL,
    restored_at                            DATETIME NOT NULL,
    created_at                             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(return_receipt_inventory_allocation_id) REFERENCES return_receipt_inventory_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_delivery_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT,
    FOREIGN KEY(returned_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(warehouse_package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_piece_migration_blocks (
    inventory_lot_id TEXT PRIMARY KEY,
    product_id       TEXT NOT NULL,
    reason_code      TEXT NOT NULL,
    detected_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_profile_cut_waste_lot ON profile_cut_waste_facts(inventory_lot_id,occurred_at,id);
  CREATE INDEX idx_profile_return_pieces_allocation ON profile_return_piece_restorations(return_receipt_inventory_allocation_id,id);

  CREATE TRIGGER trg_profile_cut_waste_immutable_update BEFORE UPDATE ON profile_cut_waste_facts
    BEGIN SELECT RAISE(ABORT, 'profile cut waste facts are immutable'); END;
  CREATE TRIGGER trg_profile_cut_waste_immutable_delete BEFORE DELETE ON profile_cut_waste_facts
    BEGIN SELECT RAISE(ABORT, 'profile cut waste facts are immutable'); END;
  CREATE TRIGGER trg_profile_return_piece_immutable_update BEFORE UPDATE ON profile_return_piece_restorations
    BEGIN SELECT RAISE(ABORT, 'profile return piece restorations are immutable'); END;
  CREATE TRIGGER trg_profile_return_piece_immutable_delete BEFORE DELETE ON profile_return_piece_restorations
    BEGIN SELECT RAISE(ABORT, 'profile return piece restorations are immutable'); END;
  CREATE TRIGGER trg_profile_piece_migration_block_immutable_update BEFORE UPDATE ON profile_piece_migration_blocks
    BEGIN SELECT RAISE(ABORT, 'profile piece migration blocks require an approved repair'); END;
  CREATE TRIGGER trg_profile_piece_migration_block_immutable_delete BEFORE DELETE ON profile_piece_migration_blocks
    BEGIN SELECT RAISE(ABORT, 'profile piece migration blocks require an approved repair'); END;
  CREATE TRIGGER trg_profile_cut_output_requires_piece BEFORE INSERT ON profile_cut_outputs
    WHEN NEW.output_kind='CUT' AND NEW.inventory_piece_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'profile cut output requires a physical inventory piece'); END;
`;

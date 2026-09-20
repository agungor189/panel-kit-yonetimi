// Frozen schema body for forward-only V2-08 migration v71.
export const WAREHOUSE_EXECUTION_SCHEMA_V71 = `
  CREATE TABLE warehouse_topologies (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    code_template     TEXT NOT NULL,
    config_json       TEXT NOT NULL,
    config_hash       TEXT NOT NULL UNIQUE,
    active            INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX idx_warehouse_topologies_one_active
    ON warehouse_topologies(active) WHERE active=1;

  CREATE TABLE warehouse_rack_configs (
    id                    TEXT PRIMARY KEY,
    topology_id           TEXT NOT NULL,
    rack_code             TEXT NOT NULL,
    level_count           INTEGER NOT NULL CHECK(level_count > 0),
    position_count        INTEGER NOT NULL CHECK(position_count > 0),
    depth_count           INTEGER NOT NULL CHECK(depth_count > 0),
    role                  TEXT NOT NULL CHECK(role IN ('PICKING','RESERVE','MIXED','QUARANTINE')),
    allow_mixed_sku       INTEGER NOT NULL CHECK(allow_mixed_sku IN (0,1)),
    allow_mixed_lot       INTEGER NOT NULL CHECK(allow_mixed_lot IN (0,1)),
    max_weight_grams      INTEGER CHECK(max_weight_grams IS NULL OR max_weight_grams > 0),
    placement_priority    INTEGER NOT NULL,
    last_resort           INTEGER NOT NULL DEFAULT 0 CHECK(last_resort IN (0,1)),
    active                INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    config_json           TEXT NOT NULL,
    UNIQUE(topology_id,rack_code),
    FOREIGN KEY(topology_id) REFERENCES warehouse_topologies(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_level_configs (
    id                    TEXT PRIMARY KEY,
    topology_id           TEXT NOT NULL,
    rack_code             TEXT NOT NULL,
    level_number          INTEGER NOT NULL CHECK(level_number > 0),
    role                  TEXT NOT NULL CHECK(role IN ('PICKING','RESERVE','MIXED','QUARANTINE')),
    allow_mixed_sku       INTEGER NOT NULL CHECK(allow_mixed_sku IN (0,1)),
    allow_mixed_lot       INTEGER NOT NULL CHECK(allow_mixed_lot IN (0,1)),
    max_weight_grams      INTEGER CHECK(max_weight_grams IS NULL OR max_weight_grams > 0),
    placement_priority    INTEGER NOT NULL,
    last_resort           INTEGER NOT NULL DEFAULT 0 CHECK(last_resort IN (0,1)),
    heavy_penalty         INTEGER NOT NULL DEFAULT 0 CHECK(heavy_penalty >= 0),
    active                INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    UNIQUE(topology_id,rack_code,level_number),
    FOREIGN KEY(topology_id,rack_code) REFERENCES warehouse_rack_configs(topology_id,rack_code) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_position_configs (
    id                    TEXT PRIMARY KEY,
    topology_id           TEXT NOT NULL,
    rack_code             TEXT NOT NULL,
    level_number          INTEGER NOT NULL CHECK(level_number > 0),
    position_number       INTEGER NOT NULL CHECK(position_number > 0),
    role                  TEXT NOT NULL CHECK(role IN ('PICKING','RESERVE','MIXED','QUARANTINE')),
    allow_mixed_sku       INTEGER NOT NULL CHECK(allow_mixed_sku IN (0,1)),
    allow_mixed_lot       INTEGER NOT NULL CHECK(allow_mixed_lot IN (0,1)),
    max_weight_grams      INTEGER CHECK(max_weight_grams IS NULL OR max_weight_grams > 0),
    placement_priority    INTEGER NOT NULL,
    last_resort           INTEGER NOT NULL DEFAULT 0 CHECK(last_resort IN (0,1)),
    heavy_penalty         INTEGER NOT NULL DEFAULT 0 CHECK(heavy_penalty >= 0),
    active                INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    UNIQUE(topology_id,rack_code,level_number,position_number),
    FOREIGN KEY(topology_id,rack_code,level_number)
      REFERENCES warehouse_level_configs(topology_id,rack_code,level_number) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_location_slots (
    id                    TEXT PRIMARY KEY,
    topology_id           TEXT NOT NULL,
    code                  TEXT NOT NULL UNIQUE,
    rack_code             TEXT NOT NULL,
    level_number          INTEGER NOT NULL CHECK(level_number > 0),
    position_number       INTEGER NOT NULL CHECK(position_number > 0),
    depth_code            TEXT NOT NULL,
    depth_index           INTEGER NOT NULL CHECK(depth_index >= 0),
    is_front              INTEGER NOT NULL CHECK(is_front IN (0,1)),
    role                  TEXT NOT NULL CHECK(role IN ('PICKING','RESERVE','MIXED','QUARANTINE')),
    allow_mixed_sku       INTEGER NOT NULL CHECK(allow_mixed_sku IN (0,1)),
    allow_mixed_lot       INTEGER NOT NULL CHECK(allow_mixed_lot IN (0,1)),
    max_weight_grams      INTEGER CHECK(max_weight_grams IS NULL OR max_weight_grams > 0),
    placement_priority    INTEGER NOT NULL,
    last_resort           INTEGER NOT NULL DEFAULT 0 CHECK(last_resort IN (0,1)),
    heavy_penalty         INTEGER NOT NULL DEFAULT 0 CHECK(heavy_penalty >= 0),
    active                INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    UNIQUE(topology_id,rack_code,level_number,position_number,depth_code),
    FOREIGN KEY(topology_id,rack_code,level_number,position_number)
      REFERENCES warehouse_position_configs(topology_id,rack_code,level_number,position_number) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_execution_settings (
    id                              TEXT PRIMARY KEY CHECK(id='default'),
    watch_threshold_pct             INTEGER NOT NULL CHECK(watch_threshold_pct BETWEEN 0 AND 100),
    prepare_threshold_pct           INTEGER NOT NULL CHECK(prepare_threshold_pct BETWEEN 0 AND 100),
    heavy_package_threshold_grams   INTEGER NOT NULL CHECK(heavy_package_threshold_grams > 0),
    updated_at                      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(prepare_threshold_pct <= watch_threshold_pct)
  );

  CREATE TABLE warehouse_excess_approvals (
    id                                  TEXT PRIMARY KEY,
    acquisition_cost_snapshot_id        TEXT NOT NULL,
    maximum_accepted_quantity_base_int  INTEGER NOT NULL CHECK(maximum_accepted_quantity_base_int > 0),
    reason                              TEXT NOT NULL,
    approval_operation_id               TEXT NOT NULL UNIQUE,
    approved_at                         DATETIME NOT NULL,
    receipt_id                          TEXT UNIQUE,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_goods_receipts (
    id                           TEXT PRIMARY KEY,
    receipt_series_id            TEXT NOT NULL,
    stage_index                  INTEGER NOT NULL CHECK(stage_index > 0),
    is_final                     INTEGER NOT NULL CHECK(is_final IN (0,1)),
    partial_policy               TEXT NOT NULL DEFAULT 'DISABLED' CHECK(partial_policy IN ('DISABLED','FUTURE_ENABLED')),
    acquisition_cost_snapshot_id TEXT NOT NULL,
    purchase_order_id            TEXT NOT NULL,
    purchase_line_id             TEXT NOT NULL,
    product_id                   TEXT NOT NULL,
    supplier_lot_code            TEXT NOT NULL,
    base_uom_code_snapshot       TEXT NOT NULL,
    expected_quantity_base_int   INTEGER NOT NULL CHECK(expected_quantity_base_int > 0),
    accepted_quantity_base_int   INTEGER NOT NULL CHECK(accepted_quantity_base_int >= 0),
    damaged_quantity_base_int    INTEGER NOT NULL CHECK(damaged_quantity_base_int >= 0),
    variance_quantity_base_int   INTEGER NOT NULL,
    shortage_quantity_base_int   INTEGER NOT NULL CHECK(shortage_quantity_base_int >= 0),
    excess_quantity_base_int     INTEGER NOT NULL CHECK(excess_quantity_base_int >= 0),
    excess_approval_id           TEXT,
    inventory_lot_id             TEXT UNIQUE,
    status                       TEXT NOT NULL CHECK(status IN ('ACCEPTED','ACCEPTED_WITH_VARIANCE','QUARANTINE_ONLY')),
    receipt_operation_id         TEXT NOT NULL UNIQUE,
    received_at                  DATETIME NOT NULL,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(receipt_series_id,stage_index),
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(excess_approval_id) REFERENCES warehouse_excess_approvals(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_execution_packages (
    id                         TEXT PRIMARY KEY,
    package_code               TEXT NOT NULL UNIQUE,
    receipt_id                 TEXT NOT NULL,
    inventory_lot_id           TEXT,
    product_id                 TEXT NOT NULL,
    supplier_lot_code          TEXT NOT NULL,
    purchase_order_id          TEXT NOT NULL,
    purchase_line_id           TEXT NOT NULL,
    acquisition_cost_snapshot_id TEXT NOT NULL,
    base_uom_code_snapshot     TEXT NOT NULL,
    initial_quantity_base_int  INTEGER NOT NULL CHECK(initial_quantity_base_int > 0),
    remaining_quantity_base_int INTEGER NOT NULL CHECK(remaining_quantity_base_int >= 0),
    target_quantity_base_int   INTEGER NOT NULL CHECK(target_quantity_base_int > 0),
    weight_grams               INTEGER NOT NULL DEFAULT 0 CHECK(weight_grams >= 0),
    disposition                TEXT NOT NULL CHECK(disposition IN ('ACCEPTED','DAMAGED')),
    label_identity             TEXT UNIQUE,
    status                     TEXT NOT NULL CHECK(status IN ('RECEIVED','LABELED','PICKING','RESERVE','QUARANTINE','DISCREPANCY')),
    current_slot_id            TEXT,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK((disposition='DAMAGED' AND inventory_lot_id IS NULL AND status IN ('QUARANTINE','DISCREPANCY'))
       OR (disposition='ACCEPTED' AND inventory_lot_id IS NOT NULL)),
    FOREIGN KEY(receipt_id) REFERENCES warehouse_goods_receipts(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(current_slot_id) REFERENCES warehouse_location_slots(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_package_movements_v2 (
    id                    TEXT PRIMARY KEY,
    operation_id          TEXT NOT NULL UNIQUE,
    movement_type         TEXT NOT NULL CHECK(movement_type IN ('PLACEMENT','MOVE','REPLENISHMENT')),
    package_id            TEXT NOT NULL,
    inventory_lot_id      TEXT NOT NULL,
    product_id            TEXT NOT NULL,
    quantity_base_int     INTEGER NOT NULL CHECK(quantity_base_int > 0),
    from_location_id      TEXT NOT NULL,
    to_location_id        TEXT NOT NULL,
    moved_at              DATETIME NOT NULL,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_replenishment_tasks (
    id                    TEXT PRIMARY KEY,
    operation_id          TEXT NOT NULL UNIQUE,
    product_id            TEXT NOT NULL,
    inventory_lot_id      TEXT NOT NULL,
    pick_package_id       TEXT,
    source_package_id     TEXT,
    target_slot_id        TEXT,
    threshold_pct         INTEGER NOT NULL,
    current_pct           INTEGER NOT NULL,
    status                TEXT NOT NULL CHECK(status IN ('LOW_WATCH','PREPARE_REPLENISHMENT','STOCK_DISCREPANCY','COMPLETED','CANCELLED')),
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at          DATETIME,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(pick_package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(target_slot_id) REFERENCES warehouse_location_slots(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_stock_discrepancies_v2 (
    id                    TEXT PRIMARY KEY,
    operation_id          TEXT NOT NULL UNIQUE,
    product_id            TEXT NOT NULL,
    inventory_lot_id      TEXT NOT NULL,
    package_id            TEXT,
    location_id           TEXT,
    reason                TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','COUNT_REQUIRED','RESOLVED')),
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at           DATETIME,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT
  );

  CREATE TABLE warehouse_stock_counts_v2 (
    id                    TEXT PRIMARY KEY,
    operation_id          TEXT NOT NULL UNIQUE,
    package_id            TEXT NOT NULL,
    inventory_lot_id      TEXT NOT NULL,
    location_id           TEXT NOT NULL,
    expected_quantity_base_int INTEGER NOT NULL CHECK(expected_quantity_base_int >= 0),
    observed_quantity_base_int INTEGER NOT NULL CHECK(observed_quantity_base_int >= 0),
    difference_base_int   INTEGER NOT NULL,
    reason                TEXT NOT NULL,
    status                TEXT NOT NULL CHECK(status IN ('MATCHED','PENDING_APPROVAL','APPROVED')),
    approval_reference    TEXT,
    approval_operation_id TEXT UNIQUE,
    counted_at            DATETIME NOT NULL,
    approved_at           DATETIME,
    FOREIGN KEY(package_id) REFERENCES warehouse_execution_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_warehouse_slots_candidate
    ON warehouse_location_slots(topology_id,active,last_resort,placement_priority,heavy_penalty,is_front,depth_index);
  CREATE INDEX idx_warehouse_packages_product_lot
    ON warehouse_execution_packages(product_id,inventory_lot_id,status,current_slot_id);
  CREATE INDEX idx_warehouse_movements_package
    ON warehouse_package_movements_v2(package_id,moved_at,id);
  CREATE INDEX idx_warehouse_replenishment_product
    ON warehouse_replenishment_tasks(product_id,status,created_at,id);
  CREATE INDEX idx_warehouse_discrepancies_lot
    ON warehouse_stock_discrepancies_v2(inventory_lot_id,status,created_at,id);

  CREATE TRIGGER trg_warehouse_receipt_immutable_update BEFORE UPDATE ON warehouse_goods_receipts
    BEGIN SELECT RAISE(ABORT, 'warehouse goods receipts are immutable'); END;
  CREATE TRIGGER trg_warehouse_receipt_immutable_delete BEFORE DELETE ON warehouse_goods_receipts
    BEGIN SELECT RAISE(ABORT, 'warehouse goods receipts are immutable'); END;
  CREATE TRIGGER trg_warehouse_excess_approval_no_delete BEFORE DELETE ON warehouse_excess_approvals
    BEGIN SELECT RAISE(ABORT, 'warehouse excess approvals cannot be deleted'); END;
  CREATE TRIGGER trg_warehouse_movement_immutable_update BEFORE UPDATE ON warehouse_package_movements_v2
    BEGIN SELECT RAISE(ABORT, 'warehouse package movements are immutable'); END;
  CREATE TRIGGER trg_warehouse_movement_immutable_delete BEFORE DELETE ON warehouse_package_movements_v2
    BEGIN SELECT RAISE(ABORT, 'warehouse package movements are immutable'); END;
`;

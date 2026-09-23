// Forward-only V2-10 reconciliation schema for migration v76. V71/V75 remain frozen.
export const WAREHOUSE_PACKAGE_ORIGIN_SCHEMA_V76 = `
  DROP INDEX idx_warehouse_packages_product_lot;
  PRAGMA legacy_alter_table=ON;
  ALTER TABLE warehouse_execution_packages RENAME TO warehouse_execution_packages_v75;

  CREATE TABLE warehouse_execution_packages (
    id                                   TEXT PRIMARY KEY,
    package_code                         TEXT NOT NULL UNIQUE,
    origin_type                          TEXT NOT NULL DEFAULT 'GOODS_RECEIPT'
                                             CHECK(origin_type IN ('GOODS_RECEIPT','RETURN_RECEIPT')),
    receipt_id                           TEXT,
    return_receipt_id                    TEXT,
    return_receipt_inventory_allocation_id TEXT UNIQUE,
    origin_inventory_lot_id              TEXT,
    inventory_lot_id                     TEXT,
    product_id                           TEXT NOT NULL,
    supplier_lot_code                    TEXT NOT NULL,
    purchase_order_id                    TEXT NOT NULL,
    purchase_line_id                     TEXT NOT NULL,
    acquisition_cost_snapshot_id         TEXT NOT NULL,
    base_uom_code_snapshot               TEXT NOT NULL,
    initial_quantity_base_int            INTEGER NOT NULL CHECK(initial_quantity_base_int > 0),
    remaining_quantity_base_int          INTEGER NOT NULL CHECK(remaining_quantity_base_int >= 0),
    target_quantity_base_int             INTEGER NOT NULL CHECK(target_quantity_base_int > 0),
    weight_grams                         INTEGER NOT NULL DEFAULT 0 CHECK(weight_grams >= 0),
    disposition                          TEXT NOT NULL CHECK(disposition IN ('ACCEPTED','DAMAGED')),
    label_identity                       TEXT UNIQUE,
    status                               TEXT NOT NULL CHECK(status IN ('RECEIVED','LABELED','PICKING','RESERVE','QUARANTINE','DISCREPANCY')),
    current_slot_id                      TEXT,
    created_at                           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK((origin_type='GOODS_RECEIPT' AND receipt_id IS NOT NULL
             AND return_receipt_id IS NULL AND return_receipt_inventory_allocation_id IS NULL)
       OR (origin_type='RETURN_RECEIPT' AND receipt_id IS NULL
             AND return_receipt_id IS NOT NULL AND return_receipt_inventory_allocation_id IS NOT NULL
             AND origin_inventory_lot_id IS NOT NULL)),
    CHECK((disposition='DAMAGED' AND inventory_lot_id IS NULL AND status IN ('QUARANTINE','DISCREPANCY'))
       OR (disposition='ACCEPTED' AND inventory_lot_id IS NOT NULL)),
    CHECK(origin_type<>'RETURN_RECEIPT' OR disposition<>'ACCEPTED' OR inventory_lot_id=origin_inventory_lot_id),
    FOREIGN KEY(receipt_id) REFERENCES warehouse_goods_receipts(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_receipt_id) REFERENCES return_receipts(id) ON DELETE RESTRICT,
    FOREIGN KEY(return_receipt_inventory_allocation_id) REFERENCES return_receipt_inventory_allocations(id) ON DELETE RESTRICT,
    FOREIGN KEY(origin_inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(current_slot_id) REFERENCES warehouse_location_slots(id) ON DELETE RESTRICT
  );

  INSERT INTO warehouse_execution_packages (
    id,package_code,origin_type,receipt_id,origin_inventory_lot_id,inventory_lot_id,product_id,
    supplier_lot_code,purchase_order_id,purchase_line_id,acquisition_cost_snapshot_id,base_uom_code_snapshot,
    initial_quantity_base_int,remaining_quantity_base_int,target_quantity_base_int,weight_grams,disposition,
    label_identity,status,current_slot_id,created_at,updated_at
  ) SELECT id,package_code,'GOODS_RECEIPT',receipt_id,inventory_lot_id,inventory_lot_id,product_id,
    supplier_lot_code,purchase_order_id,purchase_line_id,acquisition_cost_snapshot_id,base_uom_code_snapshot,
    initial_quantity_base_int,remaining_quantity_base_int,target_quantity_base_int,weight_grams,disposition,
    label_identity,status,current_slot_id,created_at,updated_at
    FROM warehouse_execution_packages_v75;

  DROP TABLE warehouse_execution_packages_v75;
  PRAGMA legacy_alter_table=OFF;
  CREATE INDEX idx_warehouse_packages_product_lot
    ON warehouse_execution_packages(product_id,inventory_lot_id,status,current_slot_id);
  CREATE INDEX idx_warehouse_packages_return_origin
    ON warehouse_execution_packages(return_receipt_id,return_receipt_inventory_allocation_id);
`;

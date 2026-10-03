// Forward-only purchase-line packing snapshot for the standard one-SKU-per-box flow.
// Historical purchase lines and acquisition-cost snapshots remain authoritative.
export const PROCUREMENT_PACKING_SCHEMA_V95 = `
  CREATE TABLE purchase_line_packing_snapshots (
    purchase_line_id       TEXT PRIMARY KEY,
    purchase_order_id      TEXT NOT NULL,
    supplier_no            TEXT NOT NULL,
    product_type_snapshot  TEXT NOT NULL,
    size_snapshot          TEXT,
    material_snapshot      TEXT,
    profile_type_snapshot  TEXT,
    name_en_snapshot       TEXT,
    name_tr_snapshot       TEXT,
    total_quantity         INTEGER NOT NULL CHECK(total_quantity > 0),
    box_count              INTEGER NOT NULL CHECK(box_count > 0),
    units_per_box          INTEGER NOT NULL CHECK(units_per_box > 0),
    box_weight_grams       INTEGER NOT NULL CHECK(box_weight_grams > 0),
    total_weight_grams     INTEGER NOT NULL CHECK(total_weight_grams > 0),
    part_weight_milligrams INTEGER NOT NULL CHECK(part_weight_milligrams > 0),
    created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(box_count * units_per_box = total_quantity),
    CHECK(ABS(box_count * box_weight_grams - total_weight_grams) <= 50),
    FOREIGN KEY(purchase_line_id) REFERENCES purchase_order_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_purchase_packing_order ON purchase_line_packing_snapshots(purchase_order_id);
  CREATE TRIGGER trg_purchase_packing_immutable_update
    BEFORE UPDATE ON purchase_line_packing_snapshots
    BEGIN SELECT RAISE(ABORT, 'purchase line packing snapshots are immutable'); END;
  CREATE TRIGGER trg_purchase_packing_immutable_delete
    BEFORE DELETE ON purchase_line_packing_snapshots
    BEGIN SELECT RAISE(ABORT, 'purchase line packing snapshots are immutable'); END;
`;

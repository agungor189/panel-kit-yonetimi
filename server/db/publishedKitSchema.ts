// Forward-only V2-11 schema for migration v77. Published kit snapshots and
// profile-piece provenance are canonical Panel-owned records.
export const PUBLISHED_KIT_SCHEMA_V77 = `
  CREATE TABLE kit_publication_settings (
    id              TEXT PRIMARY KEY CHECK(id = 'default'),
    kerf_mm         INTEGER NOT NULL CHECK(kerf_mm >= 0),
    formula_version TEXT NOT NULL,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO kit_publication_settings (id,kerf_mm,formula_version)
  VALUES ('default',3,'dsdst.kit-publication-cost.v1');

  CREATE TABLE published_kits (
    id                         TEXT PRIMARY KEY,
    workspace_kit_id           TEXT NOT NULL UNIQUE,
    product_id                 TEXT NOT NULL UNIQUE,
    sku                        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    current_version_id         TEXT UNIQUE,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE published_kit_versions (
    id                         TEXT PRIMARY KEY,
    published_kit_id           TEXT NOT NULL,
    version_number             INTEGER NOT NULL CHECK(version_number > 0),
    workspace_version_id       TEXT NOT NULL,
    authored_content_hash      TEXT NOT NULL CHECK(length(authored_content_hash) = 64),
    content_hash               TEXT NOT NULL UNIQUE CHECK(length(content_hash) = 64),
    core_policy_hash           TEXT NOT NULL CHECK(length(core_policy_hash) = 64),
    product_catalog_version    INTEGER NOT NULL CHECK(product_catalog_version > 0),
    product_catalog_version_ref TEXT NOT NULL,
    title_snapshot             TEXT NOT NULL,
    description_snapshot       TEXT,
    currency                   TEXT NOT NULL CHECK(length(currency) = 3),
    canonical_cost_minor       INTEGER NOT NULL CHECK(canonical_cost_minor >= 0),
    suggested_sale_price_minor INTEGER NOT NULL CHECK(suggested_sale_price_minor >= canonical_cost_minor),
    final_sale_price_minor     INTEGER NOT NULL CHECK(final_sale_price_minor >= canonical_cost_minor),
    cost_formula_version       TEXT NOT NULL,
    cost_provenance_json       TEXT NOT NULL,
    packaging_snapshot_json    TEXT NOT NULL,
    installation_guide_version TEXT NOT NULL,
    effective_kerf_mm          INTEGER NOT NULL CHECK(effective_kerf_mm >= 0),
    published_operation_id     TEXT NOT NULL,
    published_by_actor_id      TEXT NOT NULL,
    published_by_actor_name    TEXT,
    published_by_service_id    TEXT,
    published_at               DATETIME NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(published_kit_id, version_number),
    UNIQUE(published_kit_id, workspace_version_id),
    FOREIGN KEY(published_kit_id) REFERENCES published_kits(id) ON DELETE RESTRICT
  );

  CREATE TABLE published_kit_version_components (
    id                           TEXT PRIMARY KEY,
    published_kit_version_id     TEXT NOT NULL,
    component_sequence           INTEGER NOT NULL CHECK(component_sequence >= 0),
    component_product_id         TEXT NOT NULL,
    component_sku_snapshot       TEXT NOT NULL,
    component_title_snapshot     TEXT NOT NULL,
    component_catalog_version    INTEGER NOT NULL CHECK(component_catalog_version > 0),
    component_catalog_version_ref TEXT NOT NULL,
    component_role_snapshot      TEXT NOT NULL,
    quantity_base_int            INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot       TEXT NOT NULL,
    acquisition_cost_snapshot_id TEXT NOT NULL,
    unit_cost_numerator          INTEGER NOT NULL CHECK(unit_cost_numerator >= 0),
    unit_cost_denominator        INTEGER NOT NULL CHECK(unit_cost_denominator > 0),
    extended_cost_minor          INTEGER NOT NULL CHECK(extended_cost_minor >= 0),
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(published_kit_version_id, component_product_id),
    UNIQUE(published_kit_version_id, component_sequence),
    FOREIGN KEY(published_kit_version_id) REFERENCES published_kit_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT
  );

  CREATE TABLE published_kit_version_cuts (
    id                           TEXT PRIMARY KEY,
    published_kit_version_id     TEXT NOT NULL,
    cut_sequence                 INTEGER NOT NULL CHECK(cut_sequence >= 0),
    profile_product_id           TEXT NOT NULL,
    profile_catalog_version_ref  TEXT NOT NULL,
    quantity                     INTEGER NOT NULL CHECK(quantity > 0),
    length_mm                    INTEGER NOT NULL CHECK(length_mm > 0),
    kerf_mm                      INTEGER NOT NULL CHECK(kerf_mm >= 0),
    consumed_length_mm           INTEGER NOT NULL CHECK(consumed_length_mm > 0),
    label_snapshot               TEXT,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(published_kit_version_id, cut_sequence),
    FOREIGN KEY(published_kit_version_id) REFERENCES published_kit_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY(profile_product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE published_kit_version_packages (
    id                         TEXT PRIMARY KEY,
    published_kit_version_id   TEXT NOT NULL,
    package_number             INTEGER NOT NULL CHECK(package_number > 0),
    length_mm                  INTEGER CHECK(length_mm IS NULL OR length_mm > 0),
    width_mm                   INTEGER CHECK(width_mm IS NULL OR width_mm > 0),
    height_mm                  INTEGER CHECK(height_mm IS NULL OR height_mm > 0),
    target_weight_grams        INTEGER CHECK(target_weight_grams IS NULL OR target_weight_grams > 0),
    instruction_version       TEXT NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(published_kit_version_id, package_number),
    FOREIGN KEY(published_kit_version_id) REFERENCES published_kit_versions(id) ON DELETE RESTRICT
  );

  CREATE TABLE published_kit_version_package_items (
    id                         TEXT PRIMARY KEY,
    package_id                 TEXT NOT NULL,
    component_product_id       TEXT NOT NULL,
    quantity_base_int          INTEGER NOT NULL CHECK(quantity_base_int > 0),
    base_uom_code_snapshot     TEXT NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(package_id, component_product_id),
    FOREIGN KEY(package_id) REFERENCES published_kit_version_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(component_product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE sale_kit_version_snapshots (
    id                         TEXT PRIMARY KEY,
    financial_line_id          TEXT NOT NULL UNIQUE,
    sale_line_id               TEXT NOT NULL UNIQUE,
    product_id                 TEXT NOT NULL,
    published_kit_id           TEXT NOT NULL,
    published_kit_version_id   TEXT NOT NULL,
    version_number             INTEGER NOT NULL CHECK(version_number > 0),
    content_hash               TEXT NOT NULL CHECK(length(content_hash) = 64),
    is_current_at_sale         INTEGER NOT NULL CHECK(is_current_at_sale IN (0,1)),
    snapshot_json              TEXT NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(financial_line_id) REFERENCES sale_financial_lines(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(published_kit_id) REFERENCES published_kits(id) ON DELETE RESTRICT,
    FOREIGN KEY(published_kit_version_id) REFERENCES published_kit_versions(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_inventory_pieces (
    id                           TEXT PRIMARY KEY,
    product_id                   TEXT NOT NULL,
    inventory_lot_id             TEXT NOT NULL,
    acquisition_cost_snapshot_id TEXT NOT NULL,
    origin_piece_id              TEXT NOT NULL,
    parent_piece_id              TEXT,
    piece_sequence               INTEGER NOT NULL CHECK(piece_sequence > 0),
    original_length_mm           INTEGER NOT NULL CHECK(original_length_mm > 0),
    current_length_mm            INTEGER NOT NULL CHECK(current_length_mm >= 0),
    reserved_length_mm           INTEGER NOT NULL DEFAULT 0 CHECK(reserved_length_mm >= 0),
    historical_cost_minor        INTEGER NOT NULL CHECK(historical_cost_minor >= 0),
    status                       TEXT NOT NULL CHECK(status IN ('AVAILABLE','RESERVED','CUT','CONSUMED')),
    created_operation_id         TEXT NOT NULL,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(reserved_length_mm <= current_length_mm),
    UNIQUE(inventory_lot_id, piece_sequence),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_lot_id) REFERENCES inventory_lots(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(parent_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_piece_reservations (
    id                         TEXT PRIMARY KEY,
    reservation_id             TEXT NOT NULL,
    published_kit_version_id   TEXT NOT NULL,
    profile_piece_id           TEXT NOT NULL,
    product_id                 TEXT NOT NULL,
    cut_length_total_mm        INTEGER NOT NULL CHECK(cut_length_total_mm > 0),
    kerf_total_mm              INTEGER NOT NULL CHECK(kerf_total_mm >= 0),
    consumed_length_mm         INTEGER NOT NULL CHECK(consumed_length_mm = cut_length_total_mm + kerf_total_mm),
    planned_remnant_length_mm  INTEGER NOT NULL CHECK(planned_remnant_length_mm >= 0),
    status                     TEXT NOT NULL CHECK(status IN ('ACTIVE','RELEASED','EXECUTED','DISPATCHED')),
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reservation_id, profile_piece_id),
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
    FOREIGN KEY(published_kit_version_id) REFERENCES published_kit_versions(id) ON DELETE RESTRICT,
    FOREIGN KEY(profile_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_piece_reservation_cuts (
    id                           TEXT PRIMARY KEY,
    profile_piece_reservation_id TEXT NOT NULL,
    cut_sequence                 INTEGER NOT NULL CHECK(cut_sequence >= 0),
    length_mm                    INTEGER NOT NULL CHECK(length_mm > 0),
    kerf_mm                      INTEGER NOT NULL CHECK(kerf_mm >= 0),
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_piece_reservation_id, cut_sequence),
    FOREIGN KEY(profile_piece_reservation_id) REFERENCES profile_piece_reservations(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_cut_executions (
    id                           TEXT PRIMARY KEY,
    profile_piece_reservation_id TEXT NOT NULL UNIQUE,
    source_piece_id              TEXT NOT NULL UNIQUE,
    operation_id                 TEXT NOT NULL,
    original_length_mm           INTEGER NOT NULL CHECK(original_length_mm > 0),
    cut_length_total_mm          INTEGER NOT NULL CHECK(cut_length_total_mm > 0),
    kerf_total_mm                INTEGER NOT NULL CHECK(kerf_total_mm >= 0),
    consumed_length_mm           INTEGER NOT NULL CHECK(consumed_length_mm = cut_length_total_mm + kerf_total_mm),
    remnant_length_mm            INTEGER NOT NULL CHECK(remnant_length_mm >= 0),
    original_cost_minor          INTEGER NOT NULL CHECK(original_cost_minor >= 0),
    consumed_cost_minor          INTEGER NOT NULL CHECK(consumed_cost_minor >= 0),
    remnant_cost_minor           INTEGER NOT NULL CHECK(remnant_cost_minor >= 0),
    executed_by_actor_id         TEXT NOT NULL,
    executed_at                  DATETIME NOT NULL,
    created_at                   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(consumed_length_mm + remnant_length_mm = original_length_mm),
    CHECK(consumed_cost_minor + remnant_cost_minor = original_cost_minor),
    UNIQUE(operation_id, source_piece_id),
    FOREIGN KEY(profile_piece_reservation_id) REFERENCES profile_piece_reservations(id) ON DELETE RESTRICT,
    FOREIGN KEY(source_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT
  );

  CREATE TABLE profile_cut_outputs (
    id                    TEXT PRIMARY KEY,
    execution_id          TEXT NOT NULL,
    output_kind           TEXT NOT NULL CHECK(output_kind IN ('CUT','REMNANT')),
    output_sequence       INTEGER NOT NULL CHECK(output_sequence >= 0),
    length_mm             INTEGER NOT NULL CHECK(length_mm > 0),
    historical_cost_minor INTEGER NOT NULL CHECK(historical_cost_minor >= 0),
    inventory_piece_id    TEXT,
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(execution_id, output_kind, output_sequence),
    FOREIGN KEY(execution_id) REFERENCES profile_cut_executions(id) ON DELETE RESTRICT,
    FOREIGN KEY(inventory_piece_id) REFERENCES profile_inventory_pieces(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_published_kit_versions_kit ON published_kit_versions(published_kit_id,version_number DESC);
  CREATE INDEX idx_published_kit_components_version ON published_kit_version_components(published_kit_version_id,component_sequence);
  CREATE INDEX idx_published_kit_cuts_version ON published_kit_version_cuts(published_kit_version_id,cut_sequence);
  CREATE INDEX idx_profile_pieces_available ON profile_inventory_pieces(product_id,status,current_length_mm,id);
  CREATE INDEX idx_profile_piece_reservations_reservation ON profile_piece_reservations(reservation_id,status);

  CREATE TRIGGER trg_published_kit_versions_immutable_update BEFORE UPDATE ON published_kit_versions
    BEGIN SELECT RAISE(ABORT, 'published kit versions are immutable'); END;
  CREATE TRIGGER trg_published_kit_versions_immutable_delete BEFORE DELETE ON published_kit_versions
    BEGIN SELECT RAISE(ABORT, 'published kit versions are immutable'); END;
  CREATE TRIGGER trg_published_kit_components_immutable_update BEFORE UPDATE ON published_kit_version_components
    BEGIN SELECT RAISE(ABORT, 'published kit BOM snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_components_immutable_delete BEFORE DELETE ON published_kit_version_components
    BEGIN SELECT RAISE(ABORT, 'published kit BOM snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_cuts_immutable_update BEFORE UPDATE ON published_kit_version_cuts
    BEGIN SELECT RAISE(ABORT, 'published kit cut snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_cuts_immutable_delete BEFORE DELETE ON published_kit_version_cuts
    BEGIN SELECT RAISE(ABORT, 'published kit cut snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_packages_immutable_update BEFORE UPDATE ON published_kit_version_packages
    BEGIN SELECT RAISE(ABORT, 'published kit package snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_packages_immutable_delete BEFORE DELETE ON published_kit_version_packages
    BEGIN SELECT RAISE(ABORT, 'published kit package snapshots are immutable'); END;
  CREATE TRIGGER trg_published_kit_package_items_immutable_update BEFORE UPDATE ON published_kit_version_package_items
    BEGIN SELECT RAISE(ABORT, 'published kit package allocations are immutable'); END;
  CREATE TRIGGER trg_published_kit_package_items_immutable_delete BEFORE DELETE ON published_kit_version_package_items
    BEGIN SELECT RAISE(ABORT, 'published kit package allocations are immutable'); END;
  CREATE TRIGGER trg_sale_kit_snapshots_immutable_update BEFORE UPDATE ON sale_kit_version_snapshots
    BEGIN SELECT RAISE(ABORT, 'sale kit version snapshots are immutable'); END;
  CREATE TRIGGER trg_sale_kit_snapshots_immutable_delete BEFORE DELETE ON sale_kit_version_snapshots
    BEGIN SELECT RAISE(ABORT, 'sale kit version snapshots are immutable'); END;
  CREATE TRIGGER trg_profile_piece_identity_immutable BEFORE UPDATE OF
    product_id,inventory_lot_id,acquisition_cost_snapshot_id,origin_piece_id,parent_piece_id,piece_sequence,
    original_length_mm,historical_cost_minor,created_operation_id,created_at ON profile_inventory_pieces
    BEGIN SELECT RAISE(ABORT, 'profile piece provenance is immutable'); END;
  CREATE TRIGGER trg_profile_piece_no_delete BEFORE DELETE ON profile_inventory_pieces
    BEGIN SELECT RAISE(ABORT, 'profile pieces cannot be deleted'); END;
  CREATE TRIGGER trg_profile_piece_reservation_cuts_immutable_update BEFORE UPDATE ON profile_piece_reservation_cuts
    BEGIN SELECT RAISE(ABORT, 'profile reservation cuts are immutable'); END;
  CREATE TRIGGER trg_profile_piece_reservation_cuts_immutable_delete BEFORE DELETE ON profile_piece_reservation_cuts
    BEGIN SELECT RAISE(ABORT, 'profile reservation cuts are immutable'); END;
  CREATE TRIGGER trg_profile_cut_executions_immutable_update BEFORE UPDATE ON profile_cut_executions
    BEGIN SELECT RAISE(ABORT, 'profile cut executions are immutable'); END;
  CREATE TRIGGER trg_profile_cut_executions_immutable_delete BEFORE DELETE ON profile_cut_executions
    BEGIN SELECT RAISE(ABORT, 'profile cut executions are immutable'); END;
  CREATE TRIGGER trg_profile_cut_outputs_immutable_update BEFORE UPDATE ON profile_cut_outputs
    BEGIN SELECT RAISE(ABORT, 'profile cut outputs are immutable'); END;
  CREATE TRIGGER trg_profile_cut_outputs_immutable_delete BEFORE DELETE ON profile_cut_outputs
    BEGIN SELECT RAISE(ABORT, 'profile cut outputs are immutable'); END;
`;

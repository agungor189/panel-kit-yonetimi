// Forward-only procurement workflow and Panel/Warehouse handoff contract.
// Existing immutable V2-06 cost snapshots remain authoritative.
export const PROCUREMENT_WORKFLOW_SCHEMA_V94 = `
  CREATE TABLE procurement_workflows (
    purchase_order_id TEXT PRIMARY KEY,
    purchase_number TEXT NOT NULL UNIQUE,
    order_date TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('DRAFT','ORDERED','IN_TRANSIT','COST_PENDING','RECEIPT_PENDING','COMPLETED')),
    receipt_approved_at DATETIME,
    receipt_approved_by TEXT,
    completed_at DATETIME,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT
  );

  CREATE TABLE procurement_documents (
    id TEXT PRIMARY KEY,
    purchase_order_id TEXT NOT NULL,
    cost_component_id TEXT,
    document_type TEXT NOT NULL CHECK(document_type IN (
      'PROFORMA_INVOICE','COMMERCIAL_INVOICE','PACKING_LIST','CUSTOMS_DOCUMENT',
      'FREIGHT_DOCUMENT','EXPENSE_INVOICE','OTHER'
    )),
    original_file_name TEXT NOT NULL,
    storage_reference TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    uploaded_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(cost_component_id) REFERENCES purchase_cost_components(id) ON DELETE RESTRICT
  );

  CREATE TABLE purchase_cost_component_details (
    component_id TEXT PRIMARY KEY,
    expense_type TEXT NOT NULL CHECK(expense_type IN (
      'FREIGHT','CUSTOMS_DUTY','ADDITIONAL_TAX','CUSTOMS_BROKER',
      'WAREHOUSE_PORT','DOMESTIC_FREIGHT','INSURANCE','BANK_TRANSFER','OTHER'
    )),
    description TEXT,
    occurred_on TEXT NOT NULL,
    target_scope TEXT NOT NULL CHECK(target_scope IN ('COMMON','SELECTED_LINES')),
    target_line_ids_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(component_id) REFERENCES purchase_cost_components(id) ON DELETE RESTRICT
  );

  CREATE TABLE current_product_landed_costs (
    product_id TEXT PRIMARY KEY,
    acquisition_cost_snapshot_id TEXT NOT NULL UNIQUE,
    purchase_order_id TEXT NOT NULL,
    purchase_line_id TEXT NOT NULL,
    cost_try_numerator INTEGER NOT NULL CHECK(cost_try_numerator >= 0),
    cost_try_denominator INTEGER NOT NULL CHECK(cost_try_denominator > 0),
    base_uom_code TEXT NOT NULL,
    finalized_at DATETIME NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
    FOREIGN KEY(acquisition_cost_snapshot_id) REFERENCES acquisition_lot_cost_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY(purchase_order_id) REFERENCES purchase_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(purchase_line_id) REFERENCES purchase_order_lines(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_procurement_workflows_state ON procurement_workflows(state, updated_at);
  CREATE INDEX idx_procurement_documents_purchase ON procurement_documents(purchase_order_id, created_at);
  CREATE INDEX idx_current_landed_purchase ON current_product_landed_costs(purchase_order_id, purchase_line_id);

  CREATE TRIGGER trg_procurement_documents_immutable_update BEFORE UPDATE ON procurement_documents
    BEGIN SELECT RAISE(ABORT, 'procurement_documents are immutable'); END;
  CREATE TRIGGER trg_procurement_documents_immutable_delete BEFORE DELETE ON procurement_documents
    BEGIN SELECT RAISE(ABORT, 'procurement_documents cannot be deleted; supersede with a new document'); END;
  CREATE TRIGGER trg_purchase_cost_details_immutable_update BEFORE UPDATE ON purchase_cost_component_details
    BEGIN SELECT RAISE(ABORT, 'purchase cost details are immutable'); END;
  CREATE TRIGGER trg_purchase_cost_details_immutable_delete BEFORE DELETE ON purchase_cost_component_details
    BEGIN SELECT RAISE(ABORT, 'purchase cost details are immutable'); END;
`;

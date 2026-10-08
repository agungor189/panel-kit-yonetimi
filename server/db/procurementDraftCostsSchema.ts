// Forward-only staging for incomplete CSV purchase costs and explicit alias
// retractions. Financial cost components remain owned by ProcurementService.
export const PROCUREMENT_DRAFT_COSTS_SCHEMA_V102 = `
 CREATE TABLE procurement_import_draft_costs (
   id TEXT PRIMARY KEY,
   draft_id TEXT NOT NULL REFERENCES procurement_import_drafts(id),
   title TEXT NOT NULL,
   amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
   currency TEXT NOT NULL CHECK(currency IN ('USD','TRY')),
   description TEXT,
   status TEXT NOT NULL CHECK(status IN ('ACTIVE','DELETED')),
   version INTEGER NOT NULL CHECK(version > 0),
   created_by TEXT NOT NULL,
   created_at TEXT NOT NULL,
   updated_by TEXT NOT NULL,
   updated_at TEXT NOT NULL
 );
 CREATE INDEX idx_procurement_draft_costs ON procurement_import_draft_costs(draft_id,status,created_at);
 CREATE TABLE procurement_import_draft_cost_revisions (
   cost_id TEXT NOT NULL REFERENCES procurement_import_draft_costs(id),
   version INTEGER NOT NULL,
   action TEXT NOT NULL CHECK(action IN ('CREATE','UPDATE','DELETE')),
   snapshot_json TEXT NOT NULL,
   operation_id TEXT NOT NULL,
   actor_id TEXT NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY(cost_id,version)
 );
 CREATE TRIGGER procurement_import_draft_cost_revisions_immutable_update
 BEFORE UPDATE ON procurement_import_draft_cost_revisions BEGIN SELECT RAISE(ABORT,'immutable draft cost revision'); END;
 CREATE TRIGGER procurement_import_draft_cost_revisions_immutable_delete
 BEFORE DELETE ON procurement_import_draft_cost_revisions BEGIN SELECT RAISE(ABORT,'immutable draft cost revision'); END;
 CREATE TABLE catalog_supplier_alias_retractions (
   supplier_id TEXT NOT NULL,
   alias TEXT NOT NULL COLLATE NOCASE,
   product_id TEXT NOT NULL,
   source_ref TEXT NOT NULL,
   manifest_hash TEXT NOT NULL,
   backup_reference TEXT NOT NULL,
   approval_reference TEXT NOT NULL,
   reason TEXT NOT NULL,
   actor_id TEXT NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY(supplier_id,alias),
   FOREIGN KEY(supplier_id,alias) REFERENCES catalog_supplier_aliases(supplier_id,alias)
 );
 CREATE TABLE catalog_supplier_alias_retraction_reversals (
   supplier_id TEXT NOT NULL,
   alias TEXT NOT NULL COLLATE NOCASE,
   product_id TEXT NOT NULL,
   manifest_hash TEXT NOT NULL,
   backup_reference TEXT NOT NULL,
   approval_reference TEXT NOT NULL,
   reason TEXT NOT NULL,
   actor_id TEXT NOT NULL,
   created_at TEXT NOT NULL,
   PRIMARY KEY(supplier_id,alias),
   FOREIGN KEY(supplier_id,alias) REFERENCES catalog_supplier_alias_retractions(supplier_id,alias)
 );
 ${['catalog_supplier_alias_retractions','catalog_supplier_alias_retraction_reversals'].map(table => `
 CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable alias correction'); END;
 CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable alias correction'); END;`).join('')}
`;

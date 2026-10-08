// A CSV is a procurement intent until tax, FX and acquisition-cost policy are
// explicitly supplied. The existing financial purchase tables stay authoritative.
export const PROCUREMENT_IMPORT_DRAFT_SCHEMA_V101 = `
 CREATE TABLE procurement_import_drafts (
   id TEXT PRIMARY KEY,
   source_hash TEXT NOT NULL UNIQUE,
   supplier_id TEXT NOT NULL REFERENCES procurement_suppliers(id),
   invoice_number TEXT NOT NULL COLLATE NOCASE,
   invoice_date TEXT,
   currency TEXT NOT NULL,
   source_csv TEXT NOT NULL,
   resolved_json TEXT NOT NULL,
   preview_hash TEXT NOT NULL,
   actor_id TEXT NOT NULL,
   created_at TEXT NOT NULL,
   UNIQUE(supplier_id,invoice_number)
 );
 CREATE TABLE procurement_import_draft_completions (
   draft_id TEXT PRIMARY KEY REFERENCES procurement_import_drafts(id),
   purchase_order_id TEXT NOT NULL UNIQUE REFERENCES purchase_orders(id),
   decision_json TEXT NOT NULL,
   actor_id TEXT NOT NULL,
   completed_at TEXT NOT NULL
 );
 CREATE TRIGGER procurement_import_drafts_immutable_update BEFORE UPDATE ON procurement_import_drafts
 BEGIN SELECT RAISE(ABORT,'immutable import draft'); END;
 CREATE TRIGGER procurement_import_drafts_immutable_delete BEFORE DELETE ON procurement_import_drafts
 BEGIN SELECT RAISE(ABORT,'immutable import draft'); END;
 CREATE TRIGGER procurement_import_draft_completions_immutable_update BEFORE UPDATE ON procurement_import_draft_completions
 BEGIN SELECT RAISE(ABORT,'immutable import completion'); END;
 CREATE TRIGGER procurement_import_draft_completions_immutable_delete BEFORE DELETE ON procurement_import_draft_completions
 BEGIN SELECT RAISE(ABORT,'immutable import completion'); END;
`;

// Drafts and their source identities stay immutable. A cancellation hides an
// incomplete intent; re-importing the same source appends a reopen event.
export const PROCUREMENT_DRAFT_LIFECYCLE_SCHEMA_V103 = `
 CREATE TABLE procurement_import_draft_lifecycle_events (
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,
   draft_id TEXT NOT NULL REFERENCES procurement_import_drafts(id),
   event_type TEXT NOT NULL CHECK(event_type IN ('CANCELLED','REOPENED')),
   operation_id TEXT NOT NULL UNIQUE,
   actor_id TEXT NOT NULL,
   created_at TEXT NOT NULL
 );
 CREATE INDEX idx_procurement_draft_lifecycle_latest ON procurement_import_draft_lifecycle_events(draft_id,sequence DESC);
 CREATE TRIGGER procurement_import_draft_lifecycle_immutable_update
 BEFORE UPDATE ON procurement_import_draft_lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable draft lifecycle'); END;
 CREATE TRIGGER procurement_import_draft_lifecycle_immutable_delete
 BEFORE DELETE ON procurement_import_draft_lifecycle_events BEGIN SELECT RAISE(ABORT,'immutable draft lifecycle'); END;
`;

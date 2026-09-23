// Forward-only V2-15 schema. Findings are mutable current state; history,
// repair evidence and run records are append-only.
export const RECONCILIATION_SCHEMA_V87 = `
  CREATE TABLE reconciliation_runs (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('SCHEDULED','MANUAL')),
    actor_type TEXT NOT NULL CHECK(actor_type IN ('SYSTEM','HUMAN')),
    actor_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPLETED','FAILED')),
    finding_count INTEGER NOT NULL DEFAULT 0,
    critical_count INTEGER NOT NULL DEFAULT 0,
    auto_repair_count INTEGER NOT NULL DEFAULT 0,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    error_code TEXT
  );

  CREATE TABLE reconciliation_findings (
    id TEXT PRIMARY KEY,
    identity_key TEXT NOT NULL UNIQUE CHECK(length(identity_key)=64),
    domain TEXT NOT NULL,
    code TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('INFO','WARN','CRITICAL')),
    affected_type TEXT NOT NULL CHECK(affected_type IN ('SKU','ORDER','SYSTEM')),
    affected_id TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    actual_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED','VERIFIED')),
    repair_status TEXT NOT NULL CHECK(repair_status IN ('NOT_APPLICABLE','AUTO_REPAIRED','APPROVAL_REQUIRED','PROPOSED','APPROVED','REJECTED','APPLIED')),
    first_run_id TEXT NOT NULL,
    last_run_id TEXT NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1 CHECK(occurrences > 0),
    first_seen_at DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL,
    resolved_at DATETIME,
    verified_by_actor_id TEXT,
    verification_reason TEXT,
    FOREIGN KEY(first_run_id) REFERENCES reconciliation_runs(id) ON DELETE RESTRICT,
    FOREIGN KEY(last_run_id) REFERENCES reconciliation_runs(id) ON DELETE RESTRICT
  );

  CREATE TABLE reconciliation_blocks (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL UNIQUE,
    affected_type TEXT NOT NULL CHECK(affected_type IN ('SKU','ORDER')),
    affected_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ACTIVE','CLEARED')),
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    cleared_at DATETIME,
    cleared_by_actor_id TEXT,
    clear_reason TEXT,
    FOREIGN KEY(finding_id) REFERENCES reconciliation_findings(id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_reconciliation_active_blocks ON reconciliation_blocks(affected_type,affected_id,status);

  CREATE TABLE reconciliation_repair_proposals (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    command_type TEXT NOT NULL,
    command_payload_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('PROPOSED','APPROVED','REJECTED','APPLIED')),
    proposed_by_actor_id TEXT NOT NULL,
    proposed_operation_id TEXT NOT NULL UNIQUE,
    proposed_at DATETIME NOT NULL,
    reviewed_by_actor_id TEXT,
    review_operation_id TEXT UNIQUE,
    review_reason TEXT,
    reviewed_at DATETIME,
    applied_operation_id TEXT UNIQUE,
    applied_at DATETIME,
    before_json TEXT,
    after_json TEXT,
    FOREIGN KEY(finding_id) REFERENCES reconciliation_findings(id) ON DELETE RESTRICT
  );
  CREATE UNIQUE INDEX idx_reconciliation_one_pending_proposal
    ON reconciliation_repair_proposals(finding_id) WHERE status='PROPOSED';

  CREATE TABLE reconciliation_history (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    run_id TEXT,
    event_type TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    reason TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('SYSTEM','HUMAN')),
    actor_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    FOREIGN KEY(finding_id) REFERENCES reconciliation_findings(id) ON DELETE RESTRICT,
    FOREIGN KEY(run_id) REFERENCES reconciliation_runs(id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_reconciliation_history_finding ON reconciliation_history(finding_id,created_at,id);
  CREATE TRIGGER trg_reconciliation_runs_no_delete BEFORE DELETE ON reconciliation_runs
    BEGIN SELECT RAISE(ABORT,'reconciliation runs are immutable'); END;
  CREATE TRIGGER trg_reconciliation_history_no_update BEFORE UPDATE ON reconciliation_history
    BEGIN SELECT RAISE(ABORT,'reconciliation history is immutable'); END;
  CREATE TRIGGER trg_reconciliation_history_no_delete BEFORE DELETE ON reconciliation_history
    BEGIN SELECT RAISE(ABORT,'reconciliation history is immutable'); END;
  CREATE TRIGGER trg_reconciliation_repairs_no_delete BEFORE DELETE ON reconciliation_repair_proposals
    BEGIN SELECT RAISE(ABORT,'reconciliation repair evidence is immutable'); END;
`;

// Forward-only v100. No historical jobs, attempts or snapshots are rewritten.
export const PRINT_REVISION_SCHEMA_V100 = `
  ALTER TABLE printing_jobs ADD COLUMN supersedes_job_id TEXT REFERENCES printing_jobs(id);
  ALTER TABLE printing_jobs ADD COLUMN superseded_by_job_id TEXT REFERENCES printing_jobs(id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE printing_jobs ADD COLUMN replacement_required INTEGER NOT NULL DEFAULT 0 CHECK(replacement_required IN (0,1));
  ALTER TABLE printing_jobs ADD COLUMN replacement_acknowledged_at DATETIME;
  ALTER TABLE printing_jobs ADD COLUMN replacement_acknowledged_by TEXT REFERENCES users(id);
  ALTER TABLE printing_attempts ADD COLUMN submission_started_at DATETIME;

  DROP INDEX idx_printing_jobs_original_snapshot_unique;
  CREATE UNIQUE INDEX idx_printing_jobs_original_snapshot_unique ON printing_jobs(printable_snapshot_hash)
    WHERE original_job_id IS NULL AND (purpose <> 'GOODS_RECEIPT_PACKAGE' OR superseded_by_job_id IS NULL);
  CREATE INDEX idx_printing_current_package ON printing_jobs(subject_id,superseded_by_job_id) WHERE purpose='GOODS_RECEIPT_PACKAGE';
  CREATE TRIGGER trg_printing_revision_link_immutable BEFORE UPDATE OF supersedes_job_id,replacement_required ON printing_jobs
    BEGIN SELECT RAISE(ABORT,'print revision provenance is immutable'); END;
  CREATE TRIGGER trg_printing_supersession_once BEFORE UPDATE OF superseded_by_job_id ON printing_jobs
    WHEN OLD.superseded_by_job_id IS NOT NULL AND NEW.superseded_by_job_id IS NOT OLD.superseded_by_job_id
    BEGIN SELECT RAISE(ABORT,'print supersession cannot be undone'); END;
  CREATE TRIGGER trg_printing_replacement_ack_once BEFORE UPDATE OF replacement_acknowledged_at,replacement_acknowledged_by ON printing_jobs
    WHEN OLD.replacement_acknowledged_at IS NOT NULL AND (NEW.replacement_acknowledged_at IS NOT OLD.replacement_acknowledged_at OR NEW.replacement_acknowledged_by IS NOT OLD.replacement_acknowledged_by)
    BEGIN SELECT RAISE(ABORT,'replacement acknowledgement is immutable'); END;
`;

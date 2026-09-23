// Forward-only V2-14 remediation migration v86.
export const PRINT_DEDUP_COLUMNS_SCHEMA_V86 = `
  ALTER TABLE printing_jobs ADD COLUMN printable_snapshot_hash TEXT CHECK(printable_snapshot_hash IS NULL OR length(printable_snapshot_hash)=64);
  ALTER TABLE printing_jobs ADD COLUMN reprint_dedupe_hash TEXT CHECK(reprint_dedupe_hash IS NULL OR length(reprint_dedupe_hash)=64);
`;

export const PRINT_DEDUP_GUARDS_SCHEMA_V86 = `
  CREATE UNIQUE INDEX idx_printing_jobs_original_snapshot_unique
    ON printing_jobs(printable_snapshot_hash)
    WHERE original_job_id IS NULL;

  CREATE UNIQUE INDEX idx_printing_jobs_active_reprint_unique
    ON printing_jobs(reprint_dedupe_hash)
    WHERE original_job_id IS NOT NULL
      AND status IN ('QUEUED','RENDERED','SUBMITTED','ACKNOWLEDGED','DELIVERY_UNKNOWN');

  DROP TRIGGER trg_printing_job_snapshot_immutable;
  CREATE TRIGGER trg_printing_job_snapshot_immutable BEFORE UPDATE OF
    purpose,subject_type,subject_id,subject_code,original_job_id,request_hash,template_id,template_version,
    template_content_hash,template_snapshot_json,payload_snapshot_json,payload_snapshot_hash,printable_snapshot_hash,
    reprint_dedupe_hash,provider,artifact_reference,artifact_sha256,artifact_media_type,artifact_blob,printer_model,
    printer_dpi,created_operation_id,created_by,created_at
    ON printing_jobs BEGIN SELECT RAISE(ABORT,'print job snapshot is immutable'); END;
`;

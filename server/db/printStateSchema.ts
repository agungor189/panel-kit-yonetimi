// Frozen schema body for forward-only V2-14 migration v85.
export const PRINT_STATE_SCHEMA_V85 = `
  CREATE TABLE printing_jobs (
    id TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK(purpose IN ('GOODS_RECEIPT_PACKAGE','LOCATION','SHIPPING')),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    original_job_id TEXT,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    template_id TEXT,
    template_version INTEGER,
    template_content_hash TEXT CHECK(template_content_hash IS NULL OR length(template_content_hash)=64),
    template_snapshot_json TEXT,
    payload_snapshot_json TEXT NOT NULL,
    payload_snapshot_hash TEXT NOT NULL CHECK(length(payload_snapshot_hash)=64),
    provider TEXT,
    artifact_reference TEXT,
    artifact_sha256 TEXT CHECK(artifact_sha256 IS NULL OR length(artifact_sha256)=64),
    artifact_media_type TEXT,
    artifact_blob BLOB,
    printer_model TEXT NOT NULL DEFAULT 'Xprinter XP-470B',
    printer_dpi INTEGER NOT NULL DEFAULT 203 CHECK(printer_dpi=203),
    printer_name TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED' CHECK(status IN (
      'QUEUED','RENDERED','SUBMITTED','ACKNOWLEDGED','PRINTED_CONFIRMED','DELIVERY_UNKNOWN','FAILED','CANCELLED'
    )),
    error_code TEXT,
    error_message TEXT,
    created_operation_id TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    cancelled_at DATETIME,
    FOREIGN KEY(original_job_id) REFERENCES printing_jobs(id) ON DELETE RESTRICT,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT,
    CHECK((purpose='SHIPPING' AND provider='GELIVER' AND artifact_reference IS NOT NULL AND artifact_sha256 IS NOT NULL
      AND artifact_media_type IS NOT NULL AND artifact_blob IS NOT NULL AND template_id IS NULL)
      OR (purpose IN ('GOODS_RECEIPT_PACKAGE','LOCATION') AND template_id IS NOT NULL AND template_version IS NOT NULL
      AND template_content_hash IS NOT NULL AND template_snapshot_json IS NOT NULL AND provider IS NULL AND artifact_blob IS NULL))
  );

  CREATE TABLE printing_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    attempt_identity TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('STARTED','RENDERED','SUBMITTED','ACKNOWLEDGED','DELIVERY_UNKNOWN','FAILED')),
    lease_token TEXT NOT NULL,
    lease_expires_at DATETIME NOT NULL,
    rendered_sha256 TEXT CHECK(rendered_sha256 IS NULL OR length(rendered_sha256)=64),
    spool_reference TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    UNIQUE(job_id, attempt_number),
    FOREIGN KEY(job_id) REFERENCES printing_jobs(id) ON DELETE RESTRICT
  );

  CREATE TABLE printing_reprints (
    id TEXT PRIMARY KEY,
    original_job_id TEXT NOT NULL,
    reprint_job_id TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL CHECK(reason IN ('DAMAGED_OUTPUT','LOST','PRINTER_ERROR','OTHER')),
    explanation TEXT,
    operation_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(reason<>'OTHER' OR (explanation IS NOT NULL AND length(trim(explanation))>0)),
    FOREIGN KEY(original_job_id) REFERENCES printing_jobs(id) ON DELETE RESTRICT,
    FOREIGN KEY(reprint_job_id) REFERENCES printing_jobs(id) ON DELETE RESTRICT,
    FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE RESTRICT
  );

  CREATE TABLE printing_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    event_index INTEGER NOT NULL CHECK(event_index >= 0),
    attempt_id TEXT,
    from_status TEXT,
    to_status TEXT NOT NULL CHECK(to_status IN (
      'QUEUED','RENDERED','SUBMITTED','ACKNOWLEDGED','PRINTED_CONFIRMED','DELIVERY_UNKNOWN','FAILED','CANCELLED'
    )),
    operation_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_id, event_index),
    UNIQUE(job_id, operation_id, to_status),
    FOREIGN KEY(job_id) REFERENCES printing_jobs(id) ON DELETE RESTRICT,
    FOREIGN KEY(attempt_id) REFERENCES printing_attempts(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_printing_jobs_worker ON printing_jobs(status, created_at, id);
  CREATE INDEX idx_printing_jobs_subject ON printing_jobs(subject_type, subject_id, created_at);
  CREATE INDEX idx_printing_events_job ON printing_events(job_id, created_at, id);

  CREATE TRIGGER trg_printing_job_snapshot_immutable BEFORE UPDATE OF
    purpose,subject_type,subject_id,subject_code,original_job_id,request_hash,template_id,template_version,
    template_content_hash,template_snapshot_json,payload_snapshot_json,payload_snapshot_hash,provider,
    artifact_reference,artifact_sha256,artifact_media_type,artifact_blob,printer_model,printer_dpi,created_operation_id,created_by,created_at
    ON printing_jobs BEGIN SELECT RAISE(ABORT,'print job snapshot is immutable'); END;
  CREATE TRIGGER trg_printing_job_delete BEFORE DELETE ON printing_jobs BEGIN SELECT RAISE(ABORT,'print job history is immutable'); END;
  CREATE TRIGGER trg_printing_reprint_update BEFORE UPDATE ON printing_reprints BEGIN SELECT RAISE(ABORT,'reprint history is immutable'); END;
  CREATE TRIGGER trg_printing_reprint_delete BEFORE DELETE ON printing_reprints BEGIN SELECT RAISE(ABORT,'reprint history is immutable'); END;
  CREATE TRIGGER trg_printing_event_update BEFORE UPDATE ON printing_events BEGIN SELECT RAISE(ABORT,'print event history is immutable'); END;
  CREATE TRIGGER trg_printing_event_delete BEFORE DELETE ON printing_events BEGIN SELECT RAISE(ABORT,'print event history is immutable'); END;
`;

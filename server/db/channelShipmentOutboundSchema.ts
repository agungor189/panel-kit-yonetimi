// Forward-only V2-13 closure: shipment projections use the V2-12 durable
// channel execution authority without changing the immutable V82 definition.
export const CHANNEL_SHIPMENT_OUTBOUND_SCHEMA_V84 = String.raw`
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0);
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN last_error_code TEXT;
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN completed_at DATETIME;
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN lease_token TEXT;
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN lease_owner TEXT;
  ALTER TABLE channel_shipment_outbound_jobs ADD COLUMN lease_expires_at DATETIME;

  CREATE TABLE channel_shipment_outbound_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    provider_mutation_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
    state TEXT NOT NULL CHECK(state IN ('SUCCEEDED','FAILED','RATE_LIMITED','BLOCKED')),
    response_digest TEXT,
    error_code TEXT,
    retry_at DATETIME,
    started_at DATETIME NOT NULL,
    completed_at DATETIME NOT NULL,
    UNIQUE(job_id,attempt_number),
    FOREIGN KEY(job_id) REFERENCES channel_shipment_outbound_jobs(id) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX idx_channel_shipment_jobs_lease_token
    ON channel_shipment_outbound_jobs(lease_token) WHERE lease_token IS NOT NULL;
  CREATE INDEX idx_channel_shipment_jobs_claim_ready
    ON channel_shipment_outbound_jobs(state,available_at,lease_expires_at,account_id);
  CREATE INDEX idx_channel_shipment_attempt_mutation
    ON channel_shipment_outbound_attempts(job_id,provider_mutation_id,attempt_number);

  CREATE TRIGGER channel_shipment_outbound_attempts_no_update
  BEFORE UPDATE ON channel_shipment_outbound_attempts
  BEGIN SELECT RAISE(ABORT,'channel shipment outbound attempt is immutable'); END;
  CREATE TRIGGER channel_shipment_outbound_attempts_no_delete
  BEFORE DELETE ON channel_shipment_outbound_attempts
  BEGIN SELECT RAISE(ABORT,'channel shipment outbound attempt is immutable'); END;
`;

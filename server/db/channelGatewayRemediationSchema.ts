// Forward-only V2-12 remediation. Leases are metadata on the durable job;
// the job state remains PENDING/RETRY until an immutable terminal attempt is recorded.
export const CHANNEL_GATEWAY_REMEDIATION_SCHEMA_V80 = `
  ALTER TABLE channel_outbound_jobs ADD COLUMN lease_token TEXT;
  ALTER TABLE channel_outbound_jobs ADD COLUMN lease_owner TEXT;
  ALTER TABLE channel_outbound_jobs ADD COLUMN lease_expires_at DATETIME;

  CREATE UNIQUE INDEX idx_channel_jobs_lease_token
    ON channel_outbound_jobs(lease_token) WHERE lease_token IS NOT NULL;
  CREATE INDEX idx_channel_jobs_claim_ready
    ON channel_outbound_jobs(state,available_at,lease_expires_at,account_id);
`;

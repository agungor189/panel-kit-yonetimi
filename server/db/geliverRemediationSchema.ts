// Forward-only V2-13 Geliver remediation. V82 remains immutable historical evidence.
export const GELIVER_REMEDIATION_SCHEMA_V83 = String.raw`
  CREATE TABLE shipment_recipient_snapshots (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL,
    phone TEXT, address1 TEXT NOT NULL, address2 TEXT, country_code TEXT NOT NULL,
    city_name TEXT NOT NULL, city_code TEXT NOT NULL, district_name TEXT NOT NULL, district_id TEXT, zip TEXT,
    snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash)=64), created_operation_id TEXT NOT NULL UNIQUE,
    created_actor_id TEXT NOT NULL, created_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_create_jobs (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE,
    request_identity TEXT NOT NULL UNIQUE, provider_order_number TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('PENDING','PROCESSING','RECONCILE_REQUIRED','CREATED','DEFINITIVE_FAILURE','CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_count>=0),
    last_error_code TEXT, created_operation_id TEXT NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_create_attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
    state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','DEFINITIVE_FAILURE','UNCERTAIN','RECONCILED')),
    response_hash TEXT CHECK(response_hash IS NULL OR length(response_hash)=64), error_code TEXT,
    started_at DATETIME NOT NULL, completed_at DATETIME, UNIQUE(job_id,attempt_number),
    FOREIGN KEY(job_id) REFERENCES geliver_create_jobs(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_provider_shipments (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE, create_job_id TEXT NOT NULL UNIQUE,
    provider_shipment_id TEXT NOT NULL UNIQUE, provider_order_number TEXT NOT NULL UNIQUE, barcode TEXT,
    accepted_offer_id TEXT, provider_state_code TEXT, response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
    source TEXT NOT NULL CHECK(source IN ('CREATE_RESPONSE','ORDER_NUMBER_RECONCILIATION')), created_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(create_job_id) REFERENCES geliver_create_jobs(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_offer_observations (
    id TEXT PRIMARY KEY, provider_shipment_id TEXT NOT NULL, offer_id TEXT NOT NULL,
    provider_code TEXT NOT NULL, provider_service_code TEXT NOT NULL, amount TEXT NOT NULL, currency TEXT NOT NULL,
    amount_local TEXT, currency_local TEXT, estimated_arrival_at TEXT, duration_terms TEXT,
    response_hash TEXT NOT NULL CHECK(length(response_hash)=64), observed_at DATETIME NOT NULL,
    UNIQUE(provider_shipment_id,offer_id,response_hash),
    FOREIGN KEY(provider_shipment_id) REFERENCES geliver_provider_shipments(provider_shipment_id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_offer_selections (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE, provider_shipment_id TEXT NOT NULL,
    offer_id TEXT NOT NULL UNIQUE, provider_code TEXT NOT NULL, provider_service_code TEXT NOT NULL,
    quote_amount TEXT NOT NULL, quote_currency TEXT NOT NULL, quote_response_hash TEXT NOT NULL CHECK(length(quote_response_hash)=64),
    selected_operation_id TEXT NOT NULL UNIQUE, selected_actor_id TEXT NOT NULL, selected_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_shipment_id) REFERENCES geliver_provider_shipments(provider_shipment_id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_accept_jobs (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE, selection_id TEXT NOT NULL UNIQUE,
    request_identity TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    state TEXT NOT NULL CHECK(state IN ('PENDING','PROCESSING','RECONCILE_REQUIRED','ACCEPTED','DEFINITIVE_FAILURE','CANCELLED')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), reconciliation_count INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_count>=0),
    last_error_code TEXT, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(selection_id) REFERENCES geliver_offer_selections(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_accept_attempts (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
    state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','DEFINITIVE_FAILURE','UNCERTAIN','RECONCILED')),
    response_hash TEXT CHECK(response_hash IS NULL OR length(response_hash)=64), error_code TEXT,
    started_at DATETIME NOT NULL, completed_at DATETIME, UNIQUE(job_id,attempt_number),
    FOREIGN KEY(job_id) REFERENCES geliver_accept_jobs(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_booking_facts (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, package_id TEXT NOT NULL UNIQUE, accept_job_id TEXT NOT NULL UNIQUE,
    provider_shipment_id TEXT NOT NULL UNIQUE, provider_transaction_id TEXT, offer_id TEXT NOT NULL, barcode TEXT,
    response_hash TEXT NOT NULL CHECK(length(response_hash)=64),
    source TEXT NOT NULL CHECK(source IN ('ACCEPT_RESPONSE','SHIPMENT_RECONCILIATION')), booked_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(accept_job_id) REFERENCES geliver_accept_jobs(id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_label_observations (
    id TEXT PRIMARY KEY, provider_shipment_id TEXT NOT NULL, label_url TEXT NOT NULL, responsive_label_url TEXT,
    label_file_type TEXT, artifact_sha256 TEXT CHECK(artifact_sha256 IS NULL OR length(artifact_sha256)=64),
    response_hash TEXT NOT NULL CHECK(length(response_hash)=64), observed_at DATETIME NOT NULL,
    UNIQUE(provider_shipment_id,label_url,response_hash),
    FOREIGN KEY(provider_shipment_id) REFERENCES geliver_provider_shipments(provider_shipment_id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_tracking_observations (
    id TEXT PRIMARY KEY, provider_shipment_id TEXT NOT NULL, tracking_number TEXT, tracking_url TEXT,
    provider_state_code TEXT, response_hash TEXT NOT NULL CHECK(length(response_hash)=64), observed_at DATETIME NOT NULL,
    UNIQUE(provider_shipment_id,response_hash),
    FOREIGN KEY(provider_shipment_id) REFERENCES geliver_provider_shipments(provider_shipment_id) ON DELETE RESTRICT
  );
  CREATE TABLE geliver_cancellation_facts (
    id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, provider_shipment_id TEXT NOT NULL UNIQUE,
    response_hash TEXT NOT NULL CHECK(length(response_hash)=64), cancelled_at DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_shipment_id) REFERENCES geliver_provider_shipments(provider_shipment_id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_geliver_create_reconcile ON geliver_create_jobs(state,updated_at);
  CREATE INDEX idx_geliver_accept_reconcile ON geliver_accept_jobs(state,updated_at);
  CREATE INDEX idx_geliver_offers_current ON geliver_offer_observations(provider_shipment_id,observed_at);
  CREATE INDEX idx_geliver_tracking_current ON geliver_tracking_observations(provider_shipment_id,observed_at);
  CREATE TRIGGER trg_shipment_recipient_immutable_update BEFORE UPDATE ON shipment_recipient_snapshots BEGIN SELECT RAISE(ABORT,'shipment recipient snapshot is immutable'); END;
  CREATE TRIGGER trg_shipment_recipient_immutable_delete BEFORE DELETE ON shipment_recipient_snapshots BEGIN SELECT RAISE(ABORT,'shipment recipient snapshot is immutable'); END;
  CREATE TRIGGER trg_geliver_provider_shipments_immutable_update BEFORE UPDATE ON geliver_provider_shipments BEGIN SELECT RAISE(ABORT,'geliver provider shipment evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_provider_shipments_immutable_delete BEFORE DELETE ON geliver_provider_shipments BEGIN SELECT RAISE(ABORT,'geliver provider shipment evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_offers_immutable_update BEFORE UPDATE ON geliver_offer_observations BEGIN SELECT RAISE(ABORT,'geliver offer evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_offers_immutable_delete BEFORE DELETE ON geliver_offer_observations BEGIN SELECT RAISE(ABORT,'geliver offer evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_selections_immutable_update BEFORE UPDATE ON geliver_offer_selections BEGIN SELECT RAISE(ABORT,'geliver offer selection is immutable'); END;
  CREATE TRIGGER trg_geliver_selections_immutable_delete BEFORE DELETE ON geliver_offer_selections BEGIN SELECT RAISE(ABORT,'geliver offer selection is immutable'); END;
  CREATE TRIGGER trg_geliver_booking_facts_immutable_update BEFORE UPDATE ON geliver_booking_facts BEGIN SELECT RAISE(ABORT,'geliver booking evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_booking_facts_immutable_delete BEFORE DELETE ON geliver_booking_facts BEGIN SELECT RAISE(ABORT,'geliver booking evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_labels_immutable_update BEFORE UPDATE ON geliver_label_observations BEGIN SELECT RAISE(ABORT,'geliver label evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_labels_immutable_delete BEFORE DELETE ON geliver_label_observations BEGIN SELECT RAISE(ABORT,'geliver label evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_tracking_immutable_update BEFORE UPDATE ON geliver_tracking_observations BEGIN SELECT RAISE(ABORT,'geliver tracking evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_tracking_immutable_delete BEFORE DELETE ON geliver_tracking_observations BEGIN SELECT RAISE(ABORT,'geliver tracking evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_cancel_immutable_update BEFORE UPDATE ON geliver_cancellation_facts BEGIN SELECT RAISE(ABORT,'geliver cancellation evidence is immutable'); END;
  CREATE TRIGGER trg_geliver_cancel_immutable_delete BEFORE DELETE ON geliver_cancellation_facts BEGIN SELECT RAISE(ABORT,'geliver cancellation evidence is immutable'); END;
`;

export const SHIPMENT_CARRIER_SCHEMA_V82 = String.raw`
  CREATE TABLE shipment_preparations (
    id                         TEXT PRIMARY KEY,
    order_id                   TEXT NOT NULL,
    reservation_id             TEXT NOT NULL UNIQUE,
    state                      TEXT NOT NULL CHECK(state IN (
      'PREPARING','CARRIER_SELECTED','BOOKED','LABEL_READY','HANDED_OFF','DISPATCHED','CANCELLED','EXCEPTION'
    )),
    package_count              INTEGER NOT NULL DEFAULT 0 CHECK(package_count >= 0),
    carrier_selection_id       TEXT,
    created_operation_id       TEXT NOT NULL UNIQUE,
    handoff_operation_id       TEXT UNIQUE,
    cancellation_operation_id  TEXT UNIQUE,
    version                    INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at                 DATETIME NOT NULL,
    updated_at                 DATETIME NOT NULL,
    handed_off_at              DATETIME,
    dispatched_at              DATETIME,
    cancelled_at               DATETIME,
    FOREIGN KEY(order_id) REFERENCES sales(id) ON DELETE RESTRICT,
    FOREIGN KEY(reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_packages (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    package_number             INTEGER NOT NULL CHECK(package_number > 0),
    measurement_source         TEXT NOT NULL CHECK(measurement_source IN ('MEASURED','RECIPE_ESTIMATE')),
    length_mm                  INTEGER NOT NULL CHECK(length_mm > 0),
    width_mm                   INTEGER NOT NULL CHECK(width_mm > 0),
    height_mm                  INTEGER NOT NULL CHECK(height_mm > 0),
    weight_grams               INTEGER NOT NULL CHECK(weight_grams > 0),
    recipe_version_ref         TEXT,
    recipe_hash                TEXT CHECK(recipe_hash IS NULL OR length(recipe_hash)=64),
    contents_snapshot_json     TEXT NOT NULL,
    contents_snapshot_hash     TEXT NOT NULL CHECK(length(contents_snapshot_hash)=64),
    created_operation_id       TEXT NOT NULL,
    created_actor_id           TEXT NOT NULL,
    created_at                 DATETIME NOT NULL,
    UNIQUE(shipment_id, package_number),
    CHECK((measurement_source='MEASURED' AND recipe_version_ref IS NULL AND recipe_hash IS NULL) OR
          (measurement_source='RECIPE_ESTIMATE' AND recipe_version_ref IS NOT NULL AND recipe_hash IS NOT NULL)),
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_carrier_selections (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    provider                   TEXT NOT NULL CHECK(provider='GELIVER'),
    carrier_code               TEXT NOT NULL,
    service_code               TEXT NOT NULL,
    quote_id                   TEXT NOT NULL,
    quote_amount_minor         INTEGER NOT NULL CHECK(quote_amount_minor >= 0),
    quote_currency             TEXT NOT NULL CHECK(length(quote_currency)=3),
    quote_provenance_json      TEXT NOT NULL,
    selected_operation_id      TEXT NOT NULL UNIQUE,
    selected_actor_id          TEXT NOT NULL,
    selected_actor_name        TEXT,
    selected_at                DATETIME NOT NULL,
    UNIQUE(shipment_id, id),
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_booking_jobs (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    package_id                 TEXT NOT NULL UNIQUE,
    provider                   TEXT NOT NULL CHECK(provider='GELIVER'),
    request_identity           TEXT NOT NULL UNIQUE,
    request_json               TEXT NOT NULL,
    request_hash               TEXT NOT NULL CHECK(length(request_hash)=64),
    state                      TEXT NOT NULL CHECK(state IN ('PENDING','PROCESSING','RETRY','SUCCEEDED','BLOCKED_UNCERTAIN','FAILED','CANCELLED')),
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    available_at               DATETIME NOT NULL,
    lease_token                TEXT,
    lease_expires_at           DATETIME,
    last_error_code            TEXT,
    created_operation_id       TEXT NOT NULL,
    created_at                 DATETIME NOT NULL,
    updated_at                 DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_booking_attempts (
    id                         TEXT PRIMARY KEY,
    job_id                     TEXT NOT NULL,
    attempt_number             INTEGER NOT NULL CHECK(attempt_number > 0),
    state                      TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','DEFINITIVE_FAILURE','UNCERTAIN')),
    provider_response_reference TEXT,
    error_code                 TEXT,
    started_at                 DATETIME NOT NULL,
    completed_at               DATETIME,
    UNIQUE(job_id, attempt_number),
    FOREIGN KEY(job_id) REFERENCES shipment_booking_jobs(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_provider_bookings (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    package_id                 TEXT NOT NULL UNIQUE,
    provider                   TEXT NOT NULL CHECK(provider='GELIVER'),
    provider_shipment_id       TEXT NOT NULL UNIQUE,
    provider_transaction_id    TEXT,
    carrier_code               TEXT NOT NULL,
    service_code               TEXT NOT NULL,
    request_identity           TEXT NOT NULL UNIQUE,
    request_hash               TEXT NOT NULL CHECK(length(request_hash)=64),
    provider_response_reference TEXT NOT NULL,
    tracking_number            TEXT NOT NULL,
    tracking_url               TEXT,
    booked_at                  DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_labels (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    package_id                 TEXT NOT NULL UNIQUE,
    provider_booking_id        TEXT NOT NULL UNIQUE,
    provider                   TEXT NOT NULL CHECK(provider='GELIVER'),
    label_reference            TEXT NOT NULL,
    label_sha256               TEXT NOT NULL CHECK(length(label_sha256)=64),
    media_type                 TEXT NOT NULL,
    width_mm                   INTEGER NOT NULL CHECK(width_mm=100),
    height_mm                  INTEGER NOT NULL CHECK(height_mm=150),
    dpi                        INTEGER NOT NULL CHECK(dpi=203),
    printer_compatibility      TEXT NOT NULL CHECK(printer_compatibility='XPRINTER_XP_470B_203DPI'),
    created_at                 DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(package_id) REFERENCES shipment_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(provider_booking_id) REFERENCES shipment_provider_bookings(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_state_events (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL,
    from_state                 TEXT,
    to_state                   TEXT NOT NULL CHECK(to_state IN (
      'PREPARING','CARRIER_SELECTED','BOOKED','LABEL_READY','HANDED_OFF','DISPATCHED','CANCELLED','EXCEPTION'
    )),
    operation_id               TEXT NOT NULL,
    actor_id                   TEXT NOT NULL,
    evidence_json              TEXT NOT NULL,
    occurred_at                DATETIME NOT NULL,
    UNIQUE(shipment_id, operation_id, to_state),
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_cancellations (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL UNIQUE,
    reason                     TEXT NOT NULL,
    provider_cancellation_ids_json TEXT NOT NULL,
    provider_provenance_json   TEXT NOT NULL,
    operation_id               TEXT NOT NULL UNIQUE,
    actor_id                   TEXT NOT NULL,
    cancelled_at               DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_actual_charge_facts (
    id                         TEXT PRIMARY KEY,
    shipment_id                TEXT NOT NULL UNIQUE,
    amount_minor               INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency                   TEXT NOT NULL CHECK(length(currency)=3),
    provenance_json            TEXT NOT NULL,
    finance_operation_id       TEXT NOT NULL UNIQUE,
    recorded_at                DATETIME NOT NULL,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_shipment_outbound_jobs (
    id                         TEXT PRIMARY KEY,
    account_id                 TEXT NOT NULL,
    shipment_id                TEXT NOT NULL,
    channel_order_id           TEXT NOT NULL,
    job_kind                   TEXT NOT NULL CHECK(job_kind='TRACKING_STATUS'),
    source_version             TEXT NOT NULL,
    payload_json               TEXT NOT NULL,
    payload_hash               TEXT NOT NULL CHECK(length(payload_hash)=64),
    state                      TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RETRY','SUCCEEDED','FAILED','BLOCKED')),
    created_operation_id       TEXT NOT NULL,
    available_at               DATETIME NOT NULL,
    created_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, shipment_id, job_kind, source_version),
    FOREIGN KEY(account_id) REFERENCES channel_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY(shipment_id) REFERENCES shipment_preparations(id) ON DELETE RESTRICT,
    FOREIGN KEY(channel_order_id) REFERENCES channel_orders(id) ON DELETE RESTRICT
  );

  CREATE TABLE shipment_notification_policies (
    source_channel             TEXT PRIMARY KEY,
    email_enabled              INTEGER NOT NULL CHECK(email_enabled IN (0,1)),
    sms_enabled                INTEGER NOT NULL DEFAULT 0 CHECK(sms_enabled IN (0,1)),
    updated_operation_id       TEXT NOT NULL,
    updated_actor_id           TEXT NOT NULL,
    updated_at                 DATETIME NOT NULL
  );

  CREATE INDEX idx_shipments_order ON shipment_preparations(order_id, state);
  CREATE INDEX idx_shipment_booking_ready ON shipment_booking_jobs(state, available_at);
  CREATE INDEX idx_shipment_state_events ON shipment_state_events(shipment_id, occurred_at);
  CREATE INDEX idx_channel_shipment_jobs_ready ON channel_shipment_outbound_jobs(state, available_at, account_id);

  CREATE TRIGGER trg_shipment_packages_immutable_update BEFORE UPDATE ON shipment_packages
    BEGIN SELECT RAISE(ABORT, 'shipment package snapshot is immutable'); END;
  CREATE TRIGGER trg_shipment_packages_immutable_delete BEFORE DELETE ON shipment_packages
    BEGIN SELECT RAISE(ABORT, 'shipment package snapshot is immutable'); END;
  CREATE TRIGGER trg_shipment_selections_immutable_update BEFORE UPDATE ON shipment_carrier_selections
    BEGIN SELECT RAISE(ABORT, 'shipment carrier selection is immutable'); END;
  CREATE TRIGGER trg_shipment_selections_immutable_delete BEFORE DELETE ON shipment_carrier_selections
    BEGIN SELECT RAISE(ABORT, 'shipment carrier selection is immutable'); END;
  CREATE TRIGGER trg_shipment_bookings_immutable_update BEFORE UPDATE ON shipment_provider_bookings
    BEGIN SELECT RAISE(ABORT, 'shipment provider booking is immutable'); END;
  CREATE TRIGGER trg_shipment_bookings_immutable_delete BEFORE DELETE ON shipment_provider_bookings
    BEGIN SELECT RAISE(ABORT, 'shipment provider booking is immutable'); END;
  CREATE TRIGGER trg_shipment_labels_immutable_update BEFORE UPDATE ON shipment_labels
    BEGIN SELECT RAISE(ABORT, 'shipment label provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_labels_immutable_delete BEFORE DELETE ON shipment_labels
    BEGIN SELECT RAISE(ABORT, 'shipment label provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_events_immutable_update BEFORE UPDATE ON shipment_state_events
    BEGIN SELECT RAISE(ABORT, 'shipment state history is immutable'); END;
  CREATE TRIGGER trg_shipment_events_immutable_delete BEFORE DELETE ON shipment_state_events
    BEGIN SELECT RAISE(ABORT, 'shipment state history is immutable'); END;
  CREATE TRIGGER trg_shipment_charges_immutable_update BEFORE UPDATE ON shipment_actual_charge_facts
    BEGIN SELECT RAISE(ABORT, 'shipment actual charge provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_charges_immutable_delete BEFORE DELETE ON shipment_actual_charge_facts
    BEGIN SELECT RAISE(ABORT, 'shipment actual charge provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_cancellations_immutable_update BEFORE UPDATE ON shipment_cancellations
    BEGIN SELECT RAISE(ABORT, 'shipment cancellation provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_cancellations_immutable_delete BEFORE DELETE ON shipment_cancellations
    BEGIN SELECT RAISE(ABORT, 'shipment cancellation provenance is immutable'); END;
  CREATE TRIGGER trg_shipment_preparations_no_delete BEFORE DELETE ON shipment_preparations
    BEGIN SELECT RAISE(ABORT, 'shipment history cannot be erased'); END;
  CREATE TRIGGER trg_shipment_state_transition_guard BEFORE UPDATE OF state ON shipment_preparations
    WHEN NOT (
      (OLD.state='PREPARING' AND NEW.state IN ('CARRIER_SELECTED','CANCELLED','EXCEPTION')) OR
      (OLD.state='CARRIER_SELECTED' AND NEW.state IN ('BOOKED','CANCELLED','EXCEPTION')) OR
      (OLD.state='BOOKED' AND NEW.state IN ('LABEL_READY','CANCELLED','EXCEPTION')) OR
      (OLD.state='LABEL_READY' AND NEW.state IN ('HANDED_OFF','CANCELLED','EXCEPTION')) OR
      (OLD.state='HANDED_OFF' AND NEW.state IN ('DISPATCHED','EXCEPTION')) OR
      OLD.state=NEW.state
    )
    BEGIN SELECT RAISE(ABORT, 'invalid shipment state transition'); END;
`;

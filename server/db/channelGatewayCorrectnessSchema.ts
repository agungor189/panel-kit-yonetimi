// Forward-only V2-12 correctness extension. V79/v80 remain frozen.
// Shipment-package projections are current-state indexes over immutable inbound
// events and immutable normalized package-version evidence.
export const CHANNEL_GATEWAY_CORRECTNESS_SCHEMA_V81 = `
  ALTER TABLE channel_inbound_events ADD COLUMN external_order_id TEXT;
  ALTER TABLE channel_inbound_events ADD COLUMN package_versions_json TEXT;

  ALTER TABLE channel_order_lines ADD COLUMN external_package_id TEXT;
  ALTER TABLE channel_order_lines ADD COLUMN provider_gross_minor INTEGER CHECK(provider_gross_minor IS NULL OR provider_gross_minor>=0);
  ALTER TABLE channel_order_lines ADD COLUMN provider_seller_discount_minor INTEGER CHECK(provider_seller_discount_minor IS NULL OR provider_seller_discount_minor>=0);
  ALTER TABLE channel_order_lines ADD COLUMN provider_ty_discount_minor INTEGER CHECK(provider_ty_discount_minor IS NULL OR provider_ty_discount_minor>=0);
  ALTER TABLE channel_order_lines ADD COLUMN provider_customer_total_minor INTEGER CHECK(provider_customer_total_minor IS NULL OR provider_customer_total_minor>=0);
  ALTER TABLE channel_order_lines ADD COLUMN provider_financial_provenance_json TEXT;

  CREATE TABLE channel_order_packages (
    id TEXT PRIMARY KEY,
    channel_order_id TEXT NOT NULL,
    external_package_id TEXT NOT NULL,
    latest_external_version TEXT NOT NULL,
    latest_provider_occurred_at DATETIME NOT NULL,
    package_state TEXT NOT NULL CHECK(package_state IN ('ACTIVE','CANCELLED','RETURNED')),
    currency TEXT NOT NULL CHECK(length(currency)=3),
    package_gross_minor INTEGER NOT NULL CHECK(package_gross_minor>=0),
    package_seller_discount_minor INTEGER NOT NULL CHECK(package_seller_discount_minor>=0),
    package_ty_discount_minor INTEGER NOT NULL CHECK(package_ty_discount_minor>=0),
    package_total_discount_minor INTEGER NOT NULL CHECK(package_total_discount_minor>=0),
    package_total_price_minor INTEGER NOT NULL CHECK(package_total_price_minor>=0),
    latest_event_id TEXT NOT NULL,
    financial_provenance_json TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK(package_total_discount_minor=package_seller_discount_minor+package_ty_discount_minor),
    CHECK(package_total_price_minor=package_gross_minor-package_total_discount_minor),
    UNIQUE(channel_order_id,external_package_id),
    FOREIGN KEY(channel_order_id) REFERENCES channel_orders(id) ON DELETE RESTRICT,
    FOREIGN KEY(latest_event_id) REFERENCES channel_inbound_events(id) ON DELETE RESTRICT
  );

  CREATE TABLE channel_order_package_versions (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    inbound_event_id TEXT NOT NULL,
    external_version TEXT NOT NULL,
    provider_occurred_at DATETIME NOT NULL,
    package_state TEXT NOT NULL CHECK(package_state IN ('ACTIVE','CANCELLED','RETURNED')),
    currency TEXT NOT NULL CHECK(length(currency)=3),
    package_gross_minor INTEGER NOT NULL CHECK(package_gross_minor>=0),
    package_seller_discount_minor INTEGER NOT NULL CHECK(package_seller_discount_minor>=0),
    package_ty_discount_minor INTEGER NOT NULL CHECK(package_ty_discount_minor>=0),
    package_total_discount_minor INTEGER NOT NULL CHECK(package_total_discount_minor>=0),
    package_total_price_minor INTEGER NOT NULL CHECK(package_total_price_minor>=0),
    financial_provenance_json TEXT NOT NULL,
    recorded_at DATETIME NOT NULL,
    CHECK(package_total_discount_minor=package_seller_discount_minor+package_ty_discount_minor),
    CHECK(package_total_price_minor=package_gross_minor-package_total_discount_minor),
    UNIQUE(package_id,external_version),
    FOREIGN KEY(package_id) REFERENCES channel_order_packages(id) ON DELETE RESTRICT,
    FOREIGN KEY(inbound_event_id) REFERENCES channel_inbound_events(id) ON DELETE RESTRICT
  );

  CREATE INDEX idx_channel_packages_order_state
    ON channel_order_packages(channel_order_id,package_state,external_package_id);
  CREATE INDEX idx_channel_package_versions_event
    ON channel_order_package_versions(inbound_event_id,package_id);

  CREATE TRIGGER channel_inbound_package_identity_immutable
  BEFORE UPDATE OF external_order_id,package_versions_json ON channel_inbound_events
  BEGIN SELECT RAISE(ABORT,'channel inbound package identity is immutable'); END;
  CREATE TRIGGER channel_order_package_versions_no_update
  BEFORE UPDATE ON channel_order_package_versions
  BEGIN SELECT RAISE(ABORT,'channel package version evidence is immutable'); END;
  CREATE TRIGGER channel_order_package_versions_no_delete
  BEFORE DELETE ON channel_order_package_versions
  BEGIN SELECT RAISE(ABORT,'channel package version evidence is immutable'); END;
`;

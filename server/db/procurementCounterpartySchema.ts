// Forward only: retain unknown historical counterparties without inferring or repairing them.
export const PROCUREMENT_COUNTERPARTY_SCHEMA_V99 = `
  ALTER TABLE purchase_cost_component_details ADD COLUMN counterparty TEXT
    CHECK(counterparty IS NULL OR counterparty IN ('SUPPLIER','THIRD_PARTY'));
`;

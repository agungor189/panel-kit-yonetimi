// Existing costs retain NULL (unknown/legacy policy); no business data is rewritten.
export const PROCUREMENT_COST_VAT_SCHEMA_V104 = `
 ALTER TABLE procurement_import_draft_costs ADD COLUMN vat_rate_bps INTEGER
   CHECK(vat_rate_bps IS NULL OR (typeof(vat_rate_bps)='integer' AND vat_rate_bps BETWEEN 0 AND 10000));
 ALTER TABLE purchase_cost_component_details ADD COLUMN inventory_vat_included INTEGER
   CHECK(inventory_vat_included IS NULL OR inventory_vat_included IN (0,1));
`;

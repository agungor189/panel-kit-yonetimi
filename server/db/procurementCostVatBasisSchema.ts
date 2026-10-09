// Preserve the v104 meaning of existing input amounts; only new writes use INCLUDED.
export const PROCUREMENT_COST_VAT_BASIS_SCHEMA_V105 = `
 ALTER TABLE procurement_import_draft_costs ADD COLUMN vat_mode TEXT NOT NULL DEFAULT 'EXCLUDED'
   CHECK(vat_mode IN ('EXCLUDED','INCLUDED'));
`;

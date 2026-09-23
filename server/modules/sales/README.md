# Sales financial snapshots (V2-09)

`SalesFinancialService` is the P-owned command/query boundary for immutable sale economics.

## Contracts

- `POST /api/sales` requires currency, integer-minor-unit line prices, per-line VAT basis points, frozen commission terms/basis, discount minor units, and explicit `KNOWN`/`UNKNOWN` shipping, packaging, and other expense facts.
- `GET /api/sales/:id/financial` returns `dsdst.sale-financial.v1` with `COGS_PENDING`, `PROVISIONAL`, `FINAL`, or `LEGACY_UNSNAPSHOTTED` state.
- `POST /api/sales/:id/financial-expenses` appends a new versioned expense fact through `CommandExecutor`; it never overwrites a prior fact.
- Approved inventory dispatch finalizes COGS from the exact V2-07 FIFO reservation allocations and each lot's V2-06 acquisition-cost snapshot in the same command transaction.

The authoritative tables are `sale_financial_snapshots`, `sale_financial_lines`,
`sale_financial_line_components`, `sale_financial_expense_facts`,
`sale_financial_cogs_finalizations`, and `sale_financial_cogs_allocations`.
All snapshot/allocation rows are protected by immutable triggers.

Advertising is a general DSDST operating/marketing expense, not a sale or product expense. New sale commands reject an `advertising` expense fact and record advertising through the normal `/api/expenses` flow with the `Marketing` category. The V2-09 schema and legacy `ADVERTISING`/`sales.ad_spend` fields remain unchanged solely for historical compatibility; new sales leave them unused. Legacy advertising remains readable but is excluded from known sale expenses, completeness/finality, and net contribution. Existing immutable facts are not rewritten, and a future return/refund flow must not reverse advertising expense.

## Migration and rollback

Migration v74 adds empty tables, indexes, and triggers only. It intentionally does not backfill legacy sales, VAT, commission, FX, expenses, or cost. Existing rows therefore query as `LEGACY_UNSNAPSHOTTED`.

The migration is forward-only. Rollback requires restoring the pre-migration database/release as one compatible recovery set; dropping these tables in place is not a supported rollback or data repair.

## Deferred beyond V2-09

Returns, refunds, reversals, settlement differences, marketplace reconciliation, and post-dispatch accounting corrections remain V2-10/V2-12/V2-15 work. V2-09 does not mutate original sale snapshots for those events.

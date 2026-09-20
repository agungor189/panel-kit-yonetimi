# Command foundation (V2-04)

`CommandExecutor` is the transaction boundary for adopted critical mutations.
The owning domain handler, committed result, append-only audit row and any
outbox messages run under one SQLite `BEGIN IMMEDIATE` transaction.

The idempotency scope is `(human actor, service actor, command type,
operation_id)`. Payloads are canonicalized without persistence and only their
SHA-256 digest is stored. A matching committed operation replays its stored
HTTP status/body; a different digest fails with `409
IDEMPOTENCY_KEY_CONFLICT`. Handler failures roll back every row, so the same
operation can be retried safely.

Callers must pass only allowlisted, non-secret correlation/request metadata and
must keep command results free of secrets and unnecessary customer data. The
foundation intentionally has no connector, carrier or printer dispatcher; a
future domain-owned worker may advance only the mutable delivery-state columns
of `command_outbox`.

## Migration and rollback

Migration v63 is additive. It creates `command_operations`,
`command_audit_log`, `command_outbox`, indexes and immutability triggers. It
does not backfill, reinterpret or repair existing business data. Fresh
databases and supported v48/v53 upgrades converge to the same schema.

Pre-v63 application code fails closed when it sees the newer migration record,
so binary rollback requires restoring the pre-v63 database backup as a whole.
After v63 accepts real commands, do not drop or rewrite these tables; recover
with a forward corrective migration or an approved whole-database restore.

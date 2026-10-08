# Package label revisions

P owns the existing print jobs, attempts and audit events. Forward migration v100
adds revision links and a submission fence without rewriting historical snapshots.
A new package snapshot supersedes all currently valid jobs for that package in the
same immediate SQLite transaction as insertion. Unsent jobs are cancelled, including
reprints. Historical competing roots are held (not rewritten by migration) until
an explicit new package-label request links and supersedes them. Historical failed
attempts with a rendered artifact but no reliable delivery evidence are treated as
possibly submitted, requiring replacement acknowledgement. Current identical content deduplicates; a return to earlier content creates
a new revision. Location/shipping snapshot deduplication remains unchanged.

The worker checks current revision and lease when claiming, after rendering and at
`beginSubmission`. That method stores `submission_started_at` under the same SQLite
write lock used by supersession. If correction wins, submission is rejected. If the
send fence wins, the old job is never assumed cancelled and the replacement is held.
A send error records DELIVERY_UNKNOWN. The exact leased attempt can finish recording
its delivery outcome even after supersession; an obsolete renderer cannot revive it.

`POST /admin/print-jobs/:id/acknowledge-replacement` requires the live human printing
capability, an operation identity and literal `oldLabelRemovedOrReplaced: true`.
Warehouse's Print Jobs view shows “Eski etiketi çıkar/değiştir” and asks for explicit
confirmation. The backend rejects acknowledgement while an old fenced send remains
unfinished. Lease expiry alone is not evidence that a paused sender cannot still
submit; an unresolved/crashed sender therefore keeps the replacement blocked rather
than allowing overlapping physical sends. No automatic retry of uncertain delivery
is introduced. Existing print confirmations remain distinct from replacement approval.

Superseded jobs cannot be reprinted; API errors identify the current original job.
History, payload/template snapshots, package identity, stock and receipts are retained.
Tests use synthetic databases, fixture renderer sockets and fake submit callbacks only.

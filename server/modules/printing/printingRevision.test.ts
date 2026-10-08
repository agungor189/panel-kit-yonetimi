import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../db/initialize.js';
import { PrintingService, type TemplateSnapshot } from './printingService.js';
import { startPrintQueueWorker } from '../../services/printQueueWorker.js';
const template: TemplateSnapshot = { id: 'identity', name: 'Identity', purpose: 'goods_receipt', width: 100, height: 150, version: 1, contentHash: 'a'.repeat(64), elements: [{ type: 'barcode', value: '{Package_code}' }] };
const setup = () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initializeDatabase(db);
  db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES ('op','op','fixture','admin',1)").run();
  const service = new PrintingService(db);
  const queue = (quantity: number, operationId: string) => service.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', subjectId: 'package1', subjectCode: 'PKG-1', payload: { Package_code: 'PKG-1', Paket_ici_adet: String(quantity) }, template, operationId, actorId: 'op' });
  return { db, service, queue };
};

test('30→29 atomically invalidates old queued jobs/reprints, preserves history and blocks stale reprint', () => {
  const { db, service, queue } = setup();
  const old = queue(30, 'old');
  const reprint = service.reprint({ originalJobId: old.id, reason: 'LOST', operationId: 'old-copy', actorId: 'op' });
  const next = queue(29, 'next');
  assert.equal(next.supersedes_job_id, old.id);
  for (const id of [old.id, reprint.id]) {
    assert.equal(service.getJob(id).superseded_by_job_id, next.id);
    assert.equal(service.getJob(id).status, 'CANCELLED');
    assert.throws(() => service.reprint({ originalJobId: id, reason: 'LOST', operationId: `stale-${id}`, actorId: 'op' }), (e: any) => e.code === 'PRINT_VERSION_SUPERSEDED' && e.message.includes(next.id));
  }
  assert.equal(queue(29, 'next').id, next.id);
  assert.equal(queue(29, 'same-content-new-operation').id, next.id);
  assert.equal(service.claimNext('worker')!.job.id, next.id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM printing_jobs').pluck().get(), 3);
  for (const table of ['inventory_ledger_events','warehouse_execution_packages']) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
  db.close();
});

test('30→29→30 creates a fresh current revision rather than reviving the old hash', () => {
  const { db, service, queue } = setup();
  const a = queue(30, 'a'), b = queue(29, 'b'), c = queue(30, 'c');
  assert.notEqual(c.id, a.id); assert.equal(c.supersedes_job_id, b.id);
  assert.equal(service.getJob(a.id).current_job_id, c.id);
  assert.equal(queue(30, 'd').id, c.id);
  assert.throws(() => queue(28, 'c'), /Operation key/);
  assert.equal(service.getJob(c.id).superseded_by_job_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) FROM printing_jobs').pluck().get(), 3);
  db.close();
});

test('rendered old lease is fenced out before submission and cannot overwrite cancellation', () => {
  const { db, service, queue } = setup();
  const old = queue(30, 'a'), claim = service.claimNext('worker')!;
  service.mark(old.id, claim.attemptId, 'RENDERED', {}, 'worker', claim.leaseToken);
  const current = queue(29, 'b');
  assert.throws(() => service.beginSubmission(old.id, claim.attemptId, claim.leaseToken, 'worker'), /superseded|Geçersiz/i);
  assert.equal(service.getJob(old.id).status, 'CANCELLED');
  assert.equal(service.claimNext('other')!.job.id, current.id);
  db.close();
});

test('submission fence wins race: old delivery is not cancelled and new dispatch requires explicit replacement acknowledgement', () => {
  const { db, service, queue } = setup();
  const old = queue(30, 'a'), claim = service.claimNext('worker')!;
  service.mark(old.id, claim.attemptId, 'RENDERED', {}, 'worker', claim.leaseToken);
  service.beginSubmission(old.id, claim.attemptId, claim.leaseToken, 'worker');
  const next = queue(29, 'b');
  assert.equal(service.getJob(old.id).status, 'RENDERED');
  assert.equal(next.replacement_blocked, true);
  assert.match(next.replacement_warning, /Eski etiketi çıkar\/değiştir/);
  assert.equal(service.claimNext('other'), null);
  assert.throws(() => service.acknowledgeReplacement(next.id, true, 'ack-early', 'op'), /devam|flight/i);
  service.mark(old.id, claim.attemptId, 'SUBMITTED', { spoolReference: 'fixture' }, 'worker', claim.leaseToken);
  service.mark(old.id, claim.attemptId, 'DELIVERY_UNKNOWN', {}, 'worker', claim.leaseToken);
  assert.throws(() => service.acknowledgeReplacement(next.id, false, 'no', 'op'), /onay/);
  service.acknowledgeReplacement(next.id, true, 'ack', 'op');
  service.acknowledgeReplacement(next.id, true, 'ack', 'op');
  assert.equal(service.claimNext('other')!.job.id, next.id);
  assert.equal(service.getJob(old.id).status, 'DELIVERY_UNKNOWN');
  db.close();
});

test('submitted revision remains invalid across 30→29→30; replacement hold propagates', () => {
  const { db, service, queue } = setup();
  const a = queue(30, 'a'), claim = service.claimNext('worker')!;
  service.mark(a.id, claim.attemptId, 'RENDERED', {}, 'worker', claim.leaseToken);
  service.beginSubmission(a.id, claim.attemptId, claim.leaseToken, 'worker');
  service.mark(a.id, claim.attemptId, 'SUBMITTED', {}, 'worker', claim.leaseToken);
  const b = queue(29, 'b'), c = queue(30, 'c');
  assert.notEqual(c.id, a.id); assert.equal(c.replacement_blocked, true);
  assert.throws(() => service.acknowledgeReplacement(b.id, true, 'stale-ack', 'op'), /Geçersiz/);
  assert.throws(() => service.reprint({ originalJobId: c.id, reason: 'LOST', operationId: 'blocked-copy', actorId: 'op' }), /Eski etiketi/);
  assert.equal(service.claimNext('other'), null);
  db.close();
});

async function rendererFixture(action: (base: string, release: () => void, entered: Promise<void>) => Promise<void>, hold = false) {
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(r => release = r), entered = new Promise<void>(r => enter = r);
  const app = express(); app.post('/api/v1/render', async (_req, res) => { enter(); if (hold) await gate; res.type('application/pdf').send('%PDF-fixture'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try { await action(`http://127.0.0.1:${(server.address() as any).port}`, release, entered); }
  finally { release(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}

test('worker race during rendering never sends an invalidated label', async () => {
  const { db, service, queue } = setup(); const old = queue(30, 'a'); let submissions = 0;
  await rendererFixture(async (rendererUrl, release, entered) => {
    const worker = startPrintQueueWorker(db, { rendererUrl, printerName: 'fixture', autoStart: false, logger: { info() {}, warn() {}, error() {} }, submitArtifact: async () => { submissions++; return 'fixture'; } });
    const run = worker.runOnce(); await entered;
    const next = queue(29, 'b'); release(); assert.equal(await run, false); assert.equal(submissions, 0);
    assert.equal(service.getJob(old.id).status, 'CANCELLED');
    assert.equal(await worker.runOnce(), true); assert.equal(submissions, 1);
    assert.equal(service.getJob(next.id).status, 'DELIVERY_UNKNOWN');
  }, true); db.close();
});

test('worker submit race/error stays uncertain, blocks new dispatch until operator acknowledgement', async () => {
  const { db, service, queue } = setup(); const old = queue(30, 'a'); let current: any;
  await rendererFixture(async rendererUrl => {
    const worker = startPrintQueueWorker(db, { rendererUrl, printerName: 'fixture', autoStart: false, logger: { info() {}, warn() {}, error() {} }, submitArtifact: async () => { current = queue(29, 'b'); assert.equal(service.claimNext('racer'), null); throw new Error('spool acknowledgement lost'); } });
    assert.equal(await worker.runOnce(), false);
    assert.equal(service.getJob(old.id).status, 'DELIVERY_UNKNOWN');
    assert.equal(service.getJob(current.id).replacement_blocked, true);
    service.acknowledgeReplacement(current.id, true, 'ack', 'op');
    assert.equal(service.claimNext('next')!.job.id, current.id);
  }); db.close();
});

test('failed replacement rolls back invalidation, cancellations and history with the new insert', () => {
  const { db, service, queue } = setup(); const old = queue(30, 'old');
  const claimed = service.claimNext('worker')!;
  db.exec("CREATE TEMP TRIGGER fail_replacement BEFORE INSERT ON printing_jobs WHEN NEW.created_operation_id='fail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => queue(29, 'fail'), /fixture failure/);
  const kept = service.getJob(old.id);
  assert.equal(kept.status, 'QUEUED'); assert.equal(kept.superseded_by_job_id, null); assert.equal(kept.history.length, 1);
  assert.equal(kept.attempts[0].state, 'STARTED');
  assert.equal(db.prepare('SELECT COUNT(*) FROM printing_jobs').pluck().get(), 1);
  service.mark(old.id, claimed.attemptId, 'RENDERED', {}, 'worker', claimed.leaseToken);
  assert.throws(() => service.beginSubmission(old.id, claimed.attemptId, 'wrong-token', 'worker'), /lease/);
  db.close();
});

test('expired render lease cannot submit; send fence is not released merely by lease expiry', () => {
  const { db, service, queue } = setup(); const old = queue(30, 'old'), first = service.claimNext('worker1')!;
  db.prepare("UPDATE printing_attempts SET lease_expires_at=datetime('now','-1 second') WHERE id=?").run(first.attemptId);
  const second = service.claimNext('worker2')!;
  assert.throws(() => service.mark(old.id, first.attemptId, 'RENDERED', {}, 'worker1', first.leaseToken), /lease/);
  service.mark(old.id, second.attemptId, 'RENDERED', {}, 'worker2', second.leaseToken);
  service.beginSubmission(old.id, second.attemptId, second.leaseToken, 'worker2');
  db.prepare("UPDATE printing_attempts SET lease_expires_at=datetime('now','-1 second') WHERE id=?").run(second.attemptId);
  const current = queue(29, 'new');
  assert.throws(() => service.cancel(old.id, 'cancel', 'op'), /no longer/);
  assert.throws(() => service.acknowledgeReplacement(current.id, true, 'ack', 'op'), /devam/);
  assert.equal(service.claimNext('other'), null);
  db.close();
});

test('historical failed send with a rendered artifact remains uncertain instead of being assumed cancelled', () => {
  const { db, service, queue } = setup(); const old = queue(30, 'old'), claim = service.claimNext('worker')!;
  service.mark(old.id, claim.attemptId, 'RENDERED', { renderedSha256: 'a'.repeat(64) }, 'worker', claim.leaseToken);
  // Models a pre-fence worker failure: old data cannot prove whether spool submission occurred.
  service.mark(old.id, claim.attemptId, 'FAILED', { errorCode: 'PRINT_FAILED' }, 'worker', claim.leaseToken);
  const next = queue(29, 'next');
  assert.equal(service.getJob(old.id).status, 'FAILED'); assert.equal(next.replacement_blocked, true);
  assert.equal(service.claimNext('other'), null);
  service.acknowledgeReplacement(next.id, true, 'ack', 'op');
  assert.equal(service.claimNext('other')!.job.id, next.id);
  db.close();
});

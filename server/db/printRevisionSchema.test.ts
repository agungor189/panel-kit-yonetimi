import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations/runner.js';
import { PrintingService } from '../modules/printing/printingService.js';

test('v100 preserves v99 print snapshots; legacy competing revisions converge only on an explicit new command', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(readFileSync(new URL('./fixtures/panel-v48.sql', import.meta.url), 'utf8')); runMigrations(db, 99);
  db.prepare("INSERT INTO users(id,username,password_hash,role,is_active) VALUES ('printer-fixture','printer-fixture','fixture','admin',1)").run();
  const template = { id: 'old-template', name: 'Fixture', purpose: 'goods_receipt' as const, width: 100, height: 150, version: 1, contentHash: 'a'.repeat(64), elements: [{ type: 'barcode', value: '{Package_code}' }] };
  for (const [id, quantity] of [['old30',30],['old29',29]] as const) db.prepare(`INSERT INTO printing_jobs(id,purpose,subject_type,subject_id,subject_code,request_hash,template_id,template_version,template_content_hash,template_snapshot_json,payload_snapshot_json,payload_snapshot_hash,printable_snapshot_hash,created_operation_id,created_by)
    VALUES (?,'GOODS_RECEIPT_PACKAGE','warehouse_package','fixture-pkg','PKG-1',?,'old-template',1,?,?,?,?,?,?, 'printer-fixture')`).run(id,'b'.repeat(64), template.contentHash, JSON.stringify(template), JSON.stringify({ Package_code: 'PKG-1', Paket_ici_adet: String(quantity) }), 'c'.repeat(64), (quantity === 30 ? 'd' : 'e').repeat(64), `legacy-${id}`);
  const before = db.prepare('SELECT id,status,template_snapshot_json,payload_snapshot_json,printable_snapshot_hash FROM printing_jobs ORDER BY id').all();
  runMigrations(db, 100);
  assert.deepEqual(db.prepare('SELECT id,status,template_snapshot_json,payload_snapshot_json,printable_snapshot_hash FROM printing_jobs ORDER BY id').all(), before);
  const service = new PrintingService(db);
  assert.equal(service.claimNext('legacy-worker'), null);
  assert.throws(() => service.reprint({ originalJobId: 'old30', reason: 'LOST', operationId: 'legacy-copy', actorId: 'printer-fixture' }), /Birden fazla/);
  const next = service.queueTemplateJob({ purpose: 'GOODS_RECEIPT_PACKAGE', subjectId: 'fixture-pkg', subjectCode: 'PKG-1', template, payload: { Package_code: 'PKG-1', Paket_ici_adet: '30' }, operationId: 'new-revision', actorId: 'printer-fixture' });
  for (const old of ['old30','old29']) { assert.equal(service.getJob(old).superseded_by_job_id, next.id); assert.equal(service.getJob(old).status, 'CANCELLED'); }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

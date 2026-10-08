import type Database from 'better-sqlite3';
import { canonicalPayloadHash } from '../commands/commandFoundation.js';
import { CatalogService } from '../catalog/catalogService.js';
import { ProcurementValidationError } from './procurementService.js';
import { parseProcurementImport, type ImportRow } from './procurementImport.js';

const key = (value: string) => value.trim().toLocaleUpperCase('en-US');
const packingDescription = /(?:^|[^\p{L}])[iı]n\s*(?:no|number)\s*:?\s*\d+\s*box\b/iu;
const required = (value: unknown, field: string, max = 300) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new ProcurementValidationError('ALIAS_REPAIR_EVIDENCE_REQUIRED', `${field} gerekli.`);
  return text;
};
type RepairEvidence = { expectedManifestHash: string; backupReference: string; backupSha256: string; approvalReference: string; reason: string };

export class SupplierAliasRepairService {
  private catalog: CatalogService;
  constructor(private db: Database.Database) { this.catalog = new CatalogService(db); }

  private sourceRows(sourceRef: string): ImportRow[] {
    const sourceId = sourceRef.split(':',1)[0];
    const imported = this.db.prepare('SELECT id FROM procurement_imports WHERE id=?').get(sourceId);
    if (imported) return (this.db.prepare('SELECT source_json FROM procurement_import_records WHERE import_id=?').all(sourceId) as Array<{ source_json: string }>).map(r => JSON.parse(r.source_json));
    const draft = this.db.prepare('SELECT source_csv FROM procurement_import_drafts WHERE id=?').get(sourceId) as { source_csv: string } | undefined;
    return draft ? parseProcurementImport(draft.source_csv).rows : [];
  }

  preview(supplierId: string) {
    const supplier = this.db.prepare('SELECT id FROM procurement_suppliers WHERE id=?').get(supplierId);
    if (!supplier) throw new ProcurementValidationError('SUPPLIER_NOT_FOUND','Tedarikçi bulunamadı.',404);
    const aliases = this.db.prepare(`SELECT a.alias,a.product_id,a.source_ref FROM catalog_supplier_aliases a
      WHERE a.supplier_id=? AND NOT EXISTS(SELECT 1 FROM catalog_supplier_alias_retractions r
        WHERE r.supplier_id=a.supplier_id AND r.alias=a.alias) ORDER BY a.alias`).all(supplierId) as Array<{ alias: string; product_id: string; source_ref: string }>;
    const candidates = [] as Array<{ alias: string; productId: string; sourceRef: string; sourceRows: string[] }>;
    for (const alias of aliases) {
      if (!packingDescription.test(alias.alias)) continue;
      const rows = this.sourceRows(alias.source_ref);
      if (!rows.length || rows.some(r => r.record_type === 'PRODUCT' && key(r.supplier_code) === key(alias.alias))) continue;
      if (this.db.prepare('SELECT 1 FROM products WHERE id=? AND supplier_code=? COLLATE NOCASE').get(alias.product_id,alias.alias)) continue;
      const evidence = rows.filter(r => ['LINE','PACKAGE_ITEM'].includes(r.record_type) && key(r.source_supplier_code) === key(alias.alias));
      if (!evidence.length) continue;
      candidates.push({ alias: alias.alias, productId: alias.product_id, sourceRef: alias.source_ref, sourceRows: evidence.map(r => r.record_id) });
    }
    const manifestHash = canonicalPayloadHash({ supplierId, candidates });
    return { supplierId, candidates, manifestHash, dryRun: true, retainedAliasCount: aliases.length - candidates.length };
  }

  private evidence(input: RepairEvidence) {
    const manifestHash = required(input?.expectedManifestHash,'Manifest hash',64);
    const backupReference = required(input?.backupReference,'Yedek referansı');
    const backupSha256 = required(input?.backupSha256,'Yedek SHA-256',64);
    if (!/^[a-f0-9]{64}$/.test(backupSha256)) throw new ProcurementValidationError('ALIAS_REPAIR_EVIDENCE_REQUIRED','Yedek SHA-256 geçersiz.');
    return { manifestHash, backupReference, backupSha256, approvalReference: required(input?.approvalReference,'Onay referansı'), reason: required(input?.reason,'Gerekçe',1000) };
  }

  apply(supplierId: string, input: RepairEvidence, actorId: string) {
    return this.db.transaction(() => {
      const proof = this.evidence(input), preview = this.preview(supplierId);
      if (!preview.candidates.length || preview.manifestHash !== proof.manifestHash)
        throw new ProcurementValidationError('ALIAS_REPAIR_STALE','Düzeltme manifesti değişmiş veya aday kalmamış; kuru çalışmayı yenileyin.',409);
      const now = new Date().toISOString();
      for (const item of preview.candidates) {
        this.db.prepare(`INSERT INTO catalog_supplier_alias_retractions
          (supplier_id,alias,product_id,source_ref,manifest_hash,backup_reference,approval_reference,reason,actor_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(supplierId,item.alias,item.productId,item.sourceRef,proof.manifestHash,
            `${proof.backupReference}#sha256=${proof.backupSha256}`,proof.approvalReference,proof.reason,required(actorId,'actorId'),now);
        if (this.catalog.supplierAlias(supplierId,item.alias) !== null)
          throw new ProcurementValidationError('ALIAS_REPAIR_RECONCILIATION_FAILED','Yanlış alias etkin kaldı.',409);
      }
      return { corrected: preview.candidates, retainedAliasCount: preview.retainedAliasCount, manifestHash: proof.manifestHash };
    }).immediate();
  }

  previewCompensation(supplierId: string, alias: string) {
    const row = this.db.prepare(`SELECT product_id FROM catalog_supplier_alias_retractions r WHERE supplier_id=? AND alias=? COLLATE NOCASE
      AND NOT EXISTS(SELECT 1 FROM catalog_supplier_alias_retraction_reversals v WHERE v.supplier_id=r.supplier_id AND v.alias=r.alias)`)
      .get(supplierId,alias) as { product_id: string } | undefined;
    if (!row) throw new ProcurementValidationError('ALIAS_REPAIR_COMPENSATION_CONFLICT','Geri alınabilir düzeltme bulunamadı.',409);
    return { supplierId, alias, productId: row.product_id,
      manifestHash: canonicalPayloadHash({ supplierId, alias: key(alias), productId: row.product_id, action: 'RESTORE' }), dryRun: true };
  }

  compensate(supplierId: string, alias: string, input: RepairEvidence & { expectedProductId: string }, actorId: string) {
    return this.db.transaction(() => {
      const proof = this.evidence(input), retraction = this.db.prepare(`SELECT product_id FROM catalog_supplier_alias_retractions
        WHERE supplier_id=? AND alias=? COLLATE NOCASE`).get(supplierId,alias) as { product_id: string } | undefined;
      if (!retraction || retraction.product_id !== input.expectedProductId || this.db.prepare(`SELECT 1 FROM catalog_supplier_alias_retraction_reversals
        WHERE supplier_id=? AND alias=? COLLATE NOCASE`).get(supplierId,alias))
        throw new ProcurementValidationError('ALIAS_REPAIR_COMPENSATION_CONFLICT','Geri alma hedefi/sürümü uyuşmuyor.',409);
      const expected = canonicalPayloadHash({ supplierId, alias: key(alias), productId: retraction.product_id, action: 'RESTORE' });
      if (proof.manifestHash !== expected) throw new ProcurementValidationError('ALIAS_REPAIR_STALE','Geri alma manifesti uyuşmuyor.',409);
      this.db.prepare(`INSERT INTO catalog_supplier_alias_retraction_reversals
        (supplier_id,alias,product_id,manifest_hash,backup_reference,approval_reference,reason,actor_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(supplierId,alias,retraction.product_id,expected,
          `${proof.backupReference}#sha256=${proof.backupSha256}`,proof.approvalReference,proof.reason,required(actorId,'actorId'),new Date().toISOString());
      if (this.catalog.supplierAlias(supplierId,alias) !== retraction.product_id)
        throw new ProcurementValidationError('ALIAS_REPAIR_RECONCILIATION_FAILED','Alias geri alma doğrulanamadı.',409);
      return { supplierId, alias, productId: retraction.product_id, manifestHash: expected };
    }).immediate();
  }
}

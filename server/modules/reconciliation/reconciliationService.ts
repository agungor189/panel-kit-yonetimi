import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type FindingSeverity = "INFO" | "WARN" | "CRITICAL";
export type FindingScope = "SKU" | "ORDER" | "SYSTEM";
type Draft = {
  domain: string; code: string; severity: FindingSeverity; affectedType: FindingScope; affectedId: string;
  sourceRef: string; expected: unknown; actual: unknown; autoRepair?: { kind: "CENTRAL_STOCK"; productId: string; value: number };
};

export class ReconciliationError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message); this.name = "ReconciliationError";
  }
}

const json = (value: unknown) => JSON.stringify(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identity = (draft: Draft) => digest([draft.domain, draft.code, draft.affectedType, draft.affectedId, draft.sourceRef].join("\0"));
const now = () => new Date().toISOString();
const required = (value: unknown, field: string, max = 1000) => {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new ReconciliationError("RECONCILIATION_VALIDATION_FAILED", `${field} is invalid.`);
  return result;
};

export class ReconciliationService {
  constructor(private readonly db: Database.Database) {}

  run(input: { trigger: "SCHEDULED" | "MANUAL"; actor: { type: "SYSTEM" | "HUMAN"; id: string }; operationId: string }) {
    const operationId = required(input.operationId, "operationId", 200);
    const actorId = required(input.actor.id, "actor.id", 200);
    const existing = this.db.prepare("SELECT id FROM reconciliation_runs WHERE operation_id=?").get(operationId) as { id: string } | undefined;
    if (existing) return this.getRun(existing.id);
    const runId = randomUUID(); const startedAt = now();
    this.db.prepare(`INSERT INTO reconciliation_runs (id,operation_id,trigger_type,actor_type,actor_id,status,started_at)
      VALUES (?,?,?,?,?,'RUNNING',?)`).run(runId, operationId, input.trigger, input.actor.type, actorId, startedAt);
    try {
      const drafts = this.collect();
      const seen = new Set<string>(); let autoRepairCount = 0;
      this.db.transaction(() => {
        for (const draft of drafts) {
          const key = identity(draft); seen.add(key);
          const prior = this.db.prepare("SELECT * FROM reconciliation_findings WHERE identity_key=?").get(key) as any;
          const findingId = prior?.id || randomUUID();
          let repairStatus = prior?.repair_status || (draft.severity === "CRITICAL" ? "APPROVAL_REQUIRED" : "NOT_APPLICABLE");
          let status = "OPEN";
          if (draft.autoRepair) {
            this.applySafeProjectionRepair(draft.autoRepair);
            repairStatus = "AUTO_REPAIRED"; status = "RESOLVED"; autoRepairCount += 1;
          }
          if (prior) {
            this.db.prepare(`UPDATE reconciliation_findings SET domain=?,code=?,severity=?,affected_type=?,affected_id=?,source_ref=?,
              expected_json=?,actual_json=?,status=?,repair_status=?,last_run_id=?,occurrences=occurrences+1,last_seen_at=?,
              resolved_at=CASE WHEN ?='RESOLVED' THEN ? ELSE NULL END,verified_by_actor_id=NULL,verification_reason=NULL WHERE id=?`)
              .run(draft.domain,draft.code,draft.severity,draft.affectedType,draft.affectedId,draft.sourceRef,json(draft.expected),json(draft.actual),status,repairStatus,runId,startedAt,status,startedAt,findingId);
          } else {
            this.db.prepare(`INSERT INTO reconciliation_findings
              (id,identity_key,domain,code,severity,affected_type,affected_id,source_ref,expected_json,actual_json,status,repair_status,
               first_run_id,last_run_id,occurrences,first_seen_at,last_seen_at,resolved_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(findingId,key,draft.domain,draft.code,draft.severity,draft.affectedType,draft.affectedId,
                draft.sourceRef,json(draft.expected),json(draft.actual),status,repairStatus,runId,runId,startedAt,startedAt,status === "RESOLVED" ? startedAt : null);
          }
          this.history({ findingId, runId, eventType: draft.autoRepair ? "AUTO_REPAIRED" : prior?.status === "RESOLVED" || prior?.status === "VERIFIED" ? "REOPENED" : prior ? "OBSERVED" : "OPENED",
            before: draft.autoRepair ? draft.actual : prior ? JSON.parse(prior.actual_json) : null, after: draft.autoRepair ? draft.expected : draft.actual,
            reason: draft.autoRepair ? "Explicitly safe disposable projection rebuilt from canonical inventory lots." : "Deterministic reconciliation check mismatch.",
            actorType: input.actor.type, actorId, operationId });
          if (draft.severity === "CRITICAL" && draft.affectedType !== "SYSTEM" && !draft.autoRepair) this.activateBlock(findingId, draft, startedAt);
        }
        const openRows = this.db.prepare("SELECT id,identity_key FROM reconciliation_findings WHERE status='OPEN'").all() as Array<{ id: string; identity_key: string }>;
        for (const row of openRows) {
          if (seen.has(row.identity_key)) continue;
          this.db.prepare("UPDATE reconciliation_findings SET status='RESOLVED',resolved_at=? WHERE id=?").run(startedAt,row.id);
          this.db.prepare(`UPDATE reconciliation_blocks SET status='CLEARED',cleared_at=?,cleared_by_actor_id=?,clear_reason='CLEAN_RECHECK'
            WHERE finding_id=? AND status='ACTIVE'`).run(startedAt,actorId,row.id);
          this.history({ findingId: row.id, runId, eventType: "CLEAN_RECHECK", before: { status: "OPEN" }, after: { status: "RESOLVED" },
            reason: "The deterministic check passed on a later complete scan.", actorType: input.actor.type, actorId, operationId });
        }
        const critical = drafts.filter((item) => item.severity === "CRITICAL").length;
        this.db.prepare(`UPDATE reconciliation_runs SET status='COMPLETED',finding_count=?,critical_count=?,auto_repair_count=?,completed_at=? WHERE id=?`)
          .run(drafts.length,critical,autoRepairCount,now(),runId);
      }).immediate();
      return this.getRun(runId);
    } catch (error) {
      this.db.prepare("UPDATE reconciliation_runs SET status='FAILED',error_code=?,completed_at=? WHERE id=?")
        .run(error instanceof ReconciliationError ? error.code : "RECONCILIATION_FAILED",now(),runId);
      throw error;
    }
  }

  private collect(): Draft[] {
    return [
      ...this.inventoryChecks(), ...this.financeChecks(), ...this.kitChecks(), ...this.returnChecks(),
      ...this.channelChecks(), ...this.shipmentChecks(), ...this.printChecks(),
    ];
  }

  private inventoryChecks(): Draft[] {
    const result: Draft[] = [];
    const lots = this.db.prepare(`SELECT l.id,l.product_id,l.on_hand_base_int,l.reserved_base_int,p.sku,
      COALESCE((SELECT SUM(e.quantity_delta_base_int) FROM inventory_ledger_events e WHERE e.lot_id=l.id),0) ledger_total,
      COALESCE((SELECT SUM(b.quantity_base_int) FROM inventory_lot_location_balances b WHERE b.lot_id=l.id AND b.active=1),0) location_total,
      COALESCE((SELECT SUM(a.quantity_base_int) FROM inventory_reservation_allocations a JOIN inventory_reservations r ON r.id=a.reservation_id
        WHERE a.lot_id=l.id AND r.status IN ('ACTIVE','PICKED','PACKED','STOCK_DISCREPANCY')),0) allocated_total,
      (SELECT COUNT(*) FROM warehouse_execution_packages w WHERE w.inventory_lot_id=l.id AND w.disposition='ON_HAND') package_count,
      COALESCE((SELECT SUM(w.remaining_quantity_base_int) FROM warehouse_execution_packages w WHERE w.inventory_lot_id=l.id AND w.disposition='ON_HAND'),0) package_total
      FROM inventory_lots l JOIN products p ON p.id=l.product_id ORDER BY l.id`).all() as any[];
    for (const lot of lots) {
      const scope = lot.sku || lot.product_id;
      if (Number(lot.ledger_total) !== Number(lot.on_hand_base_int)) result.push({ domain:"INVENTORY",code:"INVENTORY_LEDGER_MISMATCH",severity:"CRITICAL",affectedType:"SKU",affectedId:scope,sourceRef:lot.id,expected:{onHandBaseInt:Number(lot.on_hand_base_int)},actual:{ledgerBaseInt:Number(lot.ledger_total)} });
      if (Number(lot.location_total) !== Number(lot.on_hand_base_int)) result.push({ domain:"INVENTORY",code:"INVENTORY_LOCATION_MISMATCH",severity:"CRITICAL",affectedType:"SKU",affectedId:scope,sourceRef:lot.id,expected:{onHandBaseInt:Number(lot.on_hand_base_int)},actual:{locationBaseInt:Number(lot.location_total)} });
      if (Number(lot.package_count) > 0 && Number(lot.package_total) !== Number(lot.location_total)) result.push({ domain:"INVENTORY",code:"INVENTORY_PACKAGE_MISMATCH",severity:"CRITICAL",affectedType:"SKU",affectedId:scope,sourceRef:lot.id,expected:{locationBaseInt:Number(lot.location_total)},actual:{packageBaseInt:Number(lot.package_total)} });
      if (Number(lot.reserved_base_int) > Number(lot.on_hand_base_int) || Number(lot.reserved_base_int) !== Number(lot.allocated_total)) result.push({ domain:"INVENTORY",code:"INVENTORY_RESERVED_MISMATCH",severity:"CRITICAL",affectedType:"SKU",affectedId:scope,sourceRef:lot.id,expected:{reservedBaseInt:Number(lot.allocated_total),maxReservedBaseInt:Number(lot.on_hand_base_int)},actual:{reservedBaseInt:Number(lot.reserved_base_int),availableBaseInt:Number(lot.on_hand_base_int)-Number(lot.reserved_base_int)} });
    }
    const products = this.db.prepare(`SELECT p.id,p.sku,p.central_stock,COALESCE(SUM(l.on_hand_base_int),0) canonical
      FROM products p LEFT JOIN inventory_lots l ON l.product_id=p.id GROUP BY p.id ORDER BY p.id`).all() as any[];
    for (const product of products) if (Number(product.central_stock) !== Number(product.canonical)) result.push({ domain:"INVENTORY",code:"INVENTORY_CENTRAL_STOCK_PROJECTION_DRIFT",severity:"WARN",affectedType:"SKU",affectedId:product.sku || product.id,sourceRef:product.id,expected:{centralStock:Number(product.canonical)},actual:{centralStock:Number(product.central_stock)},autoRepair:{kind:"CENTRAL_STOCK",productId:product.id,value:Number(product.canonical)} });
    return result;
  }

  private financeChecks(): Draft[] {
    const rows = this.db.prepare("SELECT * FROM sale_financial_snapshots ORDER BY id").all() as any[]; const result: Draft[]=[];
    for (const row of rows) {
      const formulaOk = Number(row.gross_before_discount_minor)-Number(row.discount_minor)===Number(row.gross_amount_minor)
        && Number(row.net_revenue_minor)+Number(row.vat_amount_minor)===Number(row.gross_amount_minor)
        && Number(row.commission_amount_minor)>=0 && Number(row.commission_amount_minor)<=Number(row.gross_amount_minor);
      if (!formulaOk) result.push({domain:"FINANCE",code:"SALE_FINANCIAL_TOTAL_MISMATCH",severity:"CRITICAL",affectedType:"ORDER",affectedId:row.sale_id,sourceRef:row.id,
        expected:{gross:Number(row.gross_before_discount_minor)-Number(row.discount_minor),netPlusVat:Number(row.gross_amount_minor),commissionMax:Number(row.gross_amount_minor)},
        actual:{gross:Number(row.gross_amount_minor),netPlusVat:Number(row.net_revenue_minor)+Number(row.vat_amount_minor),commission:Number(row.commission_amount_minor)}});
    }
    return result;
  }

  private kitChecks(): Draft[] {
    return (this.db.prepare(`SELECT s.id,s.sale_line_id,s.version_number,s.content_hash,s.snapshot_json,v.version_number expected_version,v.content_hash expected_hash,fs.sale_id
      FROM sale_kit_version_snapshots s JOIN published_kit_versions v ON v.id=s.published_kit_version_id JOIN sale_financial_lines f ON f.id=s.financial_line_id
      JOIN sale_financial_snapshots fs ON fs.id=f.financial_snapshot_id
      WHERE s.version_number<>v.version_number OR s.content_hash<>v.content_hash ORDER BY s.id`).all() as any[]).map((row)=>({domain:"KIT",code:"SOLD_KIT_FROZEN_VERSION_MISMATCH",severity:"CRITICAL" as const,affectedType:"ORDER" as const,affectedId:row.sale_id,sourceRef:row.id,
        expected:{version:row.expected_version,contentHash:row.expected_hash},actual:{version:row.version_number,contentHash:row.content_hash}}));
  }

  private returnChecks(): Draft[] {
    const result: Draft[]=[];
    for (const row of this.db.prepare(`SELECT r.id,r.return_id,fs.sale_id,r.sale_line_id,r.quantity_base_int,f.quantity_base_int original_quantity,
      (SELECT COALESCE(SUM(r2.quantity_base_int),0) FROM return_request_lines r2 JOIN return_requests rr ON rr.id=r2.return_id WHERE r2.sale_line_id=r.sale_line_id) returned_total
      FROM return_request_lines r JOIN sale_financial_lines f ON f.sale_line_id=r.sale_line_id
      JOIN sale_financial_snapshots fs ON fs.id=f.financial_snapshot_id ORDER BY r.id`).all() as any[]) {
      if(Number(row.returned_total)>Number(row.original_quantity)) result.push({domain:"RETURNS",code:"RETURN_QUANTITY_BOUND_EXCEEDED",severity:"CRITICAL",affectedType:"ORDER",affectedId:row.sale_id,sourceRef:row.sale_line_id,expected:{max:Number(row.original_quantity)},actual:{returned:Number(row.returned_total)}});
    }
    for(const row of this.db.prepare(`SELECT r.sale_id,r.id,s.gross_amount_minor,(SELECT COALESCE(SUM(p.amount_minor),0) FROM refund_payments p WHERE p.return_id=r.id) refunded FROM return_requests r JOIN sale_financial_snapshots s ON s.id=r.financial_snapshot_id`).all() as any[]) {
      if(Number(row.refunded)>Number(row.gross_amount_minor)) result.push({domain:"RETURNS",code:"REFUND_MONEY_BOUND_EXCEEDED",severity:"CRITICAL",affectedType:"ORDER",affectedId:row.sale_id,sourceRef:row.id,expected:{maxMinor:Number(row.gross_amount_minor)},actual:{refundedMinor:Number(row.refunded)}});
    }
    return result;
  }

  private channelChecks(): Draft[] {
    const result: Draft[]=[];
    for(const row of this.db.prepare(`SELECT c.id,c.external_order_id,c.sale_id,c.reservation_id FROM channel_orders c
      WHERE c.order_state IN ('ACCEPTED','RESERVED','FULFILLING','COMPLETED') AND (c.sale_id IS NULL OR c.reservation_id IS NULL) ORDER BY c.id`).all() as any[]) result.push({domain:"CHANNELS",code:"CHANNEL_CANONICAL_LINK_MISMATCH",severity:"CRITICAL",affectedType:"ORDER",affectedId:row.external_order_id,sourceRef:row.id,expected:{canonicalSale:true,reservation:true},actual:{canonicalSale:Boolean(row.sale_id),reservation:Boolean(row.reservation_id)}});
    for(const row of this.db.prepare(`SELECT j.id,j.product_id,j.source_version,b.version,p.sku FROM channel_outbound_jobs j JOIN channel_stock_buffers b ON b.account_id=j.account_id AND b.product_id=j.product_id JOIN products p ON p.id=j.product_id
      WHERE j.job_kind='STOCK' AND j.state IN ('PENDING','LEASED','SUCCEEDED') AND j.source_version<>CAST(b.version AS TEXT) ORDER BY j.id`).all() as any[]) result.push({domain:"CHANNELS",code:"CHANNEL_OUTBOUND_PROJECTION_MISMATCH",severity:"WARN",affectedType:"SKU",affectedId:row.sku||row.product_id,sourceRef:row.id,expected:{sourceVersion:String(row.version)},actual:{sourceVersion:String(row.source_version)}});
    return result;
  }

  private shipmentChecks(): Draft[] {
    return (this.db.prepare(`SELECT s.id,s.order_id,s.reservation_id,r.status reservation_status,r.shipment_id,
      EXISTS(SELECT 1 FROM shipment_state_events e WHERE e.shipment_id=s.id AND e.to_state='HANDED_OFF') handed_off,
      EXISTS(SELECT 1 FROM sale_financial_cogs_finalizations c WHERE c.shipment_id=s.id AND c.reservation_id=s.reservation_id) cogs_finalized
      FROM shipment_preparations s LEFT JOIN inventory_reservations r ON r.id=s.reservation_id WHERE s.state='DISPATCHED' ORDER BY s.id`).all() as any[])
      .filter((row)=>!Number(row.handed_off)||row.reservation_status!=="DISPATCHED"||row.shipment_id!==row.id||!Number(row.cogs_finalized))
      .map((row)=>({domain:"SHIPMENT",code:"SHIPMENT_DISPATCH_CHAIN_MISMATCH",severity:"CRITICAL" as const,affectedType:"ORDER" as const,affectedId:row.order_id,sourceRef:row.id,
        expected:{handoff:true,inventoryDispatch:true,cogsFinalized:true},actual:{handoff:Boolean(row.handed_off),inventoryDispatch:row.reservation_status==="DISPATCHED"&&row.shipment_id===row.id,cogsFinalized:Boolean(row.cogs_finalized)}}));
  }

  private printChecks(): Draft[] {
    const result: Draft[]=[];
    for(const job of this.db.prepare("SELECT * FROM printing_jobs ORDER BY id").all() as any[]) {
      const payloadHash=digest(String(job.payload_snapshot_json));
      const last=this.db.prepare("SELECT to_status FROM printing_events WHERE job_id=? ORDER BY event_index DESC LIMIT 1").get(job.id) as any;
      const reprintOk=!job.original_job_id||Boolean(this.db.prepare("SELECT 1 FROM printing_reprints WHERE reprint_job_id=? AND original_job_id=?").get(job.id,job.original_job_id));
      const chainOk=payloadHash===job.payload_snapshot_hash&&last?.to_status===job.status&&reprintOk;
      if(!chainOk) result.push({domain:"PRINT",code:"PRINT_CHAIN_MISMATCH",severity:"CRITICAL",affectedType:job.subject_type==="ORDER"?"ORDER":"SYSTEM",affectedId:job.subject_code||job.subject_id,sourceRef:job.id,
        expected:{payloadHash,terminalStatus:job.status,reprintLinked:true},actual:{payloadHash:job.payload_snapshot_hash,lastEventStatus:last?.to_status||null,reprintLinked:reprintOk}});
    }
    return result;
  }

  private applySafeProjectionRepair(repair: NonNullable<Draft["autoRepair"]>) {
    if(repair.kind!=="CENTRAL_STOCK") throw new ReconciliationError("UNSAFE_AUTO_REPAIR","Only registered disposable projections may be auto-repaired.",409);
    this.db.prepare("UPDATE products SET central_stock=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(repair.value,repair.productId);
  }

  private activateBlock(findingId:string,draft:Draft,at:string){
    const existing=this.db.prepare("SELECT id,status FROM reconciliation_blocks WHERE finding_id=?").get(findingId) as any;
    if(existing) this.db.prepare("UPDATE reconciliation_blocks SET status='ACTIVE',reason=?,cleared_at=NULL,cleared_by_actor_id=NULL,clear_reason=NULL WHERE id=?").run(draft.code,existing.id);
    else this.db.prepare(`INSERT INTO reconciliation_blocks (id,finding_id,affected_type,affected_id,status,reason,created_at) VALUES (?,?,?,?,'ACTIVE',?,?)`).run(randomUUID(),findingId,draft.affectedType,draft.affectedId,draft.code,at);
  }

  isBlocked(type:"SKU"|"ORDER",id:string){return Boolean(this.db.prepare("SELECT 1 FROM reconciliation_blocks WHERE affected_type=? AND affected_id=? AND status='ACTIVE' LIMIT 1").get(type,id));}
  assertNotBlocked(type:"SKU"|"ORDER",id:string){if(this.isBlocked(type,id)) throw new ReconciliationError("RECONCILIATION_SCOPE_BLOCKED",`${type} ${id} has an active critical reconciliation finding.`,409);}

  verifyFinding(input:{findingId:string;reason:string;actorId:string;operationId:string}){
    const finding=this.requireFinding(input.findingId); const at=now();
    this.db.transaction(()=>{this.db.prepare("UPDATE reconciliation_findings SET status='VERIFIED',resolved_at=?,verified_by_actor_id=?,verification_reason=? WHERE id=?").run(at,required(input.actorId,"actorId"),required(input.reason,"reason"),finding.id);
      this.db.prepare("UPDATE reconciliation_blocks SET status='CLEARED',cleared_at=?,cleared_by_actor_id=?,clear_reason='ADMIN_VERIFICATION' WHERE finding_id=? AND status='ACTIVE'").run(at,input.actorId,finding.id);
      this.history({findingId:finding.id,eventType:"ADMIN_VERIFIED",before:{status:finding.status},after:{status:"VERIFIED"},reason:input.reason,actorType:"HUMAN",actorId:input.actorId,operationId:input.operationId});}).immediate();
    return this.getFinding(finding.id);
  }

  proposeRepair(input:{findingId:string;commandType:string;commandPayload:unknown;reason:string;actorId:string;operationId:string}){
    const finding=this.requireFinding(input.findingId); if(finding.severity!=="CRITICAL") throw new ReconciliationError("REPAIR_NOT_REQUIRED","Only critical canonical findings use the approval workflow.",409);
    const id=randomUUID(); const at=now();
    this.db.transaction(()=>{this.db.prepare(`INSERT INTO reconciliation_repair_proposals (id,finding_id,command_type,command_payload_json,reason,status,proposed_by_actor_id,proposed_operation_id,proposed_at)
      VALUES (?,?,?,?,?,'PROPOSED',?,?,?)`).run(id,finding.id,required(input.commandType,"commandType"),json(input.commandPayload),required(input.reason,"reason"),required(input.actorId,"actorId"),required(input.operationId,"operationId"),at);
      this.db.prepare("UPDATE reconciliation_findings SET repair_status='PROPOSED' WHERE id=?").run(finding.id);
      this.history({findingId:finding.id,eventType:"REPAIR_PROPOSED",before:null,after:{proposalId:id,commandType:input.commandType},reason:input.reason,actorType:"HUMAN",actorId:input.actorId,operationId:input.operationId});}).immediate();
    return this.db.prepare("SELECT * FROM reconciliation_repair_proposals WHERE id=?").get(id) as any;
  }

  approveRepair(input:{proposalId:string;reason:string;actorId:string;actorIsAdmin:boolean;operationId:string}){return this.reviewRepair(input,"APPROVED");}
  rejectRepair(input:{proposalId:string;reason:string;actorId:string;actorIsAdmin:boolean;operationId:string}){return this.reviewRepair(input,"REJECTED");}
  private reviewRepair(input:{proposalId:string;reason:string;actorId:string;actorIsAdmin:boolean;operationId:string},status:"APPROVED"|"REJECTED"){
    if(!input.actorIsAdmin) throw new ReconciliationError("REPAIR_ADMIN_REQUIRED","Canonical repair approval is admin-only.",403);
    const proposal=this.db.prepare("SELECT * FROM reconciliation_repair_proposals WHERE id=?").get(required(input.proposalId,"proposalId")) as any;
    if(!proposal||proposal.status!=="PROPOSED") throw new ReconciliationError("REPAIR_STATE_CONFLICT","Repair proposal is not pending review.",409);
    const at=now(); this.db.transaction(()=>{this.db.prepare(`UPDATE reconciliation_repair_proposals SET status=?,reviewed_by_actor_id=?,review_operation_id=?,review_reason=?,reviewed_at=? WHERE id=?`).run(status,input.actorId,input.operationId,required(input.reason,"reason"),at,proposal.id);
      this.db.prepare("UPDATE reconciliation_findings SET repair_status=? WHERE id=?").run(status,proposal.finding_id);
      this.history({findingId:proposal.finding_id,eventType:`REPAIR_${status}`,before:{status:"PROPOSED"},after:{status},reason:input.reason,actorType:"HUMAN",actorId:input.actorId,operationId:input.operationId});}).immediate();
    return this.db.prepare("SELECT * FROM reconciliation_repair_proposals WHERE id=?").get(proposal.id) as any;
  }

  markRepairApplied(input:{proposalId:string;before:unknown;after:unknown;reason:string;actorId:string;operationId:string}){
    const proposal=this.db.prepare("SELECT * FROM reconciliation_repair_proposals WHERE id=?").get(required(input.proposalId,"proposalId")) as any;
    if(!proposal||proposal.status!=="APPROVED") throw new ReconciliationError("REPAIR_STATE_CONFLICT","Repair must be approved before an authoritative domain command is recorded as applied.",409);
    const at=now(); this.db.transaction(()=>{this.db.prepare("UPDATE reconciliation_repair_proposals SET status='APPLIED',applied_operation_id=?,applied_at=?,before_json=?,after_json=? WHERE id=?").run(input.operationId,at,json(input.before),json(input.after),proposal.id);
      this.db.prepare("UPDATE reconciliation_findings SET repair_status='APPLIED' WHERE id=?").run(proposal.finding_id);
      this.history({findingId:proposal.finding_id,eventType:"REPAIR_APPLIED",before:input.before,after:input.after,reason:input.reason,actorType:"HUMAN",actorId:input.actorId,operationId:input.operationId});}).immediate();
    return this.db.prepare("SELECT * FROM reconciliation_repair_proposals WHERE id=?").get(proposal.id) as any;
  }

  listFindings(filters:{status?:string;domain?:string;severity?:string;affectedType?:string}={}){
    const clauses:string[]=[];const params:unknown[]=[]; for(const [column,value] of [["status",filters.status],["domain",filters.domain],["severity",filters.severity],["affected_type",filters.affectedType]] as const) if(value){clauses.push(`${column}=?`);params.push(value);}
    return (this.db.prepare(`SELECT * FROM reconciliation_findings ${clauses.length?`WHERE ${clauses.join(" AND ")}`:""} ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARN' THEN 1 ELSE 2 END,datetime(last_seen_at) DESC,id`).all(...params) as any[]).map((row)=>this.view(row));
  }
  summary(){const counts=this.db.prepare("SELECT severity,COUNT(*) count FROM reconciliation_findings WHERE status='OPEN' GROUP BY severity").all() as any[];const lastRun=this.db.prepare("SELECT * FROM reconciliation_runs ORDER BY datetime(started_at) DESC,id DESC LIMIT 1").get()||null;return{counts:Object.fromEntries(["INFO","WARN","CRITICAL"].map((key)=>[key,Number(counts.find((row)=>row.severity===key)?.count||0)])),lastRun,activeBlocks:Number(this.db.prepare("SELECT COUNT(*) FROM reconciliation_blocks WHERE status='ACTIVE'").pluck().get())};}
  getHistory(findingId:string){this.requireFinding(findingId);return this.db.prepare("SELECT * FROM reconciliation_history WHERE finding_id=? ORDER BY datetime(created_at),id").all(findingId);}
  private getRun(id:string){const run=this.db.prepare("SELECT * FROM reconciliation_runs WHERE id=?").get(id) as any;if(!run)throw new ReconciliationError("RUN_NOT_FOUND","Reconciliation run was not found.",404);return{...run,findings:(this.db.prepare("SELECT * FROM reconciliation_findings WHERE last_run_id=? ORDER BY severity,affected_id").all(id) as any[]).map((row)=>this.view(row))};}
  private requireFinding(id:string){const row=this.db.prepare("SELECT * FROM reconciliation_findings WHERE id=?").get(required(id,"findingId")) as any;if(!row)throw new ReconciliationError("FINDING_NOT_FOUND","Reconciliation finding was not found.",404);return row;}
  private getFinding(id:string){return this.view(this.requireFinding(id));}
  private view(row:any){const proposal=this.db.prepare("SELECT id,status,command_type,reason,proposed_by_actor_id,proposed_at,reviewed_by_actor_id,review_reason,reviewed_at FROM reconciliation_repair_proposals WHERE finding_id=? ORDER BY datetime(proposed_at) DESC,id DESC LIMIT 1").get(row.id)||null;return{id:row.id,identityKey:row.identity_key,domain:row.domain,code:row.code,severity:row.severity,affectedType:row.affected_type,affectedId:row.affected_id,sourceRef:row.source_ref,expected:JSON.parse(row.expected_json),actual:JSON.parse(row.actual_json),status:row.status,repairStatus:row.repair_status,repairProposal:proposal,occurrences:Number(row.occurrences),firstSeenAt:row.first_seen_at,lastSeenAt:row.last_seen_at,resolvedAt:row.resolved_at};}
  private history(input:{findingId:string;runId?:string;eventType:string;before:unknown;after:unknown;reason:string;actorType:"SYSTEM"|"HUMAN";actorId:string;operationId:string}){this.db.prepare(`INSERT INTO reconciliation_history (id,finding_id,run_id,event_type,before_json,after_json,reason,actor_type,actor_id,operation_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),input.findingId,input.runId||null,input.eventType,input.before===undefined?null:json(input.before),input.after===undefined?null:json(input.after),required(input.reason,"reason"),input.actorType,required(input.actorId,"actorId"),required(input.operationId,"operationId"),now());}
}

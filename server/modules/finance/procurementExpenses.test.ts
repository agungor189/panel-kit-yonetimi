import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import express from 'express';
import {initializeDatabase} from '../../db/initialize.js';
import {ProcurementService} from '../procurement/procurementService.js';
import {ProcurementImportService, type ImportCostDecision} from '../procurement/procurementImportService.js';
import {ExchangeRateService} from './exchangeRates.js';
import {ExpenseService,OPERATING_EXPENSE_FILTER} from './expenseService.js';
import {CommandExecutor} from '../commands/commandFoundation.js';
import {createProcurementExpenseRouter} from '../../routes/procurementExpenseRoutes.js';

function setup() {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');initializeDatabase(db);
  const procurement=new ProcurementService(db);procurement.registerSupplier({id:'supplier',name:'Fixture',defaultCurrency:'USD'});
  const fx=new ExchangeRateService(db);fx.recordCurrentUsdTry({rate:'40',source:'MANUAL',changedAt:'2026-01-01T00:00:00Z',actorId:'owner'});
  db.prepare("INSERT INTO cash_accounts(id,name,currency,opening_balance) VALUES ('usd','Bank','USD',100),('try','Cash','TRY',100)").run();
  const rows=[
    {record_type:'PURCHASE',record_id:'p',invoice_number:'INV',invoice_date:'2026-01-01',supplier_name:'Fixture',currency:'USD'},
    {record_type:'PRODUCT',record_id:'a',parent_ref:'p',sku:'A',product_type:'simple',uom:'piece',name_en:'Part'},
    {record_type:'LINE',record_id:'line',parent_ref:'p',product_ref:'a',sku:'A',quantity:'1',unit_price:'10',amount:'10',currency:'USD',uom:'piece',pricing_basis:'BILLED'},
    {record_type:'PACKAGE_GROUP',record_id:'g',parent_ref:'p',package_count:'1',meta_json:'{"mixed":false}'},
    {record_type:'PACKAGE_ITEM',record_id:'i',parent_ref:'g',product_ref:'a',purchase_line_ref:'line',sku:'A',quantity:'1',units_per_package:'1',uom:'piece'},
  ].map(row=>({schema_version:'dsdst.procurement.import.v1',...row}));
  const keys=[...new Set(rows.flatMap(Object.keys))],cell=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
  const csv=keys.map(cell).join(',')+'\r\n'+rows.map(row=>keys.map(key=>cell((row as any)[key])).join(',')).join('\r\n');
  const importer=new ProcurementImportService(db),request={supplierId:'supplier',csv};
  const draft=importer.apply({...request,expectedPreviewHash:importer.preview(request).previewHash},'owner');
  const expenses=new ExpenseService(db),commands=new CommandExecutor(db);
  const command=(key:string,type:string,payload:any,handler:()=>any)=>commands.execute<any>({operationId:key,commandType:type,payload,
    actor:{human:{id:'owner'}},authorization:{decision:'ALLOW',capability:type.includes('payment')?'finance:write':'procurement:write'}},()=>({statusCode:200,body:handler()}));
  const add=(key='add')=>command(key,'procurement.import-draft.cost.add.v1',{draftId:draft.id,title:'Navlun',amountMinor:200,currency:'USD'},
    ()=>importer.addDraftCost(draft.id,{title:'Navlun',amountMinor:200,currency:'USD',description:'Invoice freight'},'owner',key)).result.body.draftCosts[0];
  const document=(id:string,suffix='one')=>db.prepare('INSERT INTO expense_attachments(id,expense_id,file_name,file_path,mime_type) VALUES (?,?,?,?,?)').run(`${id}:${suffix}`,id,'invoice.pdf','uploads/expenses/synthetic.pdf','application/pdf');
  const decision=(cost:any):ImportCostDecision=>({vatMode:'EXCLUDED',vatRateBps:0,acquisitionCostVatPolicy:'VAT_EXCLUDED_FROM_INVENTORY_COST',
    includedCost:'NO_SEPARATE_CHARGE',stockCheck:'NO_PRIOR_RECEIPT',stockEvidence:'Synthetic fixture with no receipt',approveProportionalAllocation:true,
    costDecisions:[{costId:cost.id,category:'FREIGHT',counterparty:'THIRD_PARTY',vatMode:'EXCLUDED',vatRateBps:0}]});
  const pay=(cost:any,key='pay')=>command(key,'finance.procurement-expense.approve-payment.v1',{expenseId:cost.id,cashAccountId:'usd',expectedCostVersion:cost.version},
    ()=>expenses.approvePayment(cost.id,{cashAccountId:'usd',expectedCostVersion:cost.version}));
  const finalize=(cost:any)=>{
    const policy=decision(cost),preview=importer.previewDraftCost(draft.id,policy,'owner');
    return importer.finalizeDraft(draft.id,{...policy,approvePreview:true,expectedPreviewHash:preview.previewHash},'owner');
  };
  return {db,procurement,fx,importer,draft,expenses,add,document,decision,pay,finalize};
}

test('procurement expense create/replay, edit, document retention and soft cancellation have no cash or stock effects',()=>{
  const {db,importer,draft,add,document}=setup();const cost=add();assert.equal(add().id,cost.id);
  const original=db.prepare('SELECT * FROM transactions WHERE id=?').get(cost.id) as any;
  assert.equal(original.payment_method,'Onay Bekliyor');assert.equal(original.amount,2);assert.equal(original.currency,'USD');
  assert.match(original.description,/Invoice freight\nSatın alma: CSV-INV\nTedarikçi: Fixture/);
  document(cost.id);
  const updated=importer.updateDraftCost(draft.id,cost.id,{title:'Nakliye',amountMinor:350,currency:'TRY',description:'Updated',expectedVersion:1},'owner','edit').draftCosts[0];
  const changed=db.prepare('SELECT * FROM transactions WHERE id=?').get(cost.id) as any;
  assert.equal(changed.amount,3.5);assert.equal(changed.currency,'TRY');assert.equal(changed.title,'Nakliye');assert.match(changed.description,/Updated/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM expense_attachments WHERE expense_id=?').pluck().get(cost.id),1);
  importer.deleteDraftCost(draft.id,cost.id,updated.version,'owner','delete');
  assert.equal(db.prepare('SELECT is_deleted FROM transactions WHERE id=?').pluck().get(cost.id),1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(),1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM inventory_ledger_events').pluck().get(),0);db.close();
});

test('payment before FINAL creates one existing cash movement and keeps LC preview valid, invoices and separate finalization intact',()=>{
  const {db,importer,draft,expenses,add,document,decision,pay}=setup();const cost=add();document(cost.id);document(cost.id,'two');
  const policy=decision(cost),preview=importer.previewDraftCost(draft.id,policy,'owner');
  const paid=pay(cost);assert.equal(pay(cost).replayed,true);assert.equal(paid.result.body.paymentStatus,'PAID');
  assert.throws(()=>pay(cost,'new-key'),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.equal(db.prepare("SELECT opening_balance-COALESCE((SELECT SUM(amount) FROM cash_transactions WHERE account_id=a.id AND type='OUT' AND is_deleted=0),0) FROM cash_accounts a WHERE id='usd'").pluck().get(),98);
  assert.equal(importer.previewDraftCost(draft.id,policy,'owner').previewHash,preview.previewHash);
  const final=importer.finalizeDraft(draft.id,{...policy,approvePreview:true,expectedPreviewHash:preview.previewHash},'owner');
  assert.equal(final.status,'APPROVED');assert.equal(final.lots[0].landedCostTryMinor,48000);
  assert.equal(expenses.detail(cost.id)?.purchaseId,final.id);assert.equal(expenses.detail(cost.id)?.cashAccountName,'Bank');
  assert.equal(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(),1);assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),1);
  assert.equal(db.prepare('SELECT COUNT(*) FROM expense_attachments').pluck().get(),2);
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='finance.procurement-expense.approve-payment.v1'").pluck().get(),1);
  assert.equal(db.prepare(`SELECT COALESCE(SUM(amount_try),0) FROM transactions WHERE type='Expense' AND ${OPERATING_EXPENSE_FILTER}`).pluck().get(),0);
  assert.throws(()=>expenses.assertStandaloneEditable(cost.id),(e:any)=>e.code==='PROCUREMENT_EXPENSE_LOCKED');
  assert.throws(()=>expenses.assertDocumentRemovable(cost.id),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.throws(()=>expenses.deleteAttachmentRecord(cost.id,`${cost.id}:one`),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.equal(db.prepare('SELECT COUNT(*) FROM expense_attachments').pluck().get(),2);db.close();
});

test('payment after FINAL is independent; paid draft costs and entire draft cancellation are protected atomically',()=>{
  const first=setup(),cost=first.add();const final=first.finalize(cost);
  assert.equal(first.db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(),1);assert.equal(first.db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),0);
  first.document(cost.id);first.pay(cost);assert.equal(first.procurement.getPurchase(final.id).lots[0].landedCostTryMinor,48000);first.db.close();
  const next=setup(),paidCost=next.add();next.document(paidCost.id);next.pay(paidCost);
  const other=next.importer.addDraftCost(next.draft.id,{title:'Paketleme',amountMinor:100,currency:'TRY'},'owner','other').draftCosts.find((c:any)=>c.id!==paidCost.id);
  assert.throws(()=>next.importer.updateDraftCost(next.draft.id,paidCost.id,{title:'Changed',amountMinor:1,currency:'TRY',expectedVersion:1},'owner','edit'),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.throws(()=>next.importer.deleteDraftCost(next.draft.id,paidCost.id,1,'owner','delete'),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.throws(()=>next.importer.cancelDraft(next.draft.id,'owner','cancel'),(e:any)=>e.code==='PROCUREMENT_COST_PAID');
  assert.equal(next.db.prepare('SELECT status FROM procurement_import_draft_costs WHERE id=?').pluck().get(other.id),'ACTIVE');
  assert.equal(next.db.prepare('SELECT COUNT(*) FROM procurement_import_draft_lifecycle_events').pluck().get(),0);next.db.close();
});

test('missing document/account/FX, wrong currency and stale cost cannot approve or create cash',()=>{
  const {db,expenses,importer,draft,add,document}=setup();const cost=add();
  const input={cashAccountId:'usd',expectedCostVersion:1};
  assert.throws(()=>expenses.approvePayment(cost.id,input),(e:any)=>e.code==='EXPENSE_DOCUMENT_REQUIRED');document(cost.id);
  assert.throws(()=>expenses.approvePayment(cost.id,{...input,cashAccountId:''}),(e:any)=>e.code==='EXPENSE_ACCOUNT_REQUIRED');
  assert.throws(()=>expenses.approvePayment(cost.id,{...input,cashAccountId:'try'}),(e:any)=>e.code==='EXPENSE_ACCOUNT_CURRENCY_MISMATCH');
  importer.updateDraftCost(draft.id,cost.id,{title:'Navlun',amountMinor:300,currency:'USD',expectedVersion:1},'owner','update');
  assert.throws(()=>expenses.approvePayment(cost.id,input),(e:any)=>e.code==='EXPENSE_STALE');
  db.prepare("DELETE FROM fx_current_rates WHERE pair_key='USD/TRY'").run();
  assert.throws(()=>expenses.approvePayment(cost.id,{...input,expectedCostVersion:2}),/rate is required/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),0);
  assert.equal(db.prepare('SELECT payment_method FROM transactions WHERE id=?').pluck().get(cost.id),'Onay Bekliyor');db.close();
});

test('cash posting failure rolls back approval and permits safe retry; cancelled pending expenses cannot be paid',()=>{
  const {db,expenses,importer,draft,add,document,pay}=setup();const cost=add();document(cost.id);
  db.exec("CREATE TRIGGER reject_expense_cash BEFORE INSERT ON cash_transactions BEGIN SELECT RAISE(ABORT,'fixture posting failure'); END");
  assert.throws(()=>pay(cost),/fixture posting failure/);
  assert.equal(db.prepare('SELECT payment_method FROM transactions WHERE id=?').pluck().get(cost.id),'Onay Bekliyor');
  assert.equal(db.prepare("SELECT COUNT(*) FROM command_operations WHERE operation_id='pay'").pluck().get(),0);
  db.exec('DROP TRIGGER reject_expense_cash');pay(cost);assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),1);
  const cancelled=importer.addDraftCost(draft.id,{title:'Other',amountMinor:100,currency:'TRY'},'owner','other').draftCosts.find((c:any)=>c.id!==cost.id);
  document(cancelled.id);importer.deleteDraftCost(draft.id,cancelled.id,1,'owner','delete');
  assert.throws(()=>expenses.approvePayment(cancelled.id,{cashAccountId:'try',expectedCostVersion:2}),(e:any)=>e.code==='EXPENSE_NOT_FOUND');db.close();
});

test('ordinary purchase cost entry also creates pending expenses; FINAL never recreates them and manual expenses still post immediately',()=>{
  const {db,procurement,draft,importer,expenses}=setup();const productId=importer.getDraft(draft.id).lines[0].productId;
  const input={id:'initial-cost',category:'FREIGHT' as const,counterparty:'THIRD_PARTY' as const,amountMinor:200,currency:'USD',vatMode:'EXCLUDED' as const,vatRateBps:0,description:'Initial freight'};
  const purchase=procurement.createPurchase({id:'manual-purchase',supplierId:'supplier',acquisitionCostVatPolicy:'VAT_EXCLUDED_FROM_INVENTORY_COST',
    lines:[{id:'manual-line',productId,quantity:'1',quoteBasis:'piece',supplierUnitPriceMinor:1000,currency:'USD',vatMode:'EXCLUDED',vatRateBps:0}],acquisitionCosts:[input]});
  procurement.addAcquisitionCost(purchase.id,{...input,id:'additional-cost',description:'Nakliye'});
  assert.equal(expenses.detail('initial-cost')?.purchaseId,purchase.id);
  assert.equal(db.prepare("SELECT COUNT(*) FROM transactions WHERE payment_method='Onay Bekliyor'").pluck().get(),2);
  procurement.finalizeAcquisitionCosts(purchase.id,{allocations:[{componentId:'initial-cost',mode:'ACCEPT_SUGGESTION'},{componentId:'additional-cost',mode:'ACCEPT_SUGGESTION'}]});
  assert.equal(db.prepare('SELECT COUNT(*) FROM transactions').pluck().get(),2);assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),0);
  expenses.assertStandaloneEditable('manual-expense');expenses.assertDocumentRemovable('manual-expense');
  const id=expenses.insertCashTransaction({id:'manual-expense',amount:12,currency:'USD',cash_account_id:{id:'usd'},category:'Office',title:'Supplies',exchange_rate_at_transaction:40,date:'2026-01-02'});
  assert.deepEqual(db.prepare('SELECT account_id,type,amount,currency,source_type,source_id,description,transaction_date FROM cash_transactions WHERE id=?').get(id),
    {account_id:'usd',type:'OUT',amount:12,currency:'USD',source_type:'expense',source_id:'manual-expense',description:'Gider: Office - Supplies',transaction_date:'2026-01-02'});db.close();
});

test('expense approval API requires authorization and operation key; identical retry pays only once',async()=>{
  const {db,add,document}=setup();const cost=add();document(cost.id);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:'owner',username:'Owner'} as typeof req.user;next();});
  app.use('/expenses',createProcurementExpenseRouter(db,(req,res,next)=>{if(req.headers['x-deny']) {res.sendStatus(403);return;}next();}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/expenses/${cost.id}/approve-payment`;
  const payload={cashAccountId:'usd',expectedCostVersion:1};
  const post=(headers:Record<string,string>,body=payload)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  try {
    assert.equal((await post({'x-operation-id':'deny','x-deny':'1'})).status,403);assert.equal((await post({})).status,400);
    const first=await post({'x-operation-id':'approved'});assert.equal(first.status,200);const response=await first.json() as any;
    const replay=await post({'x-operation-id':'approved'});assert.equal(replay.status,200);const repeated=await replay.json() as any;
    assert.equal(repeated.idempotent,true);assert.deepEqual(repeated.data,response.data);
    assert.equal((await post({'x-operation-id':'approved'},{...payload,cashAccountId:'try'})).status,409);
    assert.equal((await post({'x-operation-id':'other-key'})).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) FROM cash_transactions').pluck().get(),1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='finance.procurement-expense.approve-payment.v1'").pluck().get(),1);
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));db.close();}
});

import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import {ExchangeRateService} from './exchangeRates.js';
import {multiplyAndRound} from './money.js';

// Procurement costs already have a durable UUID. Reusing it as the expense ID
// provides the one-to-one link without another expense/payment table.
export const PROCUREMENT_EXPENSE_TYPE = 'PROCUREMENT_COST';
export const OPERATING_EXPENSE_FILTER = "COALESCE(expense_type,'') <> 'PROCUREMENT_COST'";
export class ExpenseValidationError extends Error {
  constructor(public readonly code:string,message:string,public readonly statusCode=409) {super(message);}
}

export class ExpenseService {
  constructor(private readonly db:Database.Database) {}

  isProcurementExpense(id:string) {
    return Boolean(this.db.prepare('SELECT 1 FROM procurement_import_draft_costs WHERE id=? UNION ALL SELECT 1 FROM purchase_cost_components WHERE id=?').get(id,id));
  }

  private cost(id:string):any {
    const draft=this.db.prepare(`SELECT c.*,d.invoice_number,s.name AS supplier_name,NULL AS purchase_id,
      'CSV-'||d.invoice_number AS purchase_number FROM procurement_import_draft_costs c
      JOIN procurement_import_drafts d ON d.id=c.draft_id JOIN procurement_suppliers s ON s.id=d.supplier_id WHERE c.id=?`).get(id);
    if(draft) return draft;
    return this.db.prepare(`SELECT c.id,NULL AS draft_id,c.purchase_order_id AS purchase_id,
      COALESCE(d.description,d.expense_type) AS title,c.source_gross_minor AS amount_minor,c.source_currency AS currency,
      c.notes AS description,'ACTIVE' AS status,1 AS version,c.created_at,p.invoice_number,p.supplier_name_snapshot AS supplier_name,w.purchase_number
      FROM purchase_cost_components c JOIN purchase_orders p ON p.id=c.purchase_order_id
      JOIN procurement_workflows w ON w.purchase_order_id=p.id JOIN purchase_cost_component_details d ON d.component_id=c.id WHERE c.id=?`).get(id);
  }

  assertStandaloneEditable(id:string) {
    if(this.isProcurementExpense(id)) throw new ExpenseValidationError('PROCUREMENT_EXPENSE_LOCKED',
      'Satın alma gideri yalnız ödenmeden önce bağlı taslak maliyet üzerinden düzenlenebilir veya iptal edilebilir.');
  }

  assertCostUnpaid(id:string) {
    if(this.db.prepare("SELECT 1 FROM transactions WHERE id=? AND payment_method='Ödendi'").get(id) ||
      this.db.prepare("SELECT 1 FROM cash_transactions WHERE source_type='expense' AND source_id=?").get(id))
      throw new ExpenseValidationError('PROCUREMENT_COST_PAID','Ödenmiş maliyet düzenlenemez veya silinemez; ödeme geçmişi korunmalıdır.');
  }

  assertDocumentRemovable(id:string) {
    if(this.isProcurementExpense(id)) this.assertCostUnpaid(id);
  }

  deleteAttachmentRecord(expenseId:string,attachmentId:string) {
    this.db.transaction(()=>{
      this.assertDocumentRemovable(expenseId);
      this.db.prepare('DELETE FROM expense_attachments WHERE id=? AND expense_id=?').run(attachmentId,expenseId);
    }).immediate();
  }

  syncPendingCost(costId:string) {
    this.assertCostUnpaid(costId);
    const cost=this.cost(costId);
    if(!cost) throw new ExpenseValidationError('COST_NOT_FOUND','Satın alma maliyeti bulunamadı.',404);
    const existing=this.db.prepare('SELECT expense_type FROM transactions WHERE id=?').get(costId) as any;
    if(existing && existing.expense_type!==PROCUREMENT_EXPENSE_TYPE) throw new ExpenseValidationError('EXPENSE_ID_CONFLICT','Gider kimliği başka bir kayda ait.');
    if(!existing && cost.status==='DELETED') return;
    const fx=new ExchangeRateService(this.db).getCurrentUsdTry();
    const rate=cost.currency==='TRY'?1:fx?fx.numerator/fx.denominator:null;
    const amountTry=cost.currency==='TRY'?cost.amount_minor/100:fx?multiplyAndRound(cost.amount_minor,fx,'expense estimate')/100:null;
    const description=[cost.description,`Satın alma: ${cost.purchase_number}`,`Tedarikçi: ${cost.supplier_name}`].filter(Boolean).join('\n');
    if(!existing) this.db.prepare(`INSERT INTO transactions(id,date,type,expense_type,category,platform,payment_method,is_stock_related,distribute_to_product_cost)
      VALUES (?,?,'Expense',?,'Satın Alma Maliyeti','Satın Alma','Onay Bekliyor',1,1)`).run(cost.id,cost.created_at,PROCUREMENT_EXPENSE_TYPE);
    this.db.prepare(`UPDATE transactions SET title=?,note=?,amount=?,currency=?,description=?,reference_number=?,supplier=?,invoice_number=?,
      amount_try=?,exchange_rate_at_transaction=?,is_deleted=? WHERE id=?`).run(cost.title,cost.title,cost.amount_minor/100,cost.currency,
      description,cost.purchase_number,cost.supplier_name,cost.invoice_number??null,amountTry,rate,cost.status==='DELETED'?1:0,cost.id);
  }

  detail(id:string) {
    const row=this.db.prepare(`SELECT t.payment_method,t.cash_account_id,a.name AS account_name,
      (SELECT transaction_date FROM cash_transactions WHERE source_type='expense' AND source_id=t.id LIMIT 1) AS paid_at,
      done.purchase_order_id FROM transactions t LEFT JOIN procurement_import_draft_costs c ON c.id=t.id
      LEFT JOIN cash_accounts a ON a.id=t.cash_account_id
      LEFT JOIN procurement_import_draft_completions done ON done.draft_id=c.draft_id WHERE t.id=? AND t.expense_type=?`).get(id,PROCUREMENT_EXPENSE_TYPE) as any;
    if(!row) return null;
    const cost=this.cost(id);
    if(!cost) return null;
    return {draftId:cost.draft_id,purchaseId:row.purchase_order_id??cost.purchase_id??null,costVersion:cost.version,
      paymentStatus:row.payment_method==='Ödendi'?'PAID':'PENDING',cashAccountId:row.cash_account_id??null,
      cashAccountName:row.account_name??null,paidAt:row.paid_at??null};
  }

  approvePayment(id:string,input:{cashAccountId:string;expectedCostVersion:number}) {
    return this.db.transaction(()=>{
      const expense=this.db.prepare(`SELECT * FROM transactions WHERE id=? AND type='Expense' AND expense_type=? AND COALESCE(is_deleted,0)=0`).get(id,PROCUREMENT_EXPENSE_TYPE) as any;
      const cost=this.cost(id);
      if(!expense || !cost || cost.status!=='ACTIVE') throw new ExpenseValidationError('EXPENSE_NOT_FOUND','Bekleyen satın alma gideri bulunamadı.',404);
      this.assertCostUnpaid(id);
      if(expense.payment_method!=='Onay Bekliyor') throw new ExpenseValidationError('EXPENSE_NOT_PENDING','Gider onay beklemiyor.');
      if(!Number.isSafeInteger(input?.expectedCostVersion) || input.expectedCostVersion!==cost.version)
        throw new ExpenseValidationError('EXPENSE_STALE','Maliyet değişmiş; gideri yenileyin.');
      const documents=this.db.prepare("SELECT id FROM expense_attachments WHERE expense_id=? AND NULLIF(trim(file_path),'') IS NOT NULL ORDER BY id").all(id) as {id:string}[];
      if(!documents.length) throw new ExpenseValidationError('EXPENSE_DOCUMENT_REQUIRED','Ödeme onayından önce fatura/belge ekleyin.',400);
      if(typeof input.cashAccountId!=='string'||!input.cashAccountId.trim())
        throw new ExpenseValidationError('EXPENSE_ACCOUNT_REQUIRED','Aktif kasa/banka hesabı seçin.',400);
      const account=this.db.prepare('SELECT id,currency FROM cash_accounts WHERE id=? AND is_active=1').get(input.cashAccountId||'') as any;
      if(!account) throw new ExpenseValidationError('EXPENSE_ACCOUNT_REQUIRED','Aktif kasa/banka hesabı seçin.',400);
      if(account.currency!==cost.currency) throw new ExpenseValidationError('EXPENSE_ACCOUNT_CURRENCY_MISMATCH','Hesap para birimi giderle aynı olmalı.',400);
      const now=new Date().toISOString(),fx=new ExchangeRateService(this.db).snapshotFor(cost.currency,now);
      const cashTransactionId=this.insertCashTransaction({...expense,amount:cost.amount_minor/100,currency:cost.currency,
        cash_account_id:account.id,payer_person_id:null,date:now,exchange_rate_at_transaction:fx.numerator/fx.denominator});
      const changed=this.db.prepare(`UPDATE transactions SET payment_method='Ödendi',cash_account_id=?,amount_try=?,exchange_rate_at_transaction=?
        WHERE id=? AND payment_method='Onay Bekliyor' AND COALESCE(is_deleted,0)=0`).run(account.id,
          multiplyAndRound(cost.amount_minor,fx,'expense payment')/100,fx.numerator/fx.denominator,id);
      if(changed.changes!==1) throw new ExpenseValidationError('EXPENSE_STALE','Giderin durumu değişmiş; gideri yenileyin.');
      return {expenseId:id,cashTransactionId,cashAccountId:account.id,amountMinor:cost.amount_minor,currency:cost.currency,
        paidAt:now,fx,documentIds:documents.map(document=>document.id),paymentStatus:'PAID'};
    }).immediate();
  }

  // Existing manual-expense cash posting, moved unchanged from server.ts.
  // Procurement approval validates identity, documents, currency and FX above.
  insertCashTransaction(expense:any):string {
    const formText=(value:any):string|null=>{
      if(value===undefined||value===null||value==='') return null;
      if(value instanceof Date) return value.toISOString();
      if(typeof value==='object'&&!Buffer.isBuffer(value)) value=value.id??value.value??value.key??value.name??value.label??null;
      return value===null?null:String(value);
    };
    const accountId=formText(expense?.payer_person_id)||formText(expense?.cash_account_id);
    if(!accountId) throw new Error('Gider eklerken ödeme hesabı veya ödeyen kişi seçimi zorunludur.');
    const account=this.db.prepare('SELECT * FROM cash_accounts WHERE id=?').get(accountId) as any;
    if(!account) throw new Error('Geçersiz hesap.');
    if(account.is_active===0) throw new Error('Seçili hesap pasif.');
    const amount=Number(expense.amount);
    if(!Number.isFinite(amount)||amount<=0) throw new Error("Tutar 0'dan büyük olmalıdır.");
    const exchangeRate=Number(expense.exchange_rate_at_transaction||expense.exchange_rate||1);
    if(!Number.isFinite(exchangeRate)||exchangeRate<=0) throw new Error('Döviz kuru geçerli değil.');
    const text=(value:unknown)=>typeof value==='string'?value.trim():'';
    const category=text(expense?.category)||'Gider';
    const detail=text(expense?.title)||text(expense?.note)||text(expense?.description)||text(expense?.reference_number);
    const cashTxId=randomUUID();
    this.db.prepare(`INSERT INTO cash_transactions(id,account_id,type,amount,currency,exchange_rate_at_transaction,
      source_type,source_id,description,transaction_date,is_deleted) VALUES (?,?,'OUT',?,?,?,'expense',?,?,?,0)`).run(
        cashTxId,accountId,amount,expense.currency||'TRY',exchangeRate,expense.id,
        detail?`Gider: ${category} - ${detail}`:`Gider: ${category}`,expense.date||new Date().toISOString());
    return cashTxId;
  }
}

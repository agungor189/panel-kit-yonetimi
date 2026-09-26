import React, { useState, useEffect } from 'react';
import { 
  Building2, CreditCard, Wallet, Users, ArrowRightLeft, Plus,
  TrendingUp, TrendingDown, Package, PiggyBank, Receipt, LayoutDashboard, CheckCircle2
} from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { useAuth } from '../App';
import { Badge, Button, Card, EmptyState, Input, LoadingState, Modal, PageHeader, Select } from './ui';

export default function FinanceModule({ settings }: any) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [activeTab, setActiveTab] = useState('dashboard');
  
  const [summary, setSummary] = useState<any>({});
  const [accounts, setAccounts] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]); 
  const [expenses, setExpenses] = useState<any[]>([]);
  
  const [loading, setLoading] = useState(false);

  // Modals
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountForm, setAccountForm] = useState({
    name: '', type: 'bank', currency: 'TRY', opening_balance: '',
    credit_limit: '', payment_due_day: '', cutoff_day: '', is_liability: '0'
  });

  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({
    from_account_id: '', to_account_id: '', amount: '', rate: '', description: '', is_capital: false
  });

  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expenseForm, setExpenseForm] = useState({
    date: new Date().toISOString().split('T')[0], category: '', amount: '', currency: 'TRY', exchange_rate: '', title: '', description: '',
    payment_method: '', cash_account_id: '', payer_person_id: '', will_be_refunded: false, 
    is_invoice: false, invoice_name: '', is_stock_related: false, distribute_to_product_cost: false
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [sumRes, accRes, txRes, expRes] = await Promise.all([
        api.get('/finance-summary'),
        api.get('/cash-accounts'),
        api.get('/cash-transactions'),
        api.get('/expenses')
      ]);
      setSummary(sumRes);
      setAccounts(accRes);
      setTransactions(txRes);
      setExpenses(expRes);
    } catch(e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    try {
      await api.post('/cash-accounts', accountForm);
      setShowAddAccount(false);
      loadData();
    } catch (err: any) { alert(err.message); }
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    try {
      if (transferForm.is_capital) {
        // Since we don't have cash-deposit, we can use a clever trick:
        // Cash-transfer with a dummy from_account or we add /api/cash-deposit in server.ts
        try {
          await api.post('/cash-deposit', {
            account_id: transferForm.to_account_id,
            amount: transferForm.amount,
            description: transferForm.description,
            source_type: 'capital_injection'
          });
        } catch(e:any) {
           alert("Endpoint yok veya hata: " + e.message);
        }
      } else {
        await api.post('/cash-transfer', transferForm);
      }
      setShowTransfer(false);
      loadData();
    } catch (err: any) { alert(err.message || 'Transfer başarısız'); }
  };

  const handleSaveExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    try {
      await api.post('/expenses', expenseForm);
      setShowAddExpense(false);
      loadData();
    } catch (err: any) { alert(err.message); }
  };

  const calculateBalance = (accId: string) => {
    const acc = accounts.find(a => a.id === accId);
    if (!acc) return 0;
    let bal = acc.opening_balance || 0;
    transactions.forEach(tx => {
      if (tx.account_id === accId) {
        if (tx.type === 'IN') bal += tx.amount;
        else if (tx.type === 'OUT') bal -= tx.amount;
      }
    });
    return bal;
  };

  const isInitialLoading = loading
    && accounts.length === 0
    && expenses.length === 0
    && Object.keys(summary).length === 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-20">
      <PageHeader
        title="Finans Merkezi"
        description="Gelişmiş kasa, banka, kredi kartı ve gider yönetimi."
        actions={!isReadOnly ? (
          <>
            <Button onClick={() => setShowAddExpense(true)} variant="danger" className="rounded-xl bg-rose-600 px-5 py-2.5 font-bold shadow-lg shadow-rose-200 hover:bg-rose-700">
              <Receipt className="w-5 h-5" /> Gelişmiş Gider Ekle
            </Button>
            <Button onClick={() => setShowTransfer(true)} className="rounded-xl bg-blue-600 px-5 py-2.5 font-bold shadow-lg shadow-blue-200 hover:bg-blue-700">
              <ArrowRightLeft className="w-5 h-5" /> Transfer / Ödeme
            </Button>
          </>
        ) : undefined}
      />

      <div className="flex overflow-x-auto gap-4 border-b border-gray-200 pb-2">
        {[
          { id: 'dashboard', label: 'Finansal Özet', icon: LayoutDashboard },
          { id: 'accounts', label: 'Hesaplar & Kartlar', icon: Wallet },
          { id: 'expenses', label: 'Gider Geçmişi', icon: Receipt },
        ].map(t => (
          <button 
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-t-xl font-bold text-sm whitespace-nowrap border-b-2 transition-colors ${
              activeTab === t.id ? 'border-blue-600 text-blue-600 bg-blue-50/50' : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50'
            }`}
          >
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {isInitialLoading && <LoadingState label="Finans verileri yükleniyor..." />}

      {!isInitialLoading && activeTab === 'dashboard' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <FinanceSummaryCard title="Toplam Sermaye Girişi" val={summary.capitalInjection} icon={PiggyBank} color="text-green-600" />
            <FinanceSummaryCard title="Satış Geliri" val={summary.salesRevenue} icon={TrendingUp} color="text-blue-600" />
            <FinanceSummaryCard title="Toplam Gider" val={summary.totalExpense} icon={TrendingDown} color="text-red-600" />
            <FinanceSummaryCard title="Stoka Bağlanan Sermaye" val={summary.capitalInStock} icon={Package} color="text-amber-600" />
            
            <FinanceSummaryCard title="Şirket Kredi Kartı Borcu" val={summary.ccDebt} icon={CreditCard} color="text-red-500" isDebt />
            <FinanceSummaryCard title="Kişisel Borçlar" val={summary.personalDebt} icon={Users} color="text-orange-500" isDebt />
            <FinanceSummaryCard title="Mevcut Banka/Kasa" val={summary.existingCash} icon={Building2} color="text-emerald-600" />
            <FinanceSummaryCard title="Net Nakit" val={summary.netCash} icon={Wallet} color={summary.netCash >= 0 ? "text-green-600" : "text-red-600"} />
          </div>
          <div className="bg-gradient-to-br from-gray-900 via-slate-800 to-gray-900 rounded-3xl p-8 text-white shadow-xl flex flex-col md:flex-row items-center justify-between border border-gray-800">
             <div>
                <p className="text-gray-400 font-bold mb-2 uppercase tracking-wide text-xs">Tahmini Net Kar</p>
                <div className="text-4xl md:text-5xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400">
                  <FormatAmount amount={summary.netProfit || 0} />
                </div>
             </div>
             <div className="mt-4 md:mt-0 md:text-right flex items-center md:items-end flex-col">
                <div className="flex items-center gap-2 px-4 py-2 bg-white/10 rounded-xl backdrop-blur-sm border border-white/5">
                  <CheckCircle2 className="text-green-400 w-5 h-5" />
                  <span className="text-sm font-semibold text-gray-200">Finansallar Güncel</span>
                </div>
                <p className="text-xs text-gray-500 mt-3 font-medium">(Satış Geliri - Satılan Ürünlerin Satın Alma Maliyeti - Giderler)</p>
             </div>
          </div>
        </div>
      )}

      {!isInitialLoading && activeTab === 'accounts' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-black text-lg text-gray-900">Hesaplar ve Kartlar</h3>
            {!isReadOnly && (
              <Button variant="secondary" onClick={() => setShowAddAccount(true)} className="rounded-xl bg-gray-100 px-4 py-2 font-bold text-gray-800 hover:bg-gray-200">
                <Plus className="w-4 h-4" /> Yeni Hesap Ekle
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {accounts.map(acc => {
              const bal = calculateBalance(acc.id);
              const isDanger = acc.is_liability === 1 && Math.abs(bal) > (acc.credit_limit || 0) * 0.8 && acc.credit_limit > 0;
              return (
                <Card key={acc.id} padding="md" className="group relative overflow-hidden rounded-2xl border-gray-200 shadow-sm">
                  <div className="flex justify-between items-start mb-4 relative z-10">
                    <div>
                      <div className="text-xs font-bold text-gray-400 uppercase tracking-widest">{acc.type.replace(/_/g, ' ')}</div>
                      <div className="text-lg font-black text-gray-900 mt-1">{acc.name}</div>
                    </div>
                    <div className="w-12 h-12 rounded-2xl bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-600">
                      {acc.type === 'credit_card' ? <CreditCard className="w-6 h-6" /> : acc.type.includes('personal') ? <Users className="w-6 h-6" /> : <Building2 className="w-6 h-6" />}
                    </div>
                  </div>
                  <div className="relative z-10">
                    <p className="text-sm text-gray-500 font-medium mb-1">{acc.is_liability ? 'Güncel Borç' : 'Mevcut Bakiye'}</p>
                    <div className={`text-3xl font-black ${acc.is_liability ? (bal < 0 ? 'text-red-600' : 'text-gray-900') : 'text-gray-900'}`}>
                      <FormatAmount amount={Math.abs(bal)} />
                    </div>
                    {acc.is_liability === 1 && acc.credit_limit > 0 && (
                      <div className="mt-4">
                        <div className="flex justify-between text-xs font-bold mb-1">
                          <span className="text-gray-500">Kullanılan Limit</span>
                          <span className={isDanger ? 'text-red-500' : 'text-gray-700'}>{Math.round((Math.abs(bal) / acc.credit_limit) * 100)}%</span>
                        </div>
                        <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full ${isDanger ? 'bg-red-500' : 'bg-blue-500'}`} style={{ width: `${Math.min((Math.abs(bal) / acc.credit_limit) * 100, 100)}%` }} />
                        </div>
                        <p className="text-xs text-gray-500 font-medium mt-2">Toplam Limit: <FormatAmount amount={acc.credit_limit} /></p>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
            {accounts.length === 0 && (
              <EmptyState title="Henüz hesap veya kart eklenmemiş." className="col-span-full" />
            )}
          </div>
        </div>
      )}

      {!isInitialLoading && activeTab === 'expenses' && (
        <Card className="overflow-hidden rounded-2xl border-gray-100 shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50/80 text-gray-500 font-bold text-xs uppercase tracking-widest">
                <tr>
                  <th className="px-6 py-4">Tarih</th>
                  <th className="px-6 py-4">Kategori/Açıklama</th>
                  <th className="px-6 py-4">Ödeme Hesabı/Kişi</th>
                  <th className="px-6 py-4">Fatura Durumu</th>
                  <th className="px-6 py-4 text-right">Tutar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {expenses.map((e: any) => {
                  const account = accounts.find(a => a.id === e.cash_account_id);
                  const person = accounts.find(a => a.id === e.payer_person_id);
                  return (
                    <tr key={e.id} className="hover:bg-gray-50/50">
                      <td className="px-6 py-4 font-medium text-gray-900 whitespace-nowrap">{new Date(e.date).toLocaleDateString('tr-TR')}</td>
                      <td className="px-6 py-4">
                        <div className="font-bold text-gray-900">{e.category}</div>
                        <div className="text-xs text-gray-500 truncate max-w-xs">{e.title || e.note}</div>
                      </td>
                      <td className="px-6 py-4">
                        <Badge className="rounded-md border-0 bg-gray-100 text-gray-700">
                          {person ? `👤 ${person.name}` : account ? `🏦 ${account.name}` : 'Belirsiz'}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        {e.is_invoice
                          ? <Badge variant="success" className="rounded-md border-0 bg-green-100 text-green-700">Faturalı ({e.invoice_name})</Badge>
                          : <Badge variant="warning" className="rounded-md border-0 bg-amber-100 text-amber-700">Faturasız</Badge>}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="font-black text-gray-900"><FormatAmount amount={e.amount_try || e.amount} originalCurrency="TRY" /></div>
                        {e.currency !== 'TRY' && <div className="text-xs text-gray-400 font-medium">{e.amount} {e.currency} (Kur: {e.exchange_rate_at_transaction})</div>}
                      </td>
                    </tr>
                  )
                })}
                {expenses.length === 0 && (
                  <tr><td colSpan={5}><EmptyState title="Gider kaydı bulunamadı." /></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* MODALS */}
      {!isReadOnly && showAddAccount && (
        <Modal open onClose={() => setShowAddAccount(false)} title="Hesap / Kart Ekle" size="md" className="max-w-md rounded-3xl animate-in zoom-in-95 duration-200">
            <form onSubmit={handleCreateAccount} className="space-y-4">
                <Select label="Hesap Türü" required value={accountForm.type} onChange={e => {
                    const isLiab = ['credit_card', 'personal_card', 'personal_current_account'].includes(e.target.value);
                    setAccountForm({...accountForm, type: e.target.value, is_liability: isLiab ? '1' : '0'})
                  }} 
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white"
                >
                  <option value="bank">Banka Hesabı / Kasa</option>
                  <option value="credit_card">Şirket Kredi Kartı</option>
                  <option value="personal_card">Kişisel Kredi Kartı</option>
                  <option value="personal_current_account">Ortak / Personel Cari Hesabı</option>
                </Select>
              <Input label="Hesap Adı" required type="text" value={accountForm.name} onChange={e => setAccountForm({...accountForm, name: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" placeholder="Örn: Garanti BBVA Kredi Kartı" />
              {accountForm.type === 'credit_card' && (
                <>
                  <Input label="Kart Limiti (TRY)" type="number" required value={accountForm.credit_limit} onChange={e => setAccountForm({...accountForm, credit_limit: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="Hesap Kesim Günü" type="number" min="1" max="31" value={accountForm.cutoff_day} onChange={e => setAccountForm({...accountForm, cutoff_day: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                    <Input label="Son Ödeme Günü" type="number" min="1" max="31" value={accountForm.payment_due_day} onChange={e => setAccountForm({...accountForm, payment_due_day: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                  </div>
                </>
              )}
              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="ghost" onClick={() => setShowAddAccount(false)} className="rounded-xl px-5 py-2.5 font-bold text-gray-600 hover:bg-gray-100">İptal</Button>
                <Button type="submit" className="rounded-xl bg-blue-600 px-6 py-2.5 font-bold shadow-lg shadow-blue-200 hover:bg-blue-700">Hesabı Ekle</Button>
              </div>
            </form>
        </Modal>
      )}

      {!isReadOnly && showAddExpense && (
        <Modal open onClose={() => setShowAddExpense(false)} title="Gelişmiş Gider Ekle" size="lg" className="max-w-2xl rounded-3xl animate-in zoom-in-95 duration-200">
            <form onSubmit={handleSaveExpense} className="inline-block w-full space-y-5 text-left">
              <div className="grid grid-cols-2 gap-4">
                <Input label="Tarih" type="date" required value={expenseForm.date} onChange={e => setExpenseForm({...expenseForm, date: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                <Input label="Kategori" type="text" required placeholder="Yemek, Akaryakıt vb." value={expenseForm.category} onChange={e => setExpenseForm({...expenseForm, category: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <Input label="Tutar" type="number" step="0.01" required value={expenseForm.amount} onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                <Select label="Para Birimi" value={expenseForm.currency} onChange={e => setExpenseForm({...expenseForm, currency: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white"><option value="TRY">TRY</option><option value="USD">USD</option></Select>
                <Input label={<>Kur <span className="font-normal text-gray-400">(Opsiyonel)</span></>} type="number" step="0.0001" placeholder="Otomatik" value={expenseForm.exchange_rate} onChange={e => setExpenseForm({...expenseForm, exchange_rate: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
              </div>
              <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-5">
                <Select label="Gider Nereden Ödendi?" required value={expenseForm.cash_account_id} onChange={e => setExpenseForm({...expenseForm, cash_account_id: e.target.value, payer_person_id: ''})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                    <option value="">Seçiniz...</option>
                    <optgroup label="Şirket Hesapları & Kredi Kartları">
                      {accounts.filter(a => ['bank', 'cash', 'credit_card'].includes(a.type)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                    <optgroup label="Kişisel / Ortak Kartları (Kişiye Borçlanılır)">
                      {accounts.filter(a => ['personal_card', 'personal_current_account'].includes(a.type)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                  </Select>
                <div className="flex items-center pl-2 pt-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={expenseForm.is_stock_related} onChange={e => setExpenseForm({...expenseForm, is_stock_related: e.target.checked})} className="w-5 h-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                    <span className="text-sm font-bold text-gray-700">Stok alımıyla mı ilişkili?</span >
                  </label>
                </div>
              </div>
              <div className="bg-amber-50 rounded-xl p-4 border border-amber-100 flex items-start gap-4">
                <input type="checkbox" id="is_invoice" checked={expenseForm.is_invoice} onChange={e => setExpenseForm({...expenseForm, is_invoice: e.target.checked})} className="mt-1 w-5 h-5 rounded border-amber-300 text-amber-600 focus:ring-amber-500" />
                <div className="flex-1">
                  <label htmlFor="is_invoice" className="block text-sm font-bold text-amber-900 cursor-pointer mb-2">Bu giderin faturası var mı?</label>
                  {expenseForm.is_invoice && (
                    <Input type="text" placeholder="Fatura kimin adına kesildi?" required value={expenseForm.invoice_name} onChange={e => setExpenseForm({...expenseForm, invoice_name: e.target.value})} className="w-full px-4 py-2 bg-white border border-amber-200 text-amber-900 rounded-lg focus:ring-2 focus:ring-amber-500" />
                  )}
                </div>
              </div>
              <div><label className="block text-sm font-bold text-gray-700 mb-1">Açıklama / Kurum Adı</label><textarea rows={2} required value={expenseForm.title} onChange={e => setExpenseForm({...expenseForm, title: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white resize-none" placeholder="Trendyol Yemek, Ofis Kırtasiye..." /></div>
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <Button type="button" variant="ghost" onClick={() => setShowAddExpense(false)} className="rounded-xl px-5 py-2.5 font-bold text-gray-600 hover:bg-gray-100">İptal</Button>
                <Button type="submit" variant="danger" className="rounded-xl bg-rose-600 px-6 py-2.5 font-bold shadow-lg shadow-rose-200 hover:bg-rose-700">Gideri Kaydet</Button>
              </div>
            </form>
        </Modal>
      )}

      {!isReadOnly && showTransfer && (
        <Modal open onClose={() => setShowTransfer(false)} title="Transfer / Kredi Kartı Ödemesi" size="md" className="max-w-md rounded-3xl animate-in zoom-in-95 duration-200">
            <form onSubmit={handleTransfer} className="space-y-4">
              <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={transferForm.is_capital} onChange={e => setTransferForm({...transferForm, is_capital: e.target.checked, from_account_id: ''})} className="w-5 h-5 rounded border-blue-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-sm font-bold text-blue-900">Bu bir sermaye girişi mi? <br/><span className="font-normal text-blue-700 text-xs">(Dışarıdan şirkete para girişi)</span></span>
                </label>
              </div>
              {!transferForm.is_capital && (
                <Select label="Gönderen Hesap (Nereden?)" required value={transferForm.from_account_id} onChange={e => setTransferForm({...transferForm, from_account_id: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                    <option value="">Seçiniz...</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>
              )}
              <Select label={transferForm.is_capital ? 'Para Hangi Hesaba Girdi?' : 'Alıcı Hesap (Kredi Kartı / Cari Mevduat vb.)'} required value={transferForm.to_account_id} onChange={e => setTransferForm({...transferForm, to_account_id: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                  <option value="">Seçiniz...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              <Input label="Tutar (TRY)" type="number" step="0.01" required value={transferForm.amount} onChange={e => setTransferForm({...transferForm, amount: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
              <Input label="Açıklama" type="text" required value={transferForm.description} onChange={e => setTransferForm({...transferForm, description: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" placeholder="Sermaye ilavesi, Kredi kartı ödemesi vb." />
              <div className="flex justify-end gap-3 pt-4">
                <Button type="button" variant="ghost" onClick={() => setShowTransfer(false)} className="rounded-xl px-5 py-2.5 font-bold text-gray-600 hover:bg-gray-100">İptal</Button>
                <Button type="submit" className="rounded-xl bg-blue-600 px-6 py-2.5 font-bold shadow-lg shadow-blue-200 hover:bg-blue-700">İşlemi Tamamla</Button>
              </div>
            </form>
        </Modal>
      )}
    </div>
  );

  function FinanceSummaryCard({ title, val, icon: Icon, color, isDebt }: any) {
    return (
      <Card padding="sm" className="flex flex-col justify-between rounded-3xl border-gray-100 p-5 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] transition-shadow hover:shadow-[0_8px_30px_-4px_rgba(0,0,0,0.1)]">
        <div className="flex items-center gap-3 mb-5">
           <div className={`p-3 rounded-2xl bg-gray-50 ${color}`}><Icon className="w-6 h-6" /></div>
           <p className="text-xs font-bold text-gray-500 uppercase tracking-widest leading-snug">{title}</p>
        </div>
        <div className={`text-3xl font-black ${isDebt && val > 0 ? 'text-red-500' : 'text-gray-900'}`}>
          <FormatAmount amount={val || 0} />
        </div>
      </Card>
    );
  }
}

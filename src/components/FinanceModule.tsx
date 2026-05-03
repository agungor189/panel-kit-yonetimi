import React, { useState, useEffect } from 'react';
import { 
  Building2, CreditCard, Wallet, Users, ArrowRightLeft, Plus, DollarSign, 
  TrendingUp, TrendingDown, Package, PiggyBank, Receipt, LayoutDashboard, Search, FileText, CheckCircle2
} from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { useAuth } from '../App';

export default function FinanceModule({ settings }: any) {
  const { isReadOnly } = useAuth();
  const { FormatAmount, viewCurrency } = useCurrency();
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-20">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight">Finans Merkezi</h2>
          <p className="text-sm text-gray-500 mt-1">Gelişmiş kasa, banka, kredi kartı ve gider yönetimi.</p>
        </div>
        {!isReadOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setShowAddExpense(true)} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold rounded-xl flex items-center gap-2 shadow-lg shadow-rose-200">
              <Receipt className="w-5 h-5" /> Gelişmiş Gider Ekle
            </button>
            <button onClick={() => setShowTransfer(true)} className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl flex items-center gap-2 shadow-lg shadow-blue-200">
              <ArrowRightLeft className="w-5 h-5" /> Transfer / Ödeme
            </button>
          </div>
        )}
      </div>

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

      {activeTab === 'dashboard' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card title="Toplam Sermaye Girişi" val={summary.capitalInjection} icon={PiggyBank} color="text-green-600" />
            <Card title="Satış Geliri" val={summary.salesRevenue} icon={TrendingUp} color="text-blue-600" />
            <Card title="Toplam Gider" val={summary.totalExpense} icon={TrendingDown} color="text-red-600" />
            <Card title="Stoka Bağlanan Sermaye" val={summary.capitalInStock} icon={Package} color="text-amber-600" />
            
            <Card title="Şirket Kredi Kartı Borcu" val={summary.ccDebt} icon={CreditCard} color="text-red-500" isDebt />
            <Card title="Kişisel Borçlar" val={summary.personalDebt} icon={Users} color="text-orange-500" isDebt />
            <Card title="Mevcut Banka/Kasa" val={summary.existingCash} icon={Building2} color="text-emerald-600" />
            <Card title="Net Nakit" val={summary.netCash} icon={Wallet} color={summary.netCash >= 0 ? "text-green-600" : "text-red-600"} />
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

      {activeTab === 'accounts' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="font-black text-lg text-gray-900">Hesaplar ve Kartlar</h3>
            {!isReadOnly && (
              <button onClick={() => setShowAddAccount(true)} className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 text-sm font-bold rounded-xl flex items-center gap-2">
                <Plus className="w-4 h-4" /> Yeni Hesap Ekle
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {accounts.map(acc => {
              const bal = calculateBalance(acc.id);
              const isDanger = acc.is_liability === 1 && Math.abs(bal) > (acc.credit_limit || 0) * 0.8 && acc.credit_limit > 0;
              return (
                <div key={acc.id} className="bg-white rounded-2xl p-6 border border-gray-200 shadow-sm relative overflow-hidden group">
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
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'expenses' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
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
                        <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold bg-gray-100 text-gray-700">
                          {person ? `👤 ${person.name}` : account ? `🏦 ${account.name}` : 'Belirsiz'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {e.is_invoice ? <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-green-100 text-green-700">Faturalı ({e.invoice_name})</span> : <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-amber-100 text-amber-700">Faturasız</span>}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="font-black text-gray-900"><FormatAmount amount={e.amount_try || e.amount} originalCurrency="TRY" /></div>
                        {e.currency !== 'TRY' && <div className="text-xs text-gray-400 font-medium">{e.amount} {e.currency} (Kur: {e.exchange_rate_at_transaction})</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODALS */}
      {!isReadOnly && showAddAccount && (
        <div className="fixed inset-0 z-50 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-xl font-black text-gray-900">Hesap / Kart Ekle</h3>
            </div>
            <form onSubmit={handleCreateAccount} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Hesap Türü</label>
                <select required value={accountForm.type} onChange={e => {
                    const isLiab = ['credit_card', 'personal_card', 'personal_current_account'].includes(e.target.value);
                    setAccountForm({...accountForm, type: e.target.value, is_liability: isLiab ? '1' : '0'})
                  }} 
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white"
                >
                  <option value="bank">Banka Hesabı / Kasa</option>
                  <option value="credit_card">Şirket Kredi Kartı</option>
                  <option value="personal_card">Kişisel Kredi Kartı</option>
                  <option value="personal_current_account">Ortak / Personel Cari Hesabı</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Hesap Adı</label>
                <input required type="text" value={accountForm.name} onChange={e => setAccountForm({...accountForm, name: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" placeholder="Örn: Garanti BBVA Kredi Kartı" />
              </div>
              {accountForm.type === 'credit_card' && (
                <>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Kart Limiti (TRY)</label>
                    <input type="number" required value={accountForm.credit_limit} onChange={e => setAccountForm({...accountForm, credit_limit: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-1">Hesap Kesim Günü</label>
                      <input type="number" min="1" max="31" value={accountForm.cutoff_day} onChange={e => setAccountForm({...accountForm, cutoff_day: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-1">Son Ödeme Günü</label>
                      <input type="number" min="1" max="31" value={accountForm.payment_due_day} onChange={e => setAccountForm({...accountForm, payment_due_day: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" />
                    </div>
                  </div>
                </>
              )}
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={() => setShowAddAccount(false)} className="px-5 py-2.5 text-gray-600 font-bold hover:bg-gray-100 rounded-xl">İptal</button>
                <button type="submit" className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200">Hesabı Ekle</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {!isReadOnly && showAddExpense && (
        <div className="fixed inset-0 z-50 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-gray-100 flex-shrink-0">
              <h3 className="text-xl font-black text-gray-900">Gelişmiş Gider Ekle</h3>
            </div>
            <form onSubmit={handleSaveExpense} className="p-6 space-y-5 overflow-y-auto w-full inline-block text-left">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-bold text-gray-700 mb-1">Tarih</label><input type="date" required value={expenseForm.date} onChange={e => setExpenseForm({...expenseForm, date: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" /></div>
                <div><label className="block text-sm font-bold text-gray-700 mb-1">Kategori</label><input type="text" required placeholder="Yemek, Akaryakıt vb." value={expenseForm.category} onChange={e => setExpenseForm({...expenseForm, category: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" /></div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-1"><label className="block text-sm font-bold text-gray-700 mb-1">Tutar</label><input type="number" step="0.01" required value={expenseForm.amount} onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" /></div>
                <div className="col-span-1"><label className="block text-sm font-bold text-gray-700 mb-1">Para Birimi</label><select value={expenseForm.currency} onChange={e => setExpenseForm({...expenseForm, currency: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white"><option value="TRY">TRY</option><option value="USD">USD</option></select></div>
                <div className="col-span-1"><label className="block text-sm font-bold text-gray-700 mb-1">Kur <span className="font-normal text-gray-400">(Opsiyonel)</span></label><input type="number" step="0.0001" placeholder="Otomatik" value={expenseForm.exchange_rate} onChange={e => setExpenseForm({...expenseForm, exchange_rate: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4 border-t border-gray-100 pt-5">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Gider Nereden Ödendi?</label>
                  <select required value={expenseForm.cash_account_id} onChange={e => setExpenseForm({...expenseForm, cash_account_id: e.target.value, payer_person_id: ''})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                    <option value="">Seçiniz...</option>
                    <optgroup label="Şirket Hesapları & Kredi Kartları">
                      {accounts.filter(a => ['bank', 'cash', 'credit_card'].includes(a.type)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                    <optgroup label="Kişisel / Ortak Kartları (Kişiye Borçlanılır)">
                      {accounts.filter(a => ['personal_card', 'personal_current_account'].includes(a.type)).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </optgroup>
                  </select>
                </div>
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
                    <input type="text" placeholder="Fatura kimin adına kesildi?" required value={expenseForm.invoice_name} onChange={e => setExpenseForm({...expenseForm, invoice_name: e.target.value})} className="w-full px-4 py-2 bg-white border border-amber-200 text-amber-900 rounded-lg focus:ring-2 focus:ring-amber-500" />
                  )}
                </div>
              </div>
              <div><label className="block text-sm font-bold text-gray-700 mb-1">Açıklama / Kurum Adı</label><textarea rows={2} required value={expenseForm.title} onChange={e => setExpenseForm({...expenseForm, title: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white resize-none" placeholder="Trendyol Yemek, Ofis Kırtasiye..." /></div>
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={() => setShowAddExpense(false)} className="px-5 py-2.5 text-gray-600 font-bold hover:bg-gray-100 rounded-xl">İptal</button>
                <button type="submit" className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-xl shadow-lg shadow-rose-200">Gideri Kaydet</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {!isReadOnly && showTransfer && (
        <div className="fixed inset-0 z-50 bg-gray-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="p-6 border-b border-gray-100">
              <h3 className="text-xl font-black text-gray-900">Transfer / Kredi Kartı Ödemesi</h3>
            </div>
            <form onSubmit={handleTransfer} className="p-6 space-y-4">
              <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={transferForm.is_capital} onChange={e => setTransferForm({...transferForm, is_capital: e.target.checked, from_account_id: ''})} className="w-5 h-5 rounded border-blue-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-sm font-bold text-blue-900">Bu bir sermaye girişi mi? <br/><span className="font-normal text-blue-700 text-xs">(Dışarıdan şirkete para girişi)</span></span>
                </label>
              </div>
              {!transferForm.is_capital && (
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Gönderen Hesap (Nereden?)</label>
                  <select required value={transferForm.from_account_id} onChange={e => setTransferForm({...transferForm, from_account_id: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                    <option value="">Seçiniz...</option>
                    {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">{transferForm.is_capital ? 'Para Hangi Hesaba Girdi?' : 'Alıcı Hesap (Kredi Kartı / Cari Mevduat vb.)'}</label>
                <select required value={transferForm.to_account_id} onChange={e => setTransferForm({...transferForm, to_account_id: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white">
                  <option value="">Seçiniz...</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div><label className="block text-sm font-bold text-gray-700 mb-1">Tutar (TRY)</label><input type="number" step="0.01" required value={transferForm.amount} onChange={e => setTransferForm({...transferForm, amount: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" /></div>
              <div><label className="block text-sm font-bold text-gray-700 mb-1">Açıklama</label><input type="text" required value={transferForm.description} onChange={e => setTransferForm({...transferForm, description: e.target.value})} className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:bg-white" placeholder="Sermaye ilavesi, Kredi kartı ödemesi vb." /></div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={() => setShowTransfer(false)} className="px-5 py-2.5 text-gray-600 font-bold hover:bg-gray-100 rounded-xl">İptal</button>
                <button type="submit" className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-200">İşlemi Tamamla</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );

  function Card({ title, val, icon: Icon, color, isDebt }: any) {
    return (
      <div className="bg-white p-5 rounded-3xl border border-gray-100 shadow-[0_4px_20px_-4px_rgba(0,0,0,0.05)] flex flex-col justify-between hover:shadow-[0_8px_30px_-4px_rgba(0,0,0,0.1)] transition-shadow">
        <div className="flex items-center gap-3 mb-5">
           <div className={`p-3 rounded-2xl bg-gray-50 ${color}`}><Icon className="w-6 h-6" /></div>
           <p className="text-xs font-bold text-gray-500 uppercase tracking-widest leading-snug">{title}</p>
        </div>
        <div className={`text-3xl font-black ${isDebt && val > 0 ? 'text-red-500' : 'text-gray-900'}`}>
          <FormatAmount amount={val || 0} />
        </div>
      </div>
    );
  }
}

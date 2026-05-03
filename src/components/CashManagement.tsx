import React, { useState, useEffect } from 'react';
import { DollarSign, Search, Plus, ArrowRightLeft, Landmark, CreditCard, Banknote } from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { useAuth } from '../App';

export default function CashManagement() {
  const { FormatAmount, viewCurrency } = useCurrency();
  const { isReadOnly } = useAuth();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Transfer Modal
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({
    from_account_id: '',
    to_account_id: '',
    amount: '',
    rate: '',
    description: ''
  });

  const [filterAccount, setFilterAccount] = useState('');
  const [filterType, setFilterType] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredAccounts = accounts.filter(acc => {
    if (viewCurrency === 'TRY') return acc.currency === 'TRY';
    if (viewCurrency === 'USD') return acc.currency === 'USD';
    return true; // ALL
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [accRes, txRes] = await Promise.all([
        api.get('/cash-accounts'),
        api.get('/cash-transactions')
      ]);
      setAccounts(accRes);
      setTransactions(txRes);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    try {
      await api.post('/cash-transfer', transferForm);
      setShowTransfer(false);
      setTransferForm({ from_account_id: '', to_account_id: '', amount: '', rate: '', description: '' });
      loadData();
    } catch (err: any) {
      alert(err.message || "Transfer hatası");
    }
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

  const filteredTransactions = transactions.filter(tx => {
    if (filterAccount && tx.account_id !== filterAccount) return false;
    if (filterType && tx.type !== filterType) return false;
    if (searchQuery && !tx.description?.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-[#0F172A] tracking-tight">Kasa ve Nakit Akışı</h2>
          <p className="text-xs lg:text-sm text-[#64748B]">Banka, nakit ve platformlardaki bekleyen ödemelerinizi takip edin.</p>
        </div>
        {!isReadOnly && (
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setShowTransfer(true)}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-sm"
          >
            <ArrowRightLeft className="w-4 h-4" /> Transfer Yap
          </button>
        </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {filteredAccounts.map(acc => (
          <div key={acc.id} className="bg-white rounded-2xl p-6 border border-[#E2E8F0] shadow-sm">
             <div className="flex justify-between items-start mb-4">
               <div>
                 <div className="text-xs font-bold text-gray-500">{acc.type.toUpperCase()} HESABI</div>
                 <div className="text-sm font-semibold text-gray-900 leading-tight mt-1">{acc.name}</div>
               </div>
               <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center">
                 {acc.type === 'cash' && <Banknote className="w-5 h-5 text-green-600" />}
                 {acc.type === 'bank' && <Landmark className="w-5 h-5 text-blue-600" />}
                 {acc.type === 'platform' && <CreditCard className="w-5 h-5 text-purple-600" />}
               </div>
             </div>
             <div className="text-2xl font-black text-gray-900">
               <FormatAmount amount={calculateBalance(acc.id)} originalCurrency={acc.currency} />
             </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
        <div className="p-5 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-gray-50/50">
          <h3 className="font-bold text-gray-800">Kasa Hareketleri</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <select 
              value={filterAccount} onChange={e => setFilterAccount(e.target.value)}
              className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs outline-none"
            >
              <option value="">Tüm Hesaplar</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select 
              value={filterType} onChange={e => setFilterType(e.target.value)}
              className="px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs outline-none"
            >
              <option value="">Tüm Tipler</option>
              <option value="IN">Nakit Girişi (IN)</option>
              <option value="OUT">Nakit Çıkışı (OUT)</option>
            </select>
            <div className="relative">
              <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input 
                type="text" placeholder="Açıklama Ara..."
                value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                className="pl-7 pr-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs outline-none"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left min-w-[800px]">
            <thead className="bg-[#F8FAFC] text-[#64748B] font-bold text-[11px] uppercase tracking-wider">
              <tr>
                 <th className="px-6 py-4">Tarih</th>
                 <th className="px-6 py-4">Hesap</th>
                 <th className="px-6 py-4">Tip</th>
                 <th className="px-6 py-4">Açıklama</th>
                 <th className="px-6 py-4 text-right">Tutar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] bg-white">
               {filteredTransactions.map(tx => (
                 <tr key={tx.id} className="hover:bg-gray-50/50">
                   <td className="px-6 py-4 text-xs font-mono text-gray-500">{new Date(tx.created_at).toLocaleString('tr-TR')}</td>
                   <td className="px-6 py-4 font-semibold text-gray-800">{tx.account_name}</td>
                   <td className="px-6 py-4">
                     <span className={`px-2 py-1 rounded text-[10px] font-bold ${tx.type === 'IN' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                       {tx.type} {tx.source_type && `(${tx.source_type})`}
                     </span>
                   </td>
                   <td className="px-6 py-4 text-gray-600">{tx.description}</td>
                   <td className={`px-6 py-4 text-right font-black ${tx.type === 'IN' ? 'text-green-600' : 'text-red-600'}`}>
                     {tx.type === 'IN' ? '+' : '-'}<FormatAmount align="right" amount={tx.amount} originalCurrency={tx.account_currency} exchangeRateAtTransaction={tx.exchange_rate_at_transaction} />
                   </td>
                 </tr>
               ))}
               {transactions.length === 0 && !loading && (
                 <tr>
                   <td colSpan={5} className="px-6 py-8 text-center text-gray-500">Kasa hareketi bulunamadı.</td>
                 </tr>
               )}
            </tbody>
          </table>
        </div>
      </div>

      {!isReadOnly && showTransfer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white rounded-2xl shadow-xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
               <h3 className="font-bold text-gray-800">Transfer Yap</h3>
               <button onClick={() => setShowTransfer(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6">
              <form onSubmit={handleTransfer} className="space-y-4">
                 <div>
                   <label className="block text-xs font-bold text-gray-500 mb-1 tracking-wide">Kaynak Hesap (Çıkış)</label>
                   <select 
                     required
                     value={transferForm.from_account_id}
                     onChange={e => setTransferForm({...transferForm, from_account_id: e.target.value})}
                     className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                   >
                     <option value="">Seçiniz...</option>
                     {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                   </select>
                 </div>
                 <div>
                   <label className="block text-xs font-bold text-gray-500 mb-1 tracking-wide">Hedef Hesap (Giriş)</label>
                   <select 
                     required
                     value={transferForm.to_account_id}
                     onChange={e => setTransferForm({...transferForm, to_account_id: e.target.value})}
                     className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                   >
                     <option value="">Seçiniz...</option>
                     {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                   </select>
                 </div>
                 <div>
                   <label className="block text-xs font-bold text-gray-500 mb-1 tracking-wide">Tutar (Kaynak Para Birimiyle)</label>
                   <input 
                     type="number" step="0.01" min="0.01" required
                     value={transferForm.amount}
                     onChange={e => setTransferForm({...transferForm, amount: e.target.value})}
                     className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                   />
                 </div>
                 {transferForm.from_account_id && transferForm.to_account_id && 
                  accounts.find(a => a.id === transferForm.from_account_id)?.currency !== accounts.find(a => a.id === transferForm.to_account_id)?.currency && (
                  <div>
                    <label className="block text-xs font-bold text-gray-500 mb-1 tracking-wide">Döviz Kuru</label>
                    <input 
                      type="number" step="0.0001" min="0.0001" required
                      value={transferForm.rate}
                      onChange={e => setTransferForm({...transferForm, rate: e.target.value})}
                      className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                  </div>
                 )}
                 <div>
                   <label className="block text-xs font-bold text-gray-500 mb-1 tracking-wide">Açıklama</label>
                   <input 
                     type="text" required
                     value={transferForm.description}
                     onChange={e => setTransferForm({...transferForm, description: e.target.value})}
                     className="w-full px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                   />
                 </div>

                 <button type="submit" className="w-full px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl mt-4">
                    Transferi Onayla
                 </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

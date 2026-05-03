import React, { useState, useEffect } from 'react';
import { Plus, Search, FileText, Download, Trash2, X, ChevronRight, Calculator, Calendar, DollarSign, Tag, Image as ImageIcon, Briefcase, FileSignature, Paperclip } from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { Transaction, ExpenseAttachment, Settings } from '../types';
import { useAuth } from '../App';

export default function Expenses({ settings }: { settings?: Settings | null }) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [expenses, setExpenses] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const [selectedExpense, setSelectedExpense] = useState<Transaction | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);

  useEffect(() => {
    loadExpenses();
  }, []);

  const loadExpenses = async () => {
    setLoading(true);
    try {
      const data = await api.get('/expenses');
      setExpenses(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const filteredExpenses = expenses.filter(e =>
    (e.title?.toLowerCase().includes(search.toLowerCase())) ||
    (e.note?.toLowerCase().includes(search.toLowerCase())) ||
    (e.category?.toLowerCase().includes(search.toLowerCase())) ||
    (e.supplier?.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-black text-gray-900 tracking-tight">Gider Yönetimi</h2>
          <p className="text-gray-500 mt-1">Fatura, fiş ve harcamalarınızı detaylı takip edin.</p>
        </div>
        {!isReadOnly && (
          <button
            onClick={() => setShowAddModal(true)}
            className="px-6 py-2.5 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition shadow-lg shadow-blue-200 flex items-center"
          >
            <Plus className="w-5 h-5 mr-2" />
            Yeni Gider Ekle
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100 bg-gray-50 flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
            <input
              type="text"
              placeholder="Giderlerde ara..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-white border-b border-gray-100 text-gray-500 text-sm">
                <th className="px-6 py-4 font-bold">Tarih</th>
                <th className="px-6 py-4 font-bold">Kategori</th>
                <th className="px-6 py-4 font-bold">Başlık / Açıklama</th>
                <th className="px-6 py-4 font-bold">Ödeme Yöntemi</th>
                <th className="px-6 py-4 font-bold">Ek/Fatura</th>
                <th className="px-6 py-4 font-bold text-right">Tutar</th>
                <th className="px-6 py-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredExpenses.map(expense => (
                <tr
                  key={expense.id}
                  onClick={() => setSelectedExpense(expense)}
                  className="hover:bg-blue-50/50 cursor-pointer transition-colors group"
                >
                  <td className="px-6 py-4 text-gray-900 font-medium whitespace-nowrap">
                    {new Date(expense.date).toLocaleDateString('tr-TR')}
                  </td>
                  <td className="px-6 py-4">
                    <span className="px-3 py-1 bg-gray-100 text-gray-700 text-xs font-bold rounded-lg whitespace-nowrap">
                      {expense.category || 'Belirsiz'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-bold text-gray-900">{expense.title || expense.note || '-'}</div>
                    <div className="text-sm text-gray-500 truncate max-w-xs">{expense.description}</div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {expense.payment_method || expense.platform || '-'}
                  </td>
                  <td className="px-6 py-4">
                    {expense.attachment_count && expense.attachment_count > 0 ? (
                      <span className="flex items-center text-blue-600 font-medium text-sm bg-blue-50 px-2 py-1 rounded-md w-max">
                        <Paperclip className="w-4 h-4 mr-1" />
                        {expense.attachment_count} Ek
                      </span>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-black text-right whitespace-nowrap text-red-600">
                    <FormatAmount align="right" amount={expense.amount || 0} originalCurrency={(expense as any).currency || 'TRY'} exchangeRateAtTransaction={expense.exchange_rate_at_transaction} />
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button className="text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity p-2 hover:bg-blue-50 rounded-lg">
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredExpenses.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    Gider bulunamadı.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedExpense && (
        <ExpenseDetailModal
          expense={selectedExpense}
          onClose={() => setSelectedExpense(null)}
          onRefresh={loadExpenses}
          settings={settings}
        />
      )}

      {!isReadOnly && showAddModal && (
        <ExpenseAddModal
          onClose={() => setShowAddModal(false)}
          onRefresh={loadExpenses}
          settings={settings}
        />
      )}
    </div>
  );
}

function ExpenseAddModal({ onClose, onRefresh, settings }: { onClose: () => void, onRefresh: () => void, settings?: Settings | null }) {
  const { isReadOnly } = useAuth();
  const [saving, setSaving] = useState(false);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    category: '',
    title: '',
    description: '',
    amount: '',
    payment_method: '',
    supplier: '',
    invoice_number: '',
    cash_account_id: ''
  });

  const categories = settings?.expense_categories || [];

  useEffect(() => {
    api.get('/cash-accounts').then(setCashAccounts).catch(console.error);
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    if (!formData.title || !formData.amount || !formData.category || !formData.cash_account_id) {
      alert("Lütfen başlık, tutar, kategori ve kasa hesabı giriniz.");
      return;
    }

    setSaving(true);
    try {
      await api.post('/expenses', {
        ...formData,
        amount: parseFloat(formData.amount),
        platform: formData.payment_method || 'Kasa',
        note: formData.title // Fallback for transactions compatibility
      });
      onRefresh();
      onClose();
    } catch(err) {
      alert("Hata oluştu");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose}></div>
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden relative animate-in zoom-in-95 duration-200">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-bold text-lg text-gray-900">Yeni Gider Ekle</h3>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Tarih</label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={e => setFormData({...formData, date: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                  required
                />
             </div>
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Kategori</label>
                <select
                  value={formData.category}
                  onChange={e => setFormData({...formData, category: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                  required
                >
                  <option value="">Seçiniz...</option>
                  {categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
             </div>
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Başlık</label>
            <input
              type="text"
              value={formData.title}
              onChange={e => setFormData({...formData, title: e.target.value})}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
              placeholder="Örn: Trendyol Kargo Gideri"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Açıklama</label>
            <textarea
              value={formData.description}
              onChange={e => setFormData({...formData, description: e.target.value})}
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors min-h-[80px]"
              placeholder="Gider hakkında detaylar..."
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Tutar (₺)</label>
                <input
                  type="number"
                  step="0.01"
                  value={formData.amount}
                  onChange={e => setFormData({...formData, amount: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors font-mono"
                  placeholder="0.00"
                  required
                />
             </div>
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Kasa Hesabı (Çıkış)</label>
                <select
                  value={formData.cash_account_id}
                  onChange={e => setFormData({...formData, cash_account_id: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                  required
                >
                  <option value="">Seçiniz...</option>
                  {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                </select>
             </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Firma / Tedarikçi</label>
                <input
                  type="text"
                  value={formData.supplier}
                  onChange={e => setFormData({...formData, supplier: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                  placeholder="Örn: Yurtiçi Kargo"
                />
             </div>
             <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Fatura Numarası</label>
                <input
                  type="text"
                  value={formData.invoice_number}
                  onChange={e => setFormData({...formData, invoice_number: e.target.value})}
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
                />
             </div>
          </div>

          <div className="pt-2">
             <p className="text-sm text-gray-500 mb-4 px-1">Fatura, fiş veya diğer ekleri gideri oluşturduktan sonra detay ekranından yükleyebilirsiniz.</p>
             <button
               type="submit"
               disabled={saving}
               className="w-full py-3 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition shadow-lg disabled:opacity-50"
             >
               {saving ? "Kaydediliyor..." : "Gideri Kaydet"}
             </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ExpenseDetailModal({ expense: currentExpense, onClose, onRefresh, settings }: { expense: Transaction, onClose: () => void, onRefresh: () => void, settings?: Settings | null }) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [expense, setExpense] = useState<Transaction>(currentExpense);
  const [attachments, setAttachments] = useState<ExpenseAttachment[]>([]);
  const [activeTab, setActiveTab] = useState<'details'|'attachments'>('details');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Edit form state
  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    date: '',
    category: '',
    title: '',
    description: '',
    amount: '',
    payment_method: '',
    supplier: '',
    invoice_number: ''
  });

  const categories = settings?.expense_categories || [];

  useEffect(() => {
    loadDetails();
  }, [currentExpense.id]);

  const loadDetails = async () => {
    try {
      const data = await api.get(`/expenses/${currentExpense.id}`);
      setExpense(data);
      setAttachments(data.attachments || []);
      setFormData({
        date: data.date.split('T')[0] || '',
        category: data.category || '',
        title: data.title || data.note || '',
        description: data.description || '',
        amount: data.amount?.toString() || '',
        payment_method: data.payment_method || data.platform || '',
        supplier: data.supplier || '',
        invoice_number: data.invoice_number || ''
      });
    } catch(err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (isReadOnly) return;
    if (!confirm("Bu gider kaydını ve bağlı ekleri silmek istediğinize emin misiniz?")) return;
    try {
      await api.delete(`/expenses/${expense.id}`);
      onRefresh();
      onClose();
    } catch(err) {
      alert("Silinirken hata oluştu.");
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    setSaving(true);
    try {
      await api.put(`/expenses/${expense.id}`, {
        ...formData,
        amount: parseFloat(formData.amount),
        platform: formData.payment_method, // maintain compatibility
        note: formData.title
      });
      setIsEditing(false);
      await loadDetails();
      onRefresh();
    } catch(err) {
      alert("Hata oluştu");
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isReadOnly) return;
    if (!e.target.files || e.target.files.length === 0) return;
    const file = e.target.files[0];

    // Check sizes/types basically (already checked in backend)
    if (file.size > 10 * 1024 * 1024) {
      alert('Dosya boyutu 10MB tan büyük olamaz.');
      return;
    }

    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api.upload(`/expenses/${expense.id}/attachments`, fd);
      await loadDetails();
      onRefresh(); // Refresh list to update attachment count
    } catch(err: any) {
      alert(err.response?.data?.error || "Dosya yüklenirken hata oluştu.");
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteAttachment = async (attId: string) => {
    if (isReadOnly) return;
    if (!confirm("Bunu silmek istediğinizden emin misiniz?")) return;
    try {
      await api.delete(`/expenses/${expense.id}/attachments/${attId}`);
      await loadDetails();
      onRefresh();
    } catch(err) {
      alert("Silinirken hata!");
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose}></div>
      <div className="bg-white w-full max-w-3xl rounded-2xl shadow-2xl flex flex-col overflow-hidden relative animate-in slide-in-from-bottom-8 duration-300 max-h-[90vh]">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div>
            <h3 className="font-bold text-xl text-gray-900">{expense.title || expense.note || 'Gider Detayı'}</h3>
            <p className="text-gray-500 text-sm mt-1">{new Date(expense.date).toLocaleDateString('tr-TR')} · {expense.category}</p>
          </div>
          <div className="flex items-center gap-2">
            {!isReadOnly && (
              <button onClick={handleDelete} className="p-2 text-danger hover:bg-red-50 rounded-lg transition-colors" title="Gideri Sil">
                <Trash2 className="w-5 h-5" />
              </button>
            )}
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex border-b border-gray-100 px-6 pt-2 bg-gray-50/50">
          <button
            onClick={() => setActiveTab('details')}
            className={`px-4 py-3 font-bold border-b-2 transition-colors ${activeTab === 'details' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Gider Bilgileri
          </button>
          <button
            onClick={() => setActiveTab('attachments')}
            className={`px-4 py-3 font-bold border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'attachments' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Fatura & Ekler
            {attachments.length > 0 && (
              <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full text-xs">{attachments.length}</span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
             <div className="flex items-center justify-center p-12"><div className="w-8 h-8 rounded-full border-4 border-blue-200 border-t-blue-600 animate-spin"></div></div>
          ) : (
             <>
               {activeTab === 'details' && (
                 <div>
                   {isEditing ? (
                     <form onSubmit={handleUpdate} className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Tarih</label>
                              <input
                                type="date"
                                value={formData.date}
                                onChange={e => setFormData({...formData, date: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                required
                              />
                           </div>
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Kategori</label>
                              <select
                                value={formData.category}
                                onChange={e => setFormData({...formData, category: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                required
                              >
                                <option value="">Seçiniz...</option>
                                {categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
                              </select>
                           </div>
                        </div>

                        <div>
                          <label className="block text-sm font-bold text-gray-700 mb-1">Başlık</label>
                          <input
                            type="text"
                            value={formData.title}
                            onChange={e => setFormData({...formData, title: e.target.value})}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                            required
                          />
                        </div>

                        <div>
                          <label className="block text-sm font-bold text-gray-700 mb-1">Açıklama</label>
                          <textarea
                            value={formData.description}
                            onChange={e => setFormData({...formData, description: e.target.value})}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 min-h-[80px]"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Tutar (₺)</label>
                              <input
                                type="number"
                                step="0.01"
                                value={formData.amount}
                                onChange={e => setFormData({...formData, amount: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 font-mono"
                                required
                              />
                           </div>
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Ödeme Yöntemi</label>
                              <select
                                value={formData.payment_method}
                                onChange={e => setFormData({...formData, payment_method: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                              >
                                <option value="">Seçiniz...</option>
                                <option value="Kredi Kartı">Kredi Kartı</option>
                                <option value="Banka Transferi (Havale/EFT)">Banka Transferi</option>
                                <option value="Nakit">Nakit</option>
                                <option value="Şirket Hesabı">Şirket Hesabı</option>
                              </select>
                           </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Firma / Tedarikçi</label>
                              <input
                                type="text"
                                value={formData.supplier}
                                onChange={e => setFormData({...formData, supplier: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                              />
                           </div>
                           <div>
                              <label className="block text-sm font-bold text-gray-700 mb-1">Fatura Numarası</label>
                              <input
                                type="text"
                                value={formData.invoice_number}
                                onChange={e => setFormData({...formData, invoice_number: e.target.value})}
                                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                              />
                           </div>
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                          <button type="button" onClick={() => setIsEditing(false)} className="px-4 py-2 bg-gray-100 text-gray-700 font-bold rounded-lg hover:bg-gray-200">İptal</button>
                          <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50">
                            {saving ? "Kaydediliyor..." : "Kaydet"}
                          </button>
                        </div>
                     </form>
                   ) : (
                     <div className="space-y-6">
                        <div className="bg-gray-50 p-6 rounded-xl border border-gray-100 flex items-center justify-between">
                           <div>
                             <p className="text-gray-500 text-sm font-medium mb-1">Toplam Tutar</p>
                             <div className="text-3xl font-black text-gray-900 tracking-tight"><FormatAmount amount={expense.amount || 0} originalCurrency={(expense as any).currency || 'TRY'} exchangeRateAtTransaction={expense.exchange_rate_at_transaction} /></div>
                           </div>
                           {!isReadOnly && (
                             <button onClick={() => setIsEditing(true)} className="px-4 py-2 bg-white border border-gray-200 text-gray-700 font-bold rounded-lg shadow-sm hover:bg-gray-50 transition-colors">
                               Düzenle
                             </button>
                           )}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-6">
                           <div>
                             <p className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Calendar className="w-4 h-4"/> Tarih</p>
                             <p className="font-bold text-gray-900">{new Date(expense.date).toLocaleDateString('tr-TR')}</p>
                           </div>
                           <div>
                             <p className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Tag className="w-4 h-4"/> Kategori</p>
                             <p className="font-bold text-gray-900">{expense.category || '-'}</p>
                           </div>
                           <div>
                             <p className="text-sm text-gray-500 mb-1 flex items-center gap-1"><Briefcase className="w-4 h-4"/> Firma/Tedarikçi</p>
                             <p className="font-bold text-gray-900">{expense.supplier || '-'}</p>
                           </div>
                           <div>
                             <p className="text-sm text-gray-500 mb-1 flex items-center gap-1"><FileSignature className="w-4 h-4"/> Fatura Numarası</p>
                             <p className="font-bold text-gray-900">{expense.invoice_number || '-'}</p>
                           </div>
                           <div>
                             <p className="text-sm text-gray-500 mb-1 flex items-center gap-1"><DollarSign className="w-4 h-4"/> Ödeme Yöntemi</p>
                             <p className="font-bold text-gray-900">{expense.payment_method || expense.platform || '-'}</p>
                           </div>
                        </div>

                        {expense.description && (
                          <div className="pt-6 border-t border-gray-100">
                             <p className="text-sm text-gray-500 mb-2">Açıklama</p>
                             <div className="p-4 bg-gray-50 rounded-xl text-gray-800 text-sm whitespace-pre-wrap leading-relaxed border border-gray-100">
                               {expense.description}
                             </div>
                          </div>
                        )}

                        <div className="pt-6 border-t border-gray-100 flex items-center gap-4 text-xs text-gray-400">
                          <p>Oluşturulma: {expense.created_at ? new Date(expense.created_at).toLocaleString('tr-TR') : '-'}</p>
                          <p>ID: {expense.id}</p>
                        </div>
                     </div>
                   )}
                 </div>
               )}

               {activeTab === 'attachments' && (
                 <div className="space-y-6">
                    <div className="flex justify-between items-center bg-blue-50/50 p-4 rounded-xl border border-blue-100">
                      <div>
                        <h4 className="font-bold text-blue-900 text-sm">Fatura ve Ek Belgeler</h4>
                        <p className="text-blue-700/70 text-xs mt-0.5">JPG, PNG, WEBP, PDF - Maks 10MB</p>
                      </div>
                      {!isReadOnly && (
                        <label className="px-4 py-2 bg-blue-600 text-white font-bold text-sm rounded-lg hover:bg-blue-700 cursor-pointer transition shadow-sm relative overflow-hidden">
                          {uploading ? (
                             <span className="flex items-center"><div className="w-4 h-4 mr-2 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Yükleniyor...</span>
                          ) : "Dosya Yükle"}
                          <input type="file" className="hidden" accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={handleFileUpload} disabled={uploading}/>
                        </label>
                      )}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
                      {attachments.map(att => {
                        const isPdf = att.mime_type === 'application/pdf';
                        const url = `/${att.file_path}`;
                        return (
                          <div key={att.id} className="group relative bg-white border border-gray-200 rounded-xl overflow-hidden hover:border-blue-300 hover:shadow-md transition-all">
                            {isPdf ? (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center justify-center p-6 bg-red-50 aspect-square">
                                <FileText className="w-12 h-12 text-red-500 mb-2" />
                                <span className="text-xs font-bold text-red-700 truncate w-full text-center px-2">{att.file_name}</span>
                              </a>
                            ) : (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="block aspect-square bg-gray-100 relative">
                                <img src={url} alt={att.file_name} className="w-full h-full object-cover" />
                              </a>
                            )}
                            {!isReadOnly && <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDeleteAttachment(att.id); }}
                                className="p-1.5 bg-red-600 text-white rounded-md shadow-lg hover:bg-red-700"
                                title="Sil"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>}
                            <div className="p-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-xs">
                              <span className="truncate flex-1 text-gray-500" title={att.file_name}>{att.file_name}</span>
                              <span className="text-gray-400 ml-2">{(att.file_size / 1024).toFixed(0)}KB</span>
                            </div>
                          </div>
                        )
                      })}
                      {attachments.length === 0 && (
                        <div className="col-span-full py-12 flex flex-col items-center justify-center text-gray-400 border-2 border-dashed border-gray-200 rounded-2xl bg-gray-50/50">
                          <ImageIcon className="w-12 h-12 mb-3 text-gray-300" />
                          <p>Henüz hiç eklenmiş dosya yok.</p>
                        </div>
                      )}
                    </div>
                 </div>
               )}
             </>
          )}
        </div>
      </div>
    </div>
  );
}

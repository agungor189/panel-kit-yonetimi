import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { ApiKey } from '../../types';
import { Key, Plus, Trash2, Edit2, Play, CheckCircle, XCircle, AlertTriangle, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../App';
import toast, { Toaster } from 'react-hot-toast';

export default function ApiKeys() {
  const { isReadOnly } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [formData, setFormData] = useState({
    service_name: '',
    display_name: '',
    key_name: '',
    api_key: '',
    api_secret: '',
    merchant_id: '',
    seller_id: '',
    notes: ''
  });
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const services = ['Hepsiburada', 'Trendyol', 'N11', 'Amazon', 'OpenAI', 'Gemini', 'n8n', 'Other'];

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const data = await api.get('/integrations/keys');
      setKeys(data);
    } catch (err) {
      toast.error('API anahtarları yüklenirken hata oluştu.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;

    if (!formData.service_name || !formData.display_name || (!editingKey && !formData.api_key)) {
      toast.error('Gerekli alanları doldurun.');
      return;
    }

    try {
      if (editingKey) {
        await api.put(`/integrations/keys/${editingKey.id}`, formData);
        toast.success('API Anahtarı güncellendi.');
      } else {
        await api.post('/integrations/keys', formData);
        toast.success('API Anahtarı eklendi.');
      }
      setShowModal(false);
      fetchKeys();
    } catch (err: any) {
      toast.error(err.message || 'Hata oluştu.');
    }
  };

  const handleDelete = async () => {
    if (!deleteId || isReadOnly) return;
    try {
      await api.delete(`/integrations/keys/${deleteId}`);
      toast.success('API Anahtarı silindi.');
      setDeleteId(null);
      fetchKeys();
    } catch (err) {
      toast.error('Silme sırasında hata oluştu.');
    }
  };

  const toggleStatus = async (id: string, currentStatus: string) => {
    if (isReadOnly) return;
    try {
      const newStatus = currentStatus === 'active' ? 'passive' : 'active';
      await api.patch(`/integrations/keys/${id}/status`, { status: newStatus });
      toast.success(`Bağlantı ${newStatus === 'active' ? 'aktif' : 'pasif'} edildi.`);
      fetchKeys();
    } catch (err) {
      toast.error('Durum değiştirilemedi.');
    }
  };

  const handleTest = async (id: string) => {
    if (isReadOnly) return;
    try {
      const result = await api.post(`/integrations/keys/${id}/test`, {});
      if (result.status === 'success') {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
      fetchKeys();
    } catch (err: any) {
      toast.error(err.message || 'Test sırasında hata oluştu.');
    }
  };

  const openForm = (k?: ApiKey) => {
    if (k) {
      setEditingKey(k);
      setFormData({
        service_name: k.service_name,
        display_name: k.display_name,
        key_name: k.key_name || '',
        api_key: '', // Do not load the real api_key, must enter again to change
        api_secret: '',
        merchant_id: k.merchant_id || '',
        seller_id: k.seller_id || '',
        notes: k.notes || ''
      });
    } else {
      setEditingKey(null);
      setFormData({
        service_name: 'Hepsiburada',
        display_name: '',
        key_name: '',
        api_key: '',
        api_secret: '',
        merchant_id: '',
        seller_id: '',
        notes: ''
      });
    }
    setShowModal(true);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <Toaster position="top-right" />
      
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-text-main flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center">
              <Key className="w-5 h-5 text-primary" />
            </div>
            <span>API Anahtarları</span>
          </h2>
          <p className="text-text-muted mt-2 text-sm max-w-xl">
            Harici uygulamaların, pazar yerlerinin veya yapay zeka entegrasyonlarının API bağlantılarını 
            buradan 256-bit şifreleme ile güvenli bir şekilde yönetin.
          </p>
        </div>
        {!isReadOnly && (
          <button
            onClick={() => openForm()}
            className="flex items-center space-x-2 bg-primary text-white px-4 py-2 rounded-xl hover:bg-primary/90 transition-colors font-bold shadow-lg shadow-primary/25"
          >
            <Plus className="w-5 h-5" />
            <span>Yeni Ekle</span>
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-border-color overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-gray-50 border-b border-border-color">
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider">Servis</th>
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider">Durum</th>
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider">Anahtar Sonu</th>
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider">Son Test</th>
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider">Tarih</th>
                <th className="py-4 px-6 text-xs font-black text-text-muted uppercase tracking-wider text-right">İşlemler</th>
              </tr>
            </thead>
            <tbody className="align-top divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-text-muted">Yükleniyor...</td>
                </tr>
              ) : keys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-text-muted">
                    <ShieldAlert className="w-10 h-10 mx-auto text-gray-300 mb-3" />
                    Henüz API anahtarı eklenmedi.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="py-4 px-6">
                      <div className="font-bold text-text-main">{k.display_name}</div>
                      <div className="text-xs text-text-muted">{k.service_name} • {k.key_name || 'Varsayılan'}</div>
                    </td>
                    <td className="py-4 px-6">
                      <button 
                        onClick={() => toggleStatus(k.id, k.status)}
                        className={`px-3 py-1 text-xs font-bold rounded-full ${k.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
                      >
                        {k.status === 'active' ? 'Aktif' : 'Pasif'}
                      </button>
                    </td>
                    <td className="py-4 px-6 font-mono text-sm text-text-muted">
                      {k.maskedKey || `****${k.last4}`}
                    </td>
                    <td className="py-4 px-6 text-sm">
                      {k.last_test_status ? (
                        <div className={`flex items-center space-x-1.5 ${k.last_test_status === 'success' ? 'text-green-600' : 'text-red-500'}`}>
                          {k.last_test_status === 'success' ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                          <span>{k.last_test_status === 'success' ? 'Başarılı' : 'Başarısız'}</span>
                        </div>
                      ) : (
                        <span className="text-gray-400">Test Edilmedi</span>
                      )}
                      {k.last_tested_at && <div className="text-[10px] text-gray-400 mt-1">{new Date(k.last_tested_at).toLocaleString('tr-TR')}</div>}
                    </td>
                    <td className="py-4 px-6 text-sm text-text-muted">
                      {new Date(k.created_at).toLocaleDateString('tr-TR')}
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end space-x-2">
                         <button 
                             title="Bağlantıyı Test Et"
                             onClick={() => handleTest(k.id)}
                             disabled={k.status !== 'active'}
                             className="p-1.5 text-blue-500 hover:bg-blue-50 rounded-lg disabled:opacity-50"
                         >
                            <Play className="w-4 h-4" />
                         </button>
                         <button 
                             title="Düzenle"
                             onClick={() => openForm(k)}
                             className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg"
                         >
                            <Edit2 className="w-4 h-4" />
                         </button>
                         <button 
                             title="Sil"
                             onClick={() => setDeleteId(k.id)}
                             className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"
                         >
                            <Trash2 className="w-4 h-4" />
                         </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white z-10">
              <h3 className="text-xl font-bold flex items-center space-x-2">
                <Key className="w-5 h-5 text-primary" />
                <span>{editingKey ? 'API Anahtarı Düzenle' : 'Yeni API Anahtarı'}</span>
              </h3>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <Trash2 className="w-5 h-5" /> {/* Just placeholder close icon */}
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Servis *</label>
                  <select
                    required
                    disabled={!!editingKey}
                    value={formData.service_name}
                    onChange={(e) => setFormData({...formData, service_name: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700 disabled:opacity-60"
                  >
                    {services.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Görünen İsim *</label>
                  <input
                    type="text"
                    required
                    placeholder="Örn: Trendyol Mağazam"
                    value={formData.display_name}
                    onChange={(e) => setFormData({...formData, display_name: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700"
                  />
                </div>
              </div>

              <div>
                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Key Adı</label>
                 <input
                    type="text"
                    placeholder="Örn: Ana Access Key"
                    value={formData.key_name}
                    onChange={(e) => setFormData({...formData, key_name: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700"
                 />
              </div>

              <div>
                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">API Key *</label>
                 <input
                    type="password"
                    required={!editingKey}
                    placeholder={editingKey ? "Değiştirmek için yeni key girin (boş bırakırsanız değişmez)" : "Anahtarınızı buraya yapıştırın"}
                    value={formData.api_key}
                    onChange={(e) => setFormData({...formData, api_key: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700 font-mono placeholder:font-sans"
                 />
              </div>

              <div>
                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">API Secret (Opsiyonel)</label>
                 <input
                    type="password"
                    placeholder={editingKey ? "Değiştirmek için yeni secret girin" : "Varsa API Secret"}
                    value={formData.api_secret}
                    onChange={(e) => setFormData({...formData, api_secret: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700 font-mono placeholder:font-sans"
                 />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Satıcı ID (Merchant ID)</label>
                  <input
                    type="text"
                    value={formData.merchant_id}
                    onChange={(e) => setFormData({...formData, merchant_id: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700"
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Mağaza ID (Seller ID)</label>
                  <input
                    type="text"
                    value={formData.seller_id}
                    onChange={(e) => setFormData({...formData, seller_id: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-bold text-gray-700"
                  />
                </div>
              </div>

              <div>
                 <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Notlar</label>
                 <textarea
                    rows={2}
                    value={formData.notes}
                    onChange={(e) => setFormData({...formData, notes: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-gray-700 resize-none"
                 />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button type="button" onClick={() => setShowModal(false)} className="px-5 py-2.5 text-gray-500 hover:bg-gray-100 rounded-xl font-bold transition-colors">
                  İptal
                </button>
                <button type="submit" className="px-5 py-2.5 bg-primary text-white hover:bg-primary/90 rounded-xl font-bold transition-colors">
                  {editingKey ? 'Güncelle' : 'Kaydet'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className="p-6 text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Anahtarı Sil</h3>
              <p className="text-gray-500 text-sm mb-6">
                Bu API anahtarı silinirse ilgili entegrasyonlar çalışmayabilir. Silmek istediğinize emin misiniz?
              </p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={handleDelete}
                  className="w-full py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold transition-colors"
                >
                  Evet, Sil
                </button>
                <button
                  onClick={() => setDeleteId(null)}
                  className="w-full py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold transition-colors"
                >
                  İptal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

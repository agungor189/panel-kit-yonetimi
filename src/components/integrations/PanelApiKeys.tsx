import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { PanelApiKey } from '../../types';
import { TerminalSquare, Plus, Trash2, Edit2, Play, CheckCircle, XCircle, AlertTriangle, ShieldAlert, Copy, RefreshCw, XOctagon } from 'lucide-react';
import { useAuth } from '../../App';
import toast, { Toaster } from 'react-hot-toast';

const AVAILABLE_PERMISSIONS = [
  'products:read', 'products:write', 'stock:read', 'stock:write',
  'orders:read', 'orders:write', 'sales:read', 'expenses:read',
  'dashboard:read', 'movements:read', 'integrations:read'
];

export default function PanelApiKeys() {
  const { isReadOnly } = useAuth();
  const [keys, setKeys] = useState<PanelApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingKey, setEditingKey] = useState<PanelApiKey | null>(null);
  
  const [formData, setFormData] = useState({
    name: '',
    environment: 'test' as 'live' | 'test',
    permissions: ['products:read', 'stock:read'] as string[],
    allowed_ips: '',
    expires_at: ''
  });

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [newGeneratedKey, setNewGeneratedKey] = useState<string | null>(null);

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      const data = await api.get('/integrations/panel-api');
      setKeys(data);
    } catch (err) {
      toast.error('Panel API anahtarları yüklenirken hata oluştu.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;

    if (!formData.name) {
      toast.error('Ad alanı zorunludur.');
      return;
    }

    try {
      if (editingKey) {
        await api.put(`/integrations/panel-api/${editingKey.id}`, formData);
        toast.success('Panel API Anahtarı güncellendi.');
        setShowModal(false);
        fetchKeys();
      } else {
        const result = await api.post('/integrations/panel-api', formData);
        setNewGeneratedKey(result.apiKey);
        toast.success('Yeni Panel API Anahtarı oluşturuldu.');
        fetchKeys();
      }
    } catch (err: any) {
      toast.error(err.message || 'Hata oluştu.');
    }
  };

  const closeNewKeyModal = () => {
    setNewGeneratedKey(null);
    setShowModal(false);
  }

  const handleDelete = async () => {
    if (!deleteId || isReadOnly) return;
    try {
      await api.delete(`/integrations/panel-api/${deleteId}`);
      toast.success('API Anahtarı silindi.');
      setDeleteId(null);
      fetchKeys();
    } catch (err) {
      toast.error('Silme sırasında hata oluştu.');
    }
  };

  const handleRevoke = async () => {
    if (!revokeId || isReadOnly) return;
    try {
      await api.post(`/integrations/panel-api/${revokeId}/revoke`, {});
      toast.success('API Anahtarı iptal edildi (revoked).');
      setRevokeId(null);
      fetchKeys();
    } catch (err) {
      toast.error('İptal sırasında hata oluştu.');
    }
  };

  const toggleStatus = async (id: string, currentStatus: string) => {
    if (isReadOnly || currentStatus === 'revoked') return;
    try {
      const newStatus = currentStatus === 'active' ? 'passive' : 'active';
      await api.patch(`/integrations/panel-api/${id}/status`, { status: newStatus });
      toast.success(`Bağlantı ${newStatus === 'active' ? 'aktif' : 'pasif'} edildi.`);
      fetchKeys();
    } catch (err) {
      toast.error('Durum değiştirilemedi.');
    }
  };

  const handleRotate = async (id: string, name: string) => {
    if (isReadOnly) return;
    if (!window.confirm(`"${name}" anahtarını yenilemek istiyor musunuz? Eski anahtar iptal edilecek ve yeni bir anahtar üretilecektir.`)) return;

    try {
      const result = await api.post(`/integrations/panel-api/${id}/rotate`, {});
      setNewGeneratedKey(result.apiKey);
      toast.success('Anahtar yenilendi.');
      fetchKeys();
    } catch (err: any) {
      toast.error(err.message || 'Rotate sırasında hata oluştu.');
    }
  };

  const handleTest = async (id: string) => {
    if (isReadOnly) return;
    try {
      const result = await api.post(`/integrations/panel-api/${id}/test`, {});
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

  const openForm = (k?: PanelApiKey) => {
    if (k) {
      setEditingKey(k);
      setFormData({
        name: k.name,
        environment: k.environment,
        permissions: JSON.parse(k.permissions || '[]'),
        allowed_ips: k.allowed_ips || '',
        expires_at: k.expires_at ? new Date(k.expires_at).toISOString().slice(0, 16) : ''
      });
    } else {
      setEditingKey(null);
      setFormData({
        name: '',
        environment: 'test',
        permissions: ['products:read', 'stock:read'],
        allowed_ips: '',
        expires_at: ''
      });
    }
    setShowModal(true);
  };

  const togglePermission = (perm: string) => {
    if (formData.permissions.includes(perm)) {
      setFormData({...formData, permissions: formData.permissions.filter(p => p !== perm)});
    } else {
      setFormData({...formData, permissions: [...formData.permissions, perm]});
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Anahtar kopyalandı.');
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <Toaster position="top-right" />
      
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black text-text-main flex items-center space-x-3">
            <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
              <TerminalSquare className="w-5 h-5 text-purple-600" />
            </div>
            <span>Panel API Yönetimi</span>
          </h2>
          <p className="text-text-muted mt-2 text-sm max-w-xl">
            Harici sistemlerin (n8n, mobil uygulama vb.) DSDST Panel verilerine güvenli bir şekilde erişebilmesi için gerekli API anahtarlarını üretin ve yönetin.
          </p>
        </div>
        {!isReadOnly && (
          <button
            onClick={() => openForm()}
            className="flex items-center space-x-2 bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700 transition-colors font-bold shadow-lg shadow-purple-600/25"
          >
            <Plus className="w-5 h-5" />
            <span>Anahtar Üret</span>
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-border-color overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[800px]">
            <thead>
              <tr className="bg-gray-50 border-b border-border-color text-xs">
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider">Ad </th>
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider">Ortam</th>
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider">Durum</th>
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider">Anahtar</th>
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider">Kullanım</th>
                <th className="py-4 px-6 font-black text-text-muted uppercase tracking-wider text-right">İşlemler</th>
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
                    <TerminalSquare className="w-10 h-10 mx-auto text-gray-300 mb-3" />
                    Henüz Panel API anahtarı oluşturulmadı.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="py-4 px-6">
                      <div className="font-bold text-text-main">{k.name}</div>
                      <div className="text-xs text-text-muted mt-1 max-w-[150px] truncate" title={JSON.parse(k.permissions || '[]').join(', ')}>
                        {JSON.parse(k.permissions || '[]').length} Yetki
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider ${k.environment === 'live' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                        {k.environment}
                      </span>
                    </td>
                    <td className="py-4 px-6">
                      <span className={`px-3 py-1 text-xs font-bold rounded-full ${k.status === 'active' ? 'bg-green-100 text-green-700' : k.status === 'passive' ? 'bg-gray-100 text-gray-600' : 'bg-red-100 text-red-700'}`}>
                        {k.status === 'active' ? 'Aktif' : k.status === 'passive' ? 'Pasif' : 'İptal Edildi'}
                      </span>
                      {k.status !== 'revoked' && (
                         <button 
                             onClick={() => toggleStatus(k.id, k.status)}
                             className="ml-2 text-[10px] underline text-gray-400 hover:text-gray-600"
                         >
                            Değiştir
                         </button>
                      )}
                    </td>
                    <td className="py-4 px-6 font-mono text-xs text-text-muted bg-gray-50 rounded-lg p-2 my-2 inline-block">
                      {k.maskedKey}
                    </td>
                    <td className="py-4 px-6 text-xs text-text-muted">
                       <div>
                         <span className="font-semibold">Son Kul.:</span> {k.last_used_at ? new Date(k.last_used_at).toLocaleString('tr-TR') : '-'}
                       </div>
                       {k.last_used_ip && (
                         <div className="mt-1"><span className="font-semibold">Son IP:</span> {k.last_used_ip}</div>
                       )}
                       {k.expires_at && (
                         <div className="mt-1 text-red-500"><span className="font-semibold">SKT:</span> {new Date(k.expires_at).toLocaleDateString('tr-TR')}</div>
                       )}
                    </td>
                    <td className="py-4 px-6 text-right">
                      <div className="flex items-center justify-end space-x-1">
                         <button 
                             title="Test Et"
                             onClick={() => handleTest(k.id)}
                             disabled={k.status === 'revoked'}
                             className="p-1.5 text-blue-500 hover:bg-blue-50 rounded-lg disabled:opacity-30"
                         >
                            <Play className="w-4 h-4" />
                         </button>
                         {k.status !== 'revoked' && (
                             <button 
                                 title="Düzenle"
                                 onClick={() => openForm(k)}
                                 className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg"
                             >
                                <Edit2 className="w-4 h-4" />
                             </button>
                         )}
                         {k.status !== 'revoked' && (
                           <button 
                               title="Yenile (Rotate)"
                               onClick={() => handleRotate(k.id, k.name)}
                               className="p-1.5 text-purple-500 hover:bg-purple-50 rounded-lg"
                           >
                              <RefreshCw className="w-4 h-4" />
                           </button>
                         )}
                         {k.status !== 'revoked' && (
                           <button 
                               title="İptal Et (Revoke)"
                               onClick={() => setRevokeId(k.id)}
                               className="p-1.5 text-orange-500 hover:bg-orange-50 rounded-lg"
                           >
                              <XOctagon className="w-4 h-4" />
                           </button>
                         )}
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

      {/* NEW KEY MODAL (Show Once) */}
      {newGeneratedKey && (
         <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in">
           <div className="bg-white rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
             <div className="p-6 text-center border-b border-gray-100">
                 <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                   <ShieldAlert className="w-8 h-8 text-green-600" />
                 </div>
                 <h3 className="text-2xl font-black text-gray-900 mb-2">Anahtar Oluşturuldu</h3>
                 <p className="text-red-500 text-sm font-bold bg-red-50 p-3 rounded-lg border border-red-100">
                    DİKKAT: Bu anahtar güvenlik nedeniyle yalnızca bir kez gösterilir! Lütfen hemen güvenli bir yere kopyalayın. Kaybederseniz yeni bir anahtar üretmeniz gerekecektir.
                 </p>
             </div>
             <div className="p-6 bg-gray-50 flex items-center justify-between">
                <code className="text-sm font-mono text-gray-800 break-all bg-white p-3 rounded-xl border border-gray-200 shadow-inner flex-1 mr-4 selection:bg-purple-200">
                   {newGeneratedKey}
                </code>
                <button 
                   onClick={() => copyToClipboard(newGeneratedKey)}
                   className="p-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition-colors shadow-lg"
                   title="Kopyala"
                >
                   <Copy className="w-5 h-5" />
                </button>
             </div>
             <div className="p-4 border-t border-gray-100 flex justify-end bg-white">
                <button 
                   onClick={closeNewKeyModal}
                   className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold rounded-xl transition-colors"
                >
                   Kopyaladım, Kapat
                </button>
             </div>
           </div>
         </div>
      )}

      {/* FORM MODAL */}
      {showModal && !newGeneratedKey && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between shrink-0">
              <h3 className="text-xl font-bold flex items-center space-x-2">
                <TerminalSquare className="w-6 h-6 text-purple-600" />
                <span>{editingKey ? 'Panel API Yetkilerini Düzenle' : 'Yeni Panel API Anahtarı'}</span>
              </h3>
              <button onClick={() => setShowModal(false)} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors">
                <Trash2 className="w-5 h-5 opacity-0" />
                <span className="sr-only">Kapat</span>
              </button>
            </div>
            
            <form onSubmit={handleSave} className="p-6 space-y-6 overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Başlık / Açıklama *</label>
                  <input
                    type="text"
                    required
                    placeholder="Örn: n8n Stok Güncelleyici"
                    value={formData.name}
                    onChange={(e) => setFormData({...formData, name: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 font-bold text-gray-800"
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Ortam *</label>
                  <select
                    required
                    disabled={!!editingKey}
                    value={formData.environment}
                    onChange={(e) => setFormData({...formData, environment: e.target.value as any})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 font-bold text-gray-800 disabled:opacity-60"
                  >
                    <option value="test">Test Ortamı (dsdst_test_...)</option>
                    <option value="live">Canlı Ortam (dsdst_live_...)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">İzinler (Permissions)</label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                   {AVAILABLE_PERMISSIONS.map(perm => {
                       const isSelected = formData.permissions.includes(perm);
                       return (
                           <label key={perm} className={`flex items-center space-x-2 p-3 rounded-xl border cursor-pointer transition-all ${isSelected ? 'border-purple-500 bg-purple-50' : 'border-border-color bg-white hover:bg-gray-50'}`}>
                               <input 
                                  type="checkbox" 
                                  checked={isSelected}
                                  onChange={() => togglePermission(perm)}
                                  className="w-4 h-4 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                               />
                               <span className={`text-xs font-mono font-medium ${isSelected ? 'text-purple-700' : 'text-gray-600'}`}>{perm}</span>
                           </label>
                       )
                   })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">İzinli IP Adresleri</label>
                  <input
                    type="text"
                    placeholder="Örn: 192.168.1.1, 10.0.0.5"
                    value={formData.allowed_ips}
                    onChange={(e) => setFormData({...formData, allowed_ips: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 font-bold text-gray-800"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Sadece belirli IP'lerden gelmesini istiyorsanız virgülle ayırarak yazın.</p>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Bitiş Tarihi (Opsiyonel)</label>
                  <input
                    type="datetime-local"
                    value={formData.expires_at}
                    onChange={(e) => setFormData({...formData, expires_at: e.target.value})}
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 font-bold text-gray-800"
                  />
                  <p className="text-[10px] text-gray-400 mt-1">Bu tarihten sonra anahtar otomatik iptal olur.</p>
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-6 border-t border-gray-100">
                <button type="button" onClick={() => setShowModal(false)} className="px-6 py-2.5 text-gray-500 hover:bg-gray-100 rounded-xl font-bold transition-colors">
                  İptal
                </button>
                <button type="submit" className="px-6 py-2.5 bg-purple-600 text-white hover:bg-purple-700 rounded-xl font-bold transition-colors shadow-lg">
                  {editingKey ? 'Yetkileri Güncelle' : 'Anahtar Oluştur'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONFIRM MODALS */}
      {revokeId && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl p-6 text-center">
            <div className="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <XOctagon className="w-8 h-8 text-orange-500" />
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Anahtarı İptal Et</h3>
            <p className="text-gray-500 text-sm mb-6">
              Bu anahtarı iptal ederseniz bir daha KESİNLİKLE kullanılamaz. Emin misiniz?
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={handleRevoke}
                className="w-full py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-xl font-bold transition-colors"
              >
                Evet, Kalıcı İptal Et
              </button>
              <button
                onClick={() => setRevokeId(null)}
                className="w-full py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold transition-colors"
              >
                Vazgeç
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl p-6 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">Anahtarı Sil</h3>
            <p className="text-gray-500 text-sm mb-6">
              Bu anahtarı silmek istiyor musunuz? Bu işlem geri alınamaz.
            </p>
            <div className="flex flex-col gap-3">
              <button
                onClick={handleDelete}
                className="w-full py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold transition-colors"
              >
                Sil
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
      )}

    </div>
  );
}

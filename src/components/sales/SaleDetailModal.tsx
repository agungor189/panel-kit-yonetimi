import React, { useEffect, useMemo, useState } from 'react';
import { X, Save, Edit3, MapPin, Truck, Hash, User, Package, CheckCircle, AlertCircle, RotateCcw } from 'lucide-react';
import { useCurrency } from '../../CurrencyContext';
import { api } from '../../lib/api';
import { useAuth } from '../../App';

type SaleDetailFormData = {
  customer_name: string;
  customer_phone: string;
  customer_address: string;
  shipping_company: string;
  tracking_number: string;
  status: string;
};

const buildFormData = (sale: any): SaleDetailFormData => ({
  customer_name: sale?.customer_name || '',
  customer_phone: sale?.customer_phone || '',
  customer_address: sale?.customer_address || '',
  shipping_company: sale?.shipping_company || '',
  tracking_number: sale?.tracking_number || '',
  status: sale?.status || 'Hazırlanıyor'
});

const finalStatuses = ['İptal Edildi', 'İade Edildi'];
const statusOptions = ['Hazırlanıyor', 'Gönderildi', 'Tamamlandı', 'İptal Edildi', 'İade Edildi'];

const getSaleStatusClass = (status?: string) => {
  switch (status) {
    case 'Hazırlanıyor':
      return 'border-amber-200 bg-amber-100 text-amber-700';
    case 'Gönderildi':
      return 'border-blue-200 bg-blue-100 text-blue-700';
    case 'Tamamlandı':
      return 'border-emerald-200 bg-emerald-100 text-emerald-700';
    case 'İptal Edildi':
      return 'border-slate-300 bg-slate-200 text-slate-700';
    case 'İade Edildi':
      return 'border-red-200 bg-red-100 text-red-700';
    default:
      return 'border-gray-200 bg-gray-100 text-gray-700';
  }
};

export default function SaleDetailModal({ sale, onClose, onUpdated }: { sale: any, onClose: () => void, onUpdated?: (sale: any) => void }) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentSale, setCurrentSale] = useState(sale);
  const [formData, setFormData] = useState<SaleDetailFormData>(() => buildFormData(sale));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCurrentSale(sale);
    setFormData(buildFormData(sale));
    setError('');
    setSaved(false);
    setIsEditing(false);
  }, [sale]);

  const isFinalStatus = finalStatuses.includes(currentSale?.status);

  const hasChanges = useMemo(() => {
    const base = buildFormData(currentSale);
    return Object.keys(base).some((key) => base[key as keyof SaleDetailFormData] !== formData[key as keyof SaleDetailFormData]);
  }, [currentSale, formData]);

  const netProfitIsNegative = finalStatuses.includes(currentSale?.status) || Number(currentSale?.net_profit || 0) < 0;

  const updateForm = (field: keyof SaleDetailFormData, value: string) => {
    setSaved(false);
    setError('');
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const resetForm = () => {
    setFormData(buildFormData(currentSale));
    setError('');
    setSaved(false);
  };

  const handleSave = async () => {
    if (isReadOnly || saving) return;
    if (!formData.customer_name.trim()) {
      setError('Müşteri adı boş bırakılamaz.');
      return;
    }
    if (isFinalStatus && formData.status !== currentSale.status) {
      setError(`Durumu '${currentSale.status}' olan satış farklı bir duruma alınamaz.`);
      return;
    }

    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await api.put(`/sales/${currentSale.id}`, {
        ...formData,
        customer_name: formData.customer_name.trim(),
        customer_phone: formData.customer_phone.trim(),
        customer_address: formData.customer_address.trim(),
        shipping_company: formData.shipping_company.trim(),
        tracking_number: formData.tracking_number.trim(),
      });
      const updatedSale = res.sale || { ...currentSale, ...formData };
      setCurrentSale(updatedSale);
      setFormData(buildFormData(updatedSale));
      setIsEditing(false);
      setSaved(true);
      onUpdated?.(updatedSale);
    } catch (err: any) {
      setError(err.message || 'Satış güncellenirken hata oluştu.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm animate-in fade-in">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto border border-border-color">
        <div className="sticky top-0 bg-white/90 backdrop-blur-md px-6 py-4 flex items-center justify-between border-b border-border-color z-10">
          <div>
            <h2 className="text-xl font-black text-text-main flex items-center gap-3">
              <span>Sipariş Detayı</span>
              <span className="text-sm px-3 py-1 bg-gray-100 text-gray-600 rounded-lg">{currentSale.id.slice(0, 8).toUpperCase()}</span>
            </h2>
          </div>
          <div className="flex items-center gap-3">
             {!isReadOnly && (!isEditing ? (
               <button onClick={() => { setError(''); setSaved(false); setIsEditing(true); }} className="flex items-center gap-2 px-4 py-2 bg-gray-100/80 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition-colors">
                 <Edit3 className="w-4 h-4" /> Düzenle
               </button>
             ) : (
               <button disabled={saving || !hasChanges} onClick={handleSave} className="flex items-center gap-2 px-4 py-2 bg-primary text-white font-bold rounded-xl hover:bg-primary-hover transition-colors disabled:cursor-not-allowed disabled:opacity-50">
                 {saving ? 'Kaydediliyor...' : <><Save className="w-4 h-4" /> Kaydet</>}
               </button>
             ))}
            <button onClick={onClose} className="p-2 hover:bg-gray-100 text-gray-400 hover:text-gray-600 rounded-xl transition-colors">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-8">
          {(error || saved) && (
            <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold ${error ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{error || 'Satış bilgileri güncellendi.'}</span>
            </div>
          )}

          {/* Main Info Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Customer Info */}
            <div className="p-6 bg-gray-50/50 rounded-2xl border border-gray-100">
               <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                 <User className="w-4 h-4" /> Müşteri Bilgileri
               </h3>
               {isEditing ? (
                 <div className="space-y-4">
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">İsim / Ünvan</label>
                     <input type="text" value={formData.customer_name} onChange={e => updateForm('customer_name', e.target.value)} className="w-full mt-1 px-3 py-2 border rounded-xl" />
                   </div>
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">Telefon</label>
                     <input type="text" value={formData.customer_phone} onChange={e => updateForm('customer_phone', e.target.value)} className="w-full mt-1 px-3 py-2 border rounded-xl" />
                   </div>
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">Adres</label>
                     <textarea rows={3} value={formData.customer_address} onChange={e => updateForm('customer_address', e.target.value)} className="w-full mt-1 px-3 py-2 border rounded-xl" />
                   </div>
                 </div>
               ) : (
                 <div className="space-y-4">
                   <div className="flex gap-3">
                      <div className="w-10 h-10 bg-white rounded-xl shadow-sm flex items-center justify-center shrink-0">
                        <User className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <div className="font-bold text-gray-800">{currentSale.customer_name}</div>
                        <div className="text-sm text-gray-500 mt-0.5">{currentSale.customer_phone || '-'}</div>
                      </div>
                   </div>
                   <div className="flex gap-3 mt-4 pt-4 border-t border-gray-200/60">
                      <div className="shrink-0 pt-1">
                        <MapPin className="w-4 h-4 text-gray-400" />
                      </div>
                      <div className="text-sm text-gray-600 leading-relaxed break-words whitespace-pre-wrap">
                        {currentSale.customer_address || 'Adres bilgisi girilmemiş.'}
                      </div>
                   </div>
                 </div>
               )}
            </div>

            {/* Shipping Info */}
            <div className="p-6 bg-blue-50/30 rounded-2xl border border-blue-100/50">
               <h3 className="text-xs font-bold text-blue-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                 <Truck className="w-4 h-4 outline-blue-500" /> Kargo Durumu
               </h3>
               {isEditing ? (
                 <div className="space-y-4">
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">Durum</label>
                     <select
                       value={formData.status}
                       onChange={e => updateForm('status', e.target.value)}
                       disabled={isFinalStatus}
                       className={`w-full mt-1 px-3 py-2 rounded-xl border font-bold transition-colors disabled:bg-gray-100 disabled:text-gray-500 ${getSaleStatusClass(formData.status)}`}
                     >
                       {statusOptions.map(o => <option key={o} value={o}>{o}</option>)}
                     </select>
                     {isFinalStatus && (
                       <p className="mt-1 text-[11px] font-semibold text-gray-500">
                         İptal/iade edilmiş satışların durumu geri alınamaz; diğer bilgiler düzenlenebilir.
                       </p>
                     )}
                   </div>
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">Kargo Firması</label>
                     <input type="text" value={formData.shipping_company} onChange={e => updateForm('shipping_company', e.target.value)} className="w-full mt-1 px-3 py-2 border rounded-xl" />
                   </div>
                   <div>
                     <label className="block text-[10px] font-bold text-gray-500 uppercase">Takip Numarası</label>
                     <input type="text" value={formData.tracking_number} onChange={e => updateForm('tracking_number', e.target.value)} className="w-full mt-1 px-3 py-2 border rounded-xl font-mono text-sm" />
                   </div>
                   <button
                     type="button"
                     onClick={resetForm}
                     disabled={!hasChanges || saving}
                     className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                   >
                     <RotateCcw className="h-3.5 w-3.5" />
                     Değişiklikleri Geri Al
                   </button>
                 </div>
               ) : (
                 <div className="space-y-5">
                   <div className="flex items-center gap-3">
                     <span className={`rounded-xl border px-4 py-1.5 text-sm font-black tracking-wide ${getSaleStatusClass(currentSale.status)}`}>
                        {currentSale.status}
                     </span>
                   </div>
                   <div className="flex bg-white rounded-xl shadow-sm border border-gray-100 p-4 gap-4 items-center">
                      <div className="w-10 h-10 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center shrink-0">
                        <Truck className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-[10px] font-bold text-gray-400 uppercase">Firma</div>
                        <div className="font-bold text-gray-800">{currentSale.shipping_company || '-'}</div>
                      </div>
                   </div>
                   <div className="flex bg-white rounded-xl shadow-sm border border-gray-100 p-4 gap-4 items-center">
                      <div className="w-10 h-10 bg-blue-50 text-blue-500 rounded-lg flex items-center justify-center shrink-0">
                        <Hash className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-[10px] font-bold text-gray-400 uppercase">Takip Kodu</div>
                        <div className="font-mono font-bold text-gray-800 mt-1">{currentSale.tracking_number || '-'}</div>
                      </div>
                   </div>
                 </div>
               )}
            </div>
          </div>

          {/* Items / Cart Info */}
          <div>
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Package className="w-4 h-4" /> Sipariş İçeriği
            </h3>
            
            <div className="bg-white border text-sm border-gray-200 rounded-2xl overflow-hidden">
               <table className="w-full text-left">
                  <thead className="bg-gray-50 text-[10px] text-gray-500 font-bold uppercase tracking-widest border-b border-gray-200">
                     <tr>
                        <th className="px-6 py-4">Ürün</th>
                        <th className="px-6 py-4 text-center">Miktar</th>
                        <th className="px-6 py-4 text-right">Birim Fiyat</th>
                        <th className="px-6 py-4 text-right">Toplam</th>
                     </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                     {currentSale.items && currentSale.items.map((item: any) => (
                       <tr key={item.id}>
                          <td className="px-6 py-4 font-bold text-gray-800">{item.product_name}</td>
                          <td className="px-6 py-4 text-center font-bold text-gray-600">{item.quantity}</td>
                          <td className="px-6 py-4 text-right font-medium"><FormatAmount amount={item.price || item.unit_price} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} /></td>
                          <td className="px-6 py-4 text-right font-bold text-primary">
                             <FormatAmount amount={(item.price || item.unit_price) * item.quantity} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} />
                          </td>
                       </tr>
                     ))}
                  </tbody>
               </table>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 p-6 bg-gray-50 border border-gray-200 rounded-2xl">
             <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Alt Toplam</div>
                <div className="mt-1 font-bold text-gray-800"><FormatAmount amount={currentSale.total_amount} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} /></div>
             </div>
             <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">İndirim</div>
                <div className="mt-1 font-bold text-red-500">- <FormatAmount amount={currentSale.discount || 0} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} /></div>
             </div>
             <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Toplam Ağırlık</div>
                <div className="mt-1 font-bold text-orange-500">{currentSale.total_weight ? `${currentSale.total_weight.toFixed(2)} kg` : '-'}</div>
             </div>
             <div>
                <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Kargo / Gider</div>
                <div className="mt-1 font-bold text-orange-500">- <FormatAmount amount={(currentSale.shipping_cost || 0) + (currentSale.packaging_cost || 0) + (currentSale.other_expenses || 0) + (currentSale.ad_spend || 0)} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} /></div>
             </div>
             <div>
                <div className={`text-[10px] font-bold uppercase tracking-wider ${netProfitIsNegative ? 'text-red-500' : 'text-emerald-600'}`}>Net Kâr</div>
                <div className={`mt-1 text-lg font-black ${netProfitIsNegative ? 'text-red-600' : 'text-emerald-600'}`}>
                  <FormatAmount amount={currentSale.net_profit || 0} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} />
                </div>
             </div>
             <div>
                <div className="text-[10px] font-bold text-primary uppercase tracking-wider">Net Toplam</div>
                <div className="mt-1 text-xl font-black text-primary"><FormatAmount amount={currentSale.net_total || 0} exchangeRateAtTransaction={currentSale.exchange_rate_at_transaction} /></div>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}

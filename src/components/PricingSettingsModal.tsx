import React, { useState, useEffect } from 'react';
import { X, Check, Calculator, AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';

export default function PricingSettingsModal({ 
  onClose, 
  onRefresh, 
  products 
}: { 
  onClose: () => void, 
  onRefresh: () => void,
  products: any[] 
}) {
  const { FormatAmount, activeRate } = useCurrency();
  const [exchangeRate, setExchangeRate] = useState<number>(activeRate || 0);
  const [bufferPercentage, setBufferPercentage] = useState<number>(20);
  const [profitPercentage, setProfitPercentage] = useState<number>(50);
  const [includeLocked, setIncludeLocked] = useState<boolean>(false);

  useEffect(() => {
    if (activeRate > 0 && exchangeRate === 0) {
      setExchangeRate(activeRate);
    }
  }, [activeRate]);

  const [previewData, setPreviewData] = useState<any[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState<{ updates: any[], missingOnly: boolean } | null>(null);

  // Initial calculation logic
  const calculatePricing = (product: any) => {
    let purchaseUSD = parseFloat(product.purchase_price_usd);
    let purchaseTRY = 0;
    const rate = exchangeRate || 0;

    if (!isNaN(purchaseUSD) && purchaseUSD > 0) {
       purchaseTRY = purchaseUSD * rate;
    } else if (parseFloat(product.purchase_cost) > 0) {
       purchaseTRY = parseFloat(product.purchase_cost);
    }

    if (purchaseTRY === 0 && parseFloat(product.sale_price) > 0) {
       return parseFloat(product.sale_price); // Fallback to existing logic if cost is unknown
    }

    const buffer = bufferPercentage || 0;
    const profit = profitPercentage || 0;
    const bufferedCostTRY = purchaseTRY * (1 + buffer / 100);
    const calculatedSalePriceTRY = bufferedCostTRY * (1 + profit / 100);
    return Math.ceil(calculatedSalePriceTRY);
  };

  const handlePreview = () => {
    let hasFailures = false;
    const data = products.map(p => {
      if (p.price_locked && !includeLocked) {
        return { ...p, newSalePrice: p.sale_price, willUpdate: false };
      }
      const newPrice = calculatePricing(p);
      if (newPrice === 0 && (!p.price_locked)) {
         hasFailures = true;
      }
      return { ...p, newSalePrice: newPrice, willUpdate: true };
    });
    setPreviewData(data);
    setShowPreview(true);
    if (hasFailures) {
       setErrorMessage("Bazı ürünlerin alış fiyatı bilinmediği veya 0 olduğu için fiyat hesaplanamadı. Eksik verili ürünleri Bakım menüsünden onarabilirsiniz.");
    } else {
       setErrorMessage("");
    }
  };

  const executeUpdate = (onlyMissing: boolean = false) => {
    setErrorMessage("");
    const dataToUpdate = products.filter(p => {
      if (p.price_locked && !includeLocked) return false;
      if (onlyMissing && p.sale_price > 0) return false;
      return true;
    }).map(p => {
      return { id: p.id, newSalePrice: calculatePricing(p) };
    });

    if (dataToUpdate.length === 0) {
      setErrorMessage("Güncellenecek ürün bulunamadı.");
      return;
    }

    setConfirmUpdate({ updates: dataToUpdate, missingOnly: onlyMissing });
  };

  const proceedUpdate = async () => {
    if (!confirmUpdate) return;
    
    setSaving(true);
    try {
      await api.post('/products/bulk-pricing', {
        updates: confirmUpdate.updates,
        settings: {
          exchangeRate,
          bufferPercentage,
          profitPercentage
        }
      });
      onRefresh();
      onClose();
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || "Fiyatlar güncellenirken hata oluştu.");
      setConfirmUpdate(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
          <div className="flex items-center gap-3">
            <div className="bg-blue-100 p-2 rounded-xl">
              <Calculator className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Toplu Fiyat Yönetimi</h2>
              <p className="text-xs text-gray-500">Merkezi fiyatlandırma (Kur + Buffer + Kâr)</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Güncel Kur (USD → TRY)</label>
              <div className="relative">
                <div className="absolute left-4 top-2.5 text-gray-500 font-bold">₺</div>
                <input 
                  type="number" 
                  step="0.01"
                  min="0.01"
                  value={exchangeRate}
                  onChange={e => setExchangeRate(parseFloat(e.target.value) || 0)}
                  className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-bold"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Buffer Marjı (%)</label>
              <div className="relative">
                <div className="absolute right-4 top-2.5 text-gray-500 font-bold">%</div>
                <input 
                  type="number" 
                  min="0"
                  value={bufferPercentage}
                  onChange={e => setBufferPercentage(parseFloat(e.target.value) || 0)}
                  className="w-full px-4 pr-10 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-bold text-orange-600"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Kâr Yüzdesi (%)</label>
              <div className="relative">
                <div className="absolute right-4 top-2.5 text-gray-500 font-bold">%</div>
                <input 
                  type="number" 
                  min="0"
                  value={profitPercentage}
                  onChange={e => setProfitPercentage(parseFloat(e.target.value) || 0)}
                  className="w-full px-4 pr-10 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-bold text-green-600"
                />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 bg-yellow-50 p-4 rounded-xl border border-yellow-200">
            <input 
              type="checkbox" 
              id="includeLocked"
              checked={includeLocked}
              onChange={e => setIncludeLocked(e.target.checked)}
              className="w-5 h-5 text-yellow-600 rounded"
            />
            <label htmlFor="includeLocked" className="text-sm font-semibold text-yellow-800">
              Kilitli fiyatları da güncelle (Manuel ayarlananlar değişecektir)
            </label>
          </div>

          <div className="flex flex-wrap gap-3">
            <button 
              onClick={handlePreview}
              className="px-6 py-2 bg-gray-100 font-bold text-gray-700 rounded-xl hover:bg-gray-200 transition-colors"
            >
              Önizleme Yap
            </button>
            <div className="flex-1"></div>
            <button 
              onClick={() => executeUpdate(true)}
              disabled={saving || !!confirmUpdate}
              className="px-6 py-2 bg-blue-50 font-bold text-blue-600 rounded-xl border border-blue-200 hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              Sadece Satış Fiyatı Boş Olanları Güncelle
            </button>
            <button 
              onClick={() => executeUpdate(false)}
              disabled={saving || !!confirmUpdate}
              className="px-6 py-2 bg-blue-600 font-bold text-white rounded-xl hover:bg-blue-700 transition-colors flex items-center shadow-lg disabled:opacity-50"
            >
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : null}
              Tüm Fiyatları Güncelle
            </button>
          </div>

          {errorMessage && (
            <div className="p-4 bg-red-50 text-red-700 border border-red-200 rounded-xl font-medium flex items-center gap-2 animate-in fade-in">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              {errorMessage}
            </div>
          )}

          {confirmUpdate && (
            <div className="p-5 bg-blue-50 border border-blue-200 rounded-xl animate-in slide-in-from-top-2">
              <h3 className="font-bold text-blue-900 mb-2">Onay Gerekiyor</h3>
              <p className="text-blue-800 mb-4">
                Toplam <strong>{confirmUpdate.updates.length}</strong> ürünün fiyatı güncellenecek.
                Bu işlem geri alınamaz. Onaylıyor musunuz?
              </p>
              <div className="flex gap-3">
                <button 
                  onClick={proceedUpdate}
                  disabled={saving}
                  className="px-5 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center shadow"
                >
                  {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Check className="w-4 h-4 mr-2" />}
                  Evet, Güncelle
                </button>
                <button 
                  onClick={() => setConfirmUpdate(null)}
                  disabled={saving}
                  className="px-5 py-2 bg-white text-gray-700 border border-gray-300 font-bold rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Vazgeç
                </button>
              </div>
            </div>
          )}

          {showPreview && (
            <div className="mt-8">
              <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                Önizleme Tablosu
              </h3>
              <div className="border border-gray-200 rounded-xl overflow-x-auto">
                <table className="w-full text-left text-sm min-w-[800px]">
                  <thead className="bg-gray-100 text-gray-600 font-semibold">
                    <tr>
                      <th className="px-4 py-3">Ürün</th>
                      <th className="px-4 py-3">Alış (USD)</th>
                      <th className="px-4 py-3">Eski Satış (TRY)</th>
                      <th className="px-4 py-3">Yeni Satış (TRY)</th>
                      <th className="px-4 py-3">Fark</th>
                      <th className="px-4 py-3 text-center">Durum</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {previewData.slice(0, 50).map(p => {
                      const diff = p.newSalePrice - (p.sale_price || 0);
                      return (
                        <tr key={p.id} className={p.willUpdate ? 'bg-white' : 'bg-gray-50 opacity-60'}>
                          <td className="px-4 py-3 font-medium">{p.name || p.title}</td>
                          <td className="px-4 py-3">${(p.purchase_price_usd || 0).toFixed(2)}</td>
                          <td className="px-4 py-3"><FormatAmount amount={p.sale_price || 0} /></td>
                          <td className="px-4 py-3 font-bold text-blue-600"><FormatAmount amount={p.newSalePrice} /></td>
                          <td className="px-4 py-3">
                            {diff !== 0 ? (
                              <span className={diff > 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                                {diff > 0 ? '+' : ''}<FormatAmount amount={diff} />
                              </span>
                            ) : '-'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {!p.willUpdate && <span className="text-xs bg-gray-200 text-gray-600 px-2 py-1 rounded-md font-bold">Kilitli / Atlandı</span>}
                            {p.willUpdate && <span className="text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded-md font-bold">Güncellenecek</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {previewData.length > 50 && (
                  <div className="p-4 text-center text-sm text-gray-500 bg-gray-50 border-t border-gray-100">
                    Sadece ilk 50 ürün gösteriliyor... (Toplam {previewData.length} ürün)
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

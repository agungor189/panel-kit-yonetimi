import React, { useState } from 'react';
import { X, Check, Calculator, AlertTriangle, RefreshCw } from 'lucide-react';
import { api, createRetryOperation } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { buildFinalLandedPricingPreview, paginateFinalLandedPricingPreview } from '../../shared/finalLandedPricing';

const skipReasonLabels: Record<string, string> = {
  MISSING_LANDED_COST: 'FINAL Landed Cost eksik',
  LOCKED: 'Fiyat kilitli',
  KIT: 'Kit yayın akışı gerekli',
  NON_POSITIVE_PRICE: 'Pozitif fiyat üretilemedi',
};

export default function PricingSettingsModal({ 
  onClose, 
  onRefresh, 
  products 
}: { 
  onClose: () => void, 
  onRefresh: () => void,
  products: any[] 
}) {
  const { FormatAmount } = useCurrency();
  const [pricingOperation] = useState(() => createRetryOperation('bulk-pricing'));
  const [bufferPercentage, setBufferPercentage] = useState<number>(20);
  const [profitPercentage, setProfitPercentage] = useState<number>(50);
  const [fixedTry, setFixedTry] = useState<number>(0);
  const [roundingIncrement, setRoundingIncrement] = useState<1 | 5 | 10>(1);

  const [previewData, setPreviewData] = useState<any[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState<{ updates: any[], missingOnly: boolean } | null>(null);

  const invalidatePreview = () => {
    setShowPreview(false);
    setPreviewData([]);
    setConfirmUpdate(null);
    setPreviewPage(1);
  };

  const handlePreview = () => {
    const data = buildFinalLandedPricingPreview(products, {
      bufferPercentage,
      profitPercentage,
      fixedTry,
      roundingIncrement,
    });
    const hasFailures = data.some((product) => !product.willUpdate);
    setPreviewData(data);
    setShowPreview(true);
    setPreviewPage(1);
    if (hasFailures) {
       setErrorMessage("Atlanan ürünler nedenleriyle önizleme tablosunda gösteriliyor.");
    } else {
       setErrorMessage("");
    }
  };

  const executeUpdate = (onlyMissing: boolean = false) => {
    setErrorMessage("");
    if (!showPreview) {
      setErrorMessage("Önce fiyat önizlemesini oluşturun.");
      return;
    }
    const dataToUpdate = previewData.filter(p => {
      if (!p.willUpdate) return false;
      if (onlyMissing && p.sale_price > 0) return false;
      return true;
    }).map(p => {
      return {
        id: p.id,
        approvedSalePrice: p.newSalePrice,
        expectedLandedCostSnapshotId: p.landed_cost_snapshot_id,
        expectedLandedCostNumerator: p.landed_cost_numerator,
        expectedLandedCostDenominator: p.landed_cost_denominator,
        expectedSalePrice: Number(p.sale_price || 0),
        expectedPriceLocked: Boolean(p.price_locked),
      };
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
      const payload = {
        updates: confirmUpdate.updates,
        settings: {
          bufferPercentage,
          profitPercentage,
          fixedTry,
          roundingIncrement,
        }
      };
      const operationId = pricingOperation.idFor(payload);
      await api.post('/products/bulk-pricing', payload, { operationId });
      pricingOperation.complete(operationId);
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
              <p className="text-xs text-gray-500">Filtre kapsamı: {products.length} ürün · FINAL Landed Cost + Buffer + Kâr</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Buffer Marjı (%)</label>
              <div className="relative">
                <div className="absolute right-4 top-2.5 text-gray-500 font-bold">%</div>
                <input 
                  type="number" 
                  min="0"
                  value={bufferPercentage}
                  onChange={e => { setBufferPercentage(parseFloat(e.target.value) || 0); invalidatePreview(); }}
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
                  onChange={e => { setProfitPercentage(parseFloat(e.target.value) || 0); invalidatePreview(); }}
                  className="w-full px-4 pr-10 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all font-bold text-green-600"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Sabit Tutar (TRY)</label>
              <input type="number" min="0" step="0.01" value={fixedTry}
                onChange={e => { setFixedTry(parseFloat(e.target.value) || 0); invalidatePreview(); }}
                className="w-full px-4 py-2 border border-gray-300 rounded-xl font-bold" />
            </div>
            <div>
              <label className="block text-sm font-bold text-gray-700 mb-2">Yukarı Yuvarlama</label>
              <select value={roundingIncrement}
                onChange={e => { setRoundingIncrement(Number(e.target.value) as 1 | 5 | 10); invalidatePreview(); }}
                className="w-full px-4 py-2 border border-gray-300 rounded-xl font-bold">
                <option value={1}>1 TL</option><option value={5}>5 TL</option><option value={10}>10 TL</option>
              </select>
            </div>
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
              disabled={saving || !!confirmUpdate || !showPreview}
              className="px-6 py-2 bg-blue-50 font-bold text-blue-600 rounded-xl border border-blue-200 hover:bg-blue-100 transition-colors disabled:opacity-50"
            >
              Sadece Satış Fiyatı Boş Olanları Güncelle
            </button>
            <button 
              onClick={() => executeUpdate(false)}
              disabled={saving || !!confirmUpdate || !showPreview}
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
                      <th className="px-4 py-3">FINAL Landed Cost</th>
                      <th className="px-4 py-3">Eski Satış (TRY)</th>
                      <th className="px-4 py-3">Yeni Satış (TRY)</th>
                      <th className="px-4 py-3">Fark</th>
                      <th className="px-4 py-3 text-center">Durum</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {paginateFinalLandedPricingPreview(previewData, previewPage).rows.map(p => {
                      const diff = p.newSalePrice === null ? null : p.newSalePrice - (p.sale_price || 0);
                      return (
                        <tr key={p.id} className={p.willUpdate ? 'bg-white' : 'bg-gray-50 opacity-60'}>
                          <td className="px-4 py-3 font-medium">{p.name || p.title}</td>
                          <td className="px-4 py-3">{p.landed_cost_try == null ? <span className="font-bold text-amber-700">Landed Cost bekleniyor</span> : <FormatAmount amount={p.landed_cost_try} />}</td>
                          <td className="px-4 py-3"><FormatAmount amount={p.sale_price || 0} /></td>
                          <td className="px-4 py-3 font-bold text-blue-600">{p.newSalePrice === null ? '—' : <FormatAmount amount={p.newSalePrice} />}</td>
                          <td className="px-4 py-3">
                            {diff !== null && diff !== 0 ? (
                              <span className={diff > 0 ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                                {diff > 0 ? '+' : ''}<FormatAmount amount={diff} />
                              </span>
                            ) : '-'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {!p.willUpdate && <span className="text-xs bg-gray-200 text-gray-600 px-2 py-1 rounded-md font-bold">{skipReasonLabels[p.skipReason as string] || 'Fiyatlandırmaya dahil edilmedi'}</span>}
                            {p.willUpdate && <span className="text-xs bg-blue-100 text-blue-600 px-2 py-1 rounded-md font-bold">Güncellenecek</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {previewData.length > 50 && (
                  <div className="p-4 flex items-center justify-between gap-3 text-sm text-gray-600 bg-gray-50 border-t border-gray-100">
                    <button type="button" disabled={previewPage === 1} onClick={() => setPreviewPage(page => Math.max(1, page - 1))}
                      className="px-3 py-1.5 rounded-lg border bg-white font-bold disabled:opacity-40">Önceki</button>
                    <span>Sayfa {previewPage} / {Math.ceil(previewData.length / 50)} · Toplam {previewData.length} ürün</span>
                    <button type="button" disabled={previewPage >= Math.ceil(previewData.length / 50)} onClick={() => setPreviewPage(page => Math.min(Math.ceil(previewData.length / 50), page + 1))}
                      className="px-3 py-1.5 rounded-lg border bg-white font-bold disabled:opacity-40">Sonraki</button>
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

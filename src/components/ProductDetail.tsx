import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Edit3,
  Trash2,
  Package,
  TrendingUp,
  TrendingDown,
  Plus,
  Minus,
  MessageSquare,
  Copy,
  ExternalLink,
  History,
  Info,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { api, PLATFORMS } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { Product, ProductPlatform } from '../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '../App';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const productKindStyles: Record<string, string> = {
  assembly: "bg-blue-50 text-blue-700 border-blue-100",
  component: "bg-amber-50 text-amber-700 border-amber-100",
  accessory: "bg-violet-50 text-violet-700 border-violet-100",
  normal: "bg-slate-50 text-slate-600 border-slate-200",
};

function getProductKind(product: Product) {
  if (product.stock_source === 'bom' || product.product_type === 'assembly') return { key: 'assembly', label: 'Assembly' };
  if (product.product_type === 'component') return { key: 'component', label: 'Component' };
  if (product.product_type === 'accessory') return { key: 'accessory', label: 'Accessory' };
  return { key: 'normal', label: 'Normal ürün' };
}

function ProductKindBadge({ product }: { product: Product }) {
  const kind = getProductKind(product);
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest",
      productKindStyles[kind.key] || productKindStyles.normal
    )}>
      {kind.label}
    </span>
  );
}

function getBottleneckComponent(product: Product) {
  return product.bom_components?.reduce((min, component) => {
    const current = Number(component.available_for_parent ?? 0);
    const minValue = Number(min?.available_for_parent ?? Number.POSITIVE_INFINITY);
    return current < minValue ? component : min;
  }, product.bom_components?.[0]);
}

function detailFromReason(reason: string | undefined, label: string) {
  const match = String(reason || '').match(new RegExp(`${label}:\\s*([^|]+)`));
  return match?.[1]?.trim() || '';
}

interface ProductDetailProps {
  productId: string;
  onBack: () => void;
  onEdit: () => void;
}

export default function ProductDetail({ productId, onBack, onEdit }: ProductDetailProps) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [product, setProduct] = useState<Product | null>(null);
  const [activeImage, setActiveImage] = useState<string | null>(null);
  const [stockLogs, setStockLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    loadData();
  }, [productId]);

  const loadData = async () => {
    try {
      setLoading(true);
      const data = await api.get(`/products/${productId}`);
      const logs = await api.get(`/stock/movements/${productId}`);
      setProduct(data);
      setStockLogs(logs);
      if (data.images?.length > 0) setActiveImage(data.images[0].path);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const adjustStock = async (platform: string, delta: number) => {
    if (isReadOnly) return;
    try {
       await api.post('/stock/adjust', {
         product_id: productId,
         platform_name: platform,
         change_amount: delta,
         reason: delta > 0 ? "Manuel giriş" : "Manuel çıkış"
       });
       loadData();
    } catch (err) {
       console.error("Stok güncellenemedi", err);
    }
  };

  const deleteProduct = async () => {
    if (isReadOnly) return;
    try {
      setLoading(true);
      await api.delete(`/products/${productId}`);
      onBack();
    } catch (err) {
      console.error("Silme işlemi başarısız.", err);
      setLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  if (loading || !product) return (
    <div className="flex flex-col items-center justify-center py-24 space-y-4">
      <div className="w-12 h-12 border-4 border-[#0F172A]/10 border-t-[#0F172A] rounded-full animate-spin"></div>
      <p className="text-sm font-bold text-[#64748B]">Yükleniyor...</p>
    </div>
  );

  const bufferedCostTRY = product.purchase_cost * (1 + (product.buffer_percentage || 0) / 100);
  const profit = product.sale_price - bufferedCostTRY;
  const centralStock = product.total_stock ?? product.central_stock ?? 0;
  const seriesLabel = product.product_series?.trim();
  const bottleneckComponent = getBottleneckComponent(product);

  return (
    <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-500">
      {/* Top Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
         <button
           onClick={onBack}
           className="flex items-center text-[#64748B] hover:text-[#0F172A] transition-colors p-2 -ml-2 rounded-lg hover:bg-[#F1F5F9] w-fit"
         >
           <ArrowLeft className="w-5 h-5 mr-2" />
           <span className="font-bold text-sm">Listeye Dön</span>
         </button>
         <div className="flex items-center space-x-3 w-full sm:w-auto">
             {!isReadOnly && (
               <button
                 onClick={onEdit}
                 className="flex-1 sm:flex-none flex items-center justify-center px-4 py-2.5 bg-[#0F172A] text-white rounded-xl font-bold text-sm hover:scale-105 transition-all shadow-md"
               >
                 <Edit3 className="w-4 h-4 mr-2" />
                 Düzenle
               </button>
             )}

             {!isReadOnly && (!showDeleteConfirm ? (
               <button
                 onClick={() => setShowDeleteConfirm(true)}
                 className="p-2.5 border border-[#E2E8F0] text-rose-500 rounded-xl hover:bg-rose-50 transition-colors"
                 title="Ürünü Sil"
               >
                 <Trash2 className="w-4 h-4" />
               </button>
             ) : (
               <div className="flex items-center space-x-2 animate-in fade-in zoom-in duration-200">
                 <span className="text-[10px] font-bold text-rose-500 uppercase tracking-tight hidden sm:block">Silinsin mi?</span>
                 <button
                   onClick={deleteProduct}
                   className="px-3 py-2 bg-rose-500 text-white rounded-lg font-bold text-xs hover:bg-rose-600 transition-colors shadow-sm"
                 >
                   Evet, Sil
                 </button>
                 <button
                   onClick={() => setShowDeleteConfirm(false)}
                   className="px-3 py-2 bg-bg-main border border-border-color text-text-muted rounded-lg font-bold text-xs hover:bg-white transition-colors"
                 >
                   Vazgeç
                 </button>
               </div>
             ))}
         </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Gallery */}
        <div className="lg:col-span-1 space-y-4">
           <div className="aspect-square bg-white border border-border-color rounded-2xl overflow-hidden shadow-sm relative p-8">
              {activeImage ? (
                <img src={activeImage} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-bg-main">
                   <Package className="w-16 h-16 text-border-color" />
                </div>
              )}
              <div className="absolute top-4 right-4">
                 <span className={cn(
                   "px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-tight border shadow-sm",
                   product.status === 'Active' ? 'bg-success text-white border-success' : 'bg-text-muted text-white border-text-muted'
                 )}>
                   {product.status === 'Active' ? 'Satışta' : 'Pasif'}
                 </span>
              </div>
           </div>
           <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
              {product.images?.map((img) => (
                <button
                  key={img.id}
                  onClick={() => setActiveImage(img.path)}
                  className={cn(
                    "w-16 h-16 flex-shrink-0 rounded-lg border-2 transition-all overflow-hidden p-1 bg-white",
                    activeImage === img.path ? "border-primary" : "border-border-color opacity-60 hover:opacity-100"
                  )}
                >
                  <img src={img.path} className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                </button>
              ))}
           </div>
        </div>

        {/* Info */}
        <div className="lg:col-span-2 space-y-6">
           <section className="card p-8 space-y-6">
              <div>
                <p className="text-[10px] font-bold text-primary uppercase tracking-widest mb-1">
                  {[product.category, seriesLabel ? `${seriesLabel} Seri` : null, product.model].filter(Boolean).join(' / ')}
                </p>
                <div className="flex items-center space-x-2">
                   <h1 className="text-3xl font-extrabold text-text-main tracking-tight">{product.name}</h1>
                   <span className="text-text-muted mt-1.5 font-medium">| {product.title}</span>
                </div>
                <div className="flex items-center space-x-4 mt-3">
                  <div className="flex items-center bg-bg-main px-3 py-1 rounded border border-border-color text-[10px] font-mono font-bold text-text-muted uppercase">
                    SKU: <span className="text-text-main ml-1.5">{product.sku}</span>
                  </div>
                  <div className="flex items-center bg-bg-main px-3 py-1 rounded border border-border-color text-[10px] font-mono font-bold text-text-muted uppercase">
                    BAR: <span className="text-text-main ml-1.5">{product.barcode || '-'}</span>
                  </div>
                  {product.warehouse_location && (
                    <div className="flex items-center bg-bg-main px-3 py-1 rounded border border-border-color text-[10px] font-bold text-text-muted uppercase">
                      LOKASYON: <span className="text-primary ml-1.5">{product.warehouse_location}</span>
                    </div>
                  )}
                  {seriesLabel && (
                    <div className="flex items-center bg-emerald-50 px-3 py-1 rounded border border-emerald-100 text-[10px] font-bold text-emerald-700 uppercase">
                      SERİ: <span className="ml-1.5">{seriesLabel}</span>
                    </div>
                  )}
                  <ProductKindBadge product={product} />
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-6 py-6 border-y border-border-color">
                <DetailStat label="Satış Fiyatı" value={<FormatAmount amount={product.sale_price} />} color="text-primary font-black" />
                <DetailStat label="Merkez Depo Stoğu" value={`${centralStock} Adet`} color={centralStock <= (product.min_stock_level || 0) ? "text-danger" : "text-success"} />
                <DetailStat label="Seri" value={seriesLabel || 'Bilinmiyor'} color="text-text-muted font-mono text-sm" />
                <DetailStat label="Ağırlık" value={`${product.weight} gr`} color="text-text-muted" />
                <DetailStat label="Boru Ölçüsü" value={product.pipe_size || 'Bilinmiyor'} color="text-text-muted font-mono text-sm" />
                <DetailStat label="Alış ($)" value={`$${product.purchase_price_usd.toFixed(2)}`} color="text-text-muted" subLabel={`₺${product.exchange_rate_used} kur ile`} />
                <DetailStat label="Maliyet (₺)" value={<FormatAmount amount={product.purchase_cost} />} color="text-text-muted" />
                <DetailStat
                  label="Buffer Maliyet"
                  value={<FormatAmount amount={product.purchase_cost * (1 + (product.buffer_percentage || 0) / 100)} />}
                  subLabel={`%${product.buffer_percentage} Buffer`}
                  color="text-orange-600"
                />
                <DetailStat
                  label="Kar Payı"
                  value={<FormatAmount amount={profit} />}
                  subLabel={`%${product.sale_price ? ((profit / product.sale_price) * 100).toFixed(1) : 0} Marj`}
                  color="text-success"
                />
              </div>

              {product.stock_source === 'bom' && product.bom_components && product.bom_components.length > 0 && (
                <div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-5 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-xs font-black text-blue-700 uppercase tracking-widest flex items-center gap-2">
                        <Layers className="w-4 h-4" /> BOM Reçetesi
                      </h3>
                      <p className="text-xs text-blue-700/80 mt-1">Satışta final ürün görünür; stok H parçalarından otomatik düşer.</p>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2 text-[11px] font-black">
                      <span className="text-blue-700 bg-white border border-blue-100 px-3 py-1 rounded-full">Üretilebilir: {centralStock}</span>
                      <span className="text-slate-700 bg-white border border-slate-200 px-3 py-1 rounded-full">Fiziksel final: {product.physical_stock ?? product.central_stock ?? 0}</span>
                      <span className="text-amber-700 bg-amber-50 border border-amber-100 px-3 py-1 rounded-full">Darboğaz: {bottleneckComponent?.sku || '—'}</span>
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-blue-100 bg-white">
                    <table className="w-full text-sm min-w-[720px]">
                      <thead className="bg-blue-50/70 text-[10px] uppercase tracking-widest text-blue-700 font-black">
                        <tr>
                          <th className="px-3 py-3 text-left">Component SKU</th>
                          <th className="px-3 py-3 text-left">Component Adı</th>
                          <th className="px-3 py-3 text-right">1 Ürün İçin</th>
                          <th className="px-3 py-3 text-right">Mevcut Stok</th>
                          <th className="px-3 py-3 text-right">Üretilebilir</th>
                          <th className="px-3 py-3 text-center">Darboğaz</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-blue-50">
                        {product.bom_components.map((component) => {
                          const isBottleneck = component.component_product_id === bottleneckComponent?.component_product_id;
                          return (
                            <tr key={component.component_product_id}>
                              <td className="px-3 py-3 font-mono text-xs font-bold text-slate-700">{component.sku}</td>
                              <td className="px-3 py-3 text-xs font-bold text-text-main">{component.name || component.title || component.component_role || '—'}</td>
                              <td className="px-3 py-3 text-right font-black text-blue-700">x{component.quantity_per_unit}</td>
                              <td className="px-3 py-3 text-right font-bold text-slate-700">{component.central_stock ?? 0}</td>
                              <td className="px-3 py-3 text-right font-bold text-slate-700">{component.available_for_parent ?? 0}</td>
                              <td className="px-3 py-3 text-center">
                                {isBottleneck ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-100 px-2 py-1 text-[10px] font-black text-amber-700">
                                    <AlertTriangle className="w-3 h-3" /> Darboğaz
                                  </span>
                                ) : (
                                  <span className="text-[10px] font-bold text-slate-400">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {product.bom_usage && product.bom_usage.length > 0 && (
                <div className="rounded-2xl border border-amber-100 bg-amber-50/60 p-5 space-y-4">
                  <div>
                    <h3 className="text-xs font-black text-amber-700 uppercase tracking-widest flex items-center gap-2">
                      <Layers className="w-4 h-4" /> Bu Component Hangi Final Ürünlerde Kullanılıyor?
                    </h3>
                    <p className="text-xs text-amber-700/80 mt-1">Bu parça satılan final ürünlerin reçetesinde kullanılıyorsa burada görünür.</p>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-amber-100 bg-white">
                    <table className="w-full text-sm min-w-[680px]">
                      <thead className="bg-amber-50 text-[10px] uppercase tracking-widest text-amber-700 font-black">
                        <tr>
                          <th className="px-3 py-3 text-left">Final SKU</th>
                          <th className="px-3 py-3 text-left">Final Ürün</th>
                          <th className="px-3 py-3 text-right">1 Ürün İçin</th>
                          <th className="px-3 py-3 text-right">Üretilebilir</th>
                          <th className="px-3 py-3 text-left">Darboğaz</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-50">
                        {product.bom_usage.map((usage) => (
                          <tr key={usage.parent_product_id}>
                            <td className="px-3 py-3 font-mono text-xs font-bold text-slate-700">{usage.sku}</td>
                            <td className="px-3 py-3 text-xs font-bold text-text-main">{usage.name || usage.title}</td>
                            <td className="px-3 py-3 text-right font-black text-amber-700">x{usage.quantity_per_unit}</td>
                            <td className="px-3 py-3 text-right font-bold text-slate-700">{usage.available_stock ?? 0}</td>
                            <td className="px-3 py-3 text-xs text-slate-600">
                              {usage.bottleneck_component?.sku
                                ? `${usage.bottleneck_component.sku} (${usage.bottleneck_component.available_for_parent ?? 0} adet)`
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-6">
                <div className="space-y-3">
                  <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center"><Info className="w-4 h-4 mr-2" /> Ürün Açıklaması</h3>
                  <div className="text-sm text-text-muted leading-relaxed whitespace-pre-wrap bg-bg-main p-4 rounded-lg border border-border-color">
                    {product.description || 'Açıklama girilmemiş.'}
                  </div>
                </div>
                <div className="space-y-3">
                  <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center"><MessageSquare className="w-4 h-4 mr-2" /> Dahili Notlar</h3>
                  <div className="text-sm text-text-muted leading-relaxed whitespace-pre-wrap bg-bg-main p-4 rounded-lg border border-border-color italic">
                    {product.notes || 'Not eklenmemiş.'}
                  </div>
                </div>
              </div>
           </section>

           <section className="card">
              <div className="p-6 border-b border-border-color flex items-center space-x-2">
                <History className="w-4 h-4 text-text-muted" />
                <h3 className="font-bold text-text-main text-sm">Stok Hareket Geçmişi</h3>
              </div>
              <div className="divide-y divide-border-color max-h-[300px] overflow-y-auto">
                 {stockLogs.map((log) => {
                   const isBomMovement = log.type === 'BOM_CONSUMPTION' || String(log.reason || '').includes('BOM Tüketimi');
                   const finalSku = detailFromReason(log.reason, 'Final SKU');
                   const componentSku = detailFromReason(log.reason, 'Component SKU') || product.sku;
                   const orderRef = detailFromReason(log.reason, 'Sipariş');
                   return (
                     <div key={log.id} className="flex items-center justify-between gap-4 p-4 hover:bg-bg-main transition-colors">
                        <div className="flex items-center space-x-4 min-w-0">
                          <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                            isBomMovement ? "bg-blue-50 text-blue-700 border border-blue-100" : log.change_amount > 0 ? "bg-green-50 text-success border border-green-100" : "bg-red-50 text-danger border border-red-100"
                          )}>
                             {log.change_amount > 0 ? <Plus className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-text-main">
                              {isBomMovement ? 'BOM Tüketimi' : log.platform_name}:
                              <span className={log.change_amount > 0 ? 'text-success ml-1' : 'text-danger ml-1'}>{log.change_amount > 0 ? '+' : ''}{log.change_amount} Adet</span>
                            </p>
                            {isBomMovement ? (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-black uppercase tracking-tight">
                                <span className="rounded bg-blue-50 border border-blue-100 px-2 py-0.5 text-blue-700">Final: {finalSku || '—'}</span>
                                <span className="rounded bg-slate-50 border border-slate-200 px-2 py-0.5 text-slate-600">Component: {componentSku}</span>
                                <span className="rounded bg-amber-50 border border-amber-100 px-2 py-0.5 text-amber-700">Sipariş: {orderRef || '—'}</span>
                              </div>
                            ) : (
                              <p className="text-[10px] text-text-muted font-bold uppercase tracking-tight truncate">{log.reason}</p>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-[10px] uppercase font-bold text-text-muted tracking-widest">{new Date(log.created_at).toLocaleDateString('tr-TR')}</p>
                          <p className="text-[10px] uppercase font-bold text-text-muted tracking-widest opacity-60">{new Date(log.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</p>
                        </div>
                     </div>
                   );
                 })}
                 {stockLogs.length === 0 && <div className="py-12 text-center italic text-text-muted text-sm px-6">Henüz bir hareket kaydı yok.</div>}
              </div>
           </section>
        </div>
      </div>
    </div>
  );
}

function DetailStat({ label, value, subLabel, color }: { label: string, value: React.ReactNode, subLabel?: string, color: string }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-[#94A3B8] uppercase tracking-wider mb-2">{label}</p>
      <p className={cn("text-2xl font-extrabold tracking-tight", color)}>{value}</p>
      {subLabel && <p className="text-xs font-bold text-[#64748B] mt-1">{subLabel}</p>}
    </div>
  );
}

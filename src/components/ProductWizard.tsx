import { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Upload, 
  Trash2,
  Package,
  CircleDollarSign,
  Info,
  CheckCircle2,
} from 'lucide-react';
import { api, PLATFORMS } from '../lib/api';
import { Settings } from '../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useCurrency } from '../CurrencyContext';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ProductWizardProps {
  productId?: string | null;
  settings?: Settings | null;
  onClose: () => void;
}

export default function ProductWizard({ productId, settings, onClose }: ProductWizardProps) {
  const [loading, setLoading] = useState(false);
  const { activeRate } = useCurrency();

  const [formData, setFormData] = useState<any>({
    name: '',
    title: '',
    total_stock: '',
    warehouse_location: '',
    sku: '',
    barcode: '',
    category: '',
    model: 'Standart',
    pipe_size: '',
    description: '',
    purchase_price_usd: 0,
    purchase_cost: 0,
    sale_price: 0,
    buffer_percentage: settings?.default_buffer_percentage || 0,
    profit_percentage: settings?.default_profit_percentage || 0,
    exchange_rate_used: activeRate || 0,
    price_locked: false,
    weight: 0,
    min_stock_level: 50,
    status: 'Active',
    notes: '',
    platforms: PLATFORMS.map(name => ({ name, stock: 0, price: 0, is_listed: true }))
  });

  useEffect(() => {
    if (settings && !productId) {
      setFormData((prev: any) => ({ 
        ...prev, 
        category: prev.category || settings.product_categories[0],
        exchange_rate_used: activeRate,
        buffer_percentage: settings.default_buffer_percentage,
        profit_percentage: settings.default_profit_percentage || 0
      }));
    }
  }, [settings, productId, activeRate]);

  const [images, setImages] = useState<any[]>([]);
  const [newImages, setNewImages] = useState<File[]>([]);
  const [imageChanged, setImageChanged] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (productId) {
      loadProduct();
    }
  }, [productId]);

  const loadProduct = async () => {
    try {
      const data = await api.get(`/products/${productId}`);
      const totalStock = data.central_stock ?? data.total_stock ?? 0;
      setFormData({
        ...data,
        total_stock: totalStock,
        platforms: PLATFORMS.map(name => {
          const p = data.platforms?.find((dp: any) => dp.platform_name === name);
          return p ? { name, stock: 0, price: p.price, is_listed: !!p.is_listed } : { name, stock: 0, price: data.sale_price, is_listed: false };
        })
      });
      setImages(data.images || []);
    } catch (err) {
      console.error(err);
    }
  };

  const handleInputChange = (e: any) => {
    const { name, value } = e.target;
    setFormData((prev: any) => {
      return { ...prev, [name]: value };
    });
  };

  const handlePlatformChange = (index: number, field: string, value: any) => {
    const newPlatforms = [...formData.platforms];
    newPlatforms[index] = { ...newPlatforms[index], [field]: value };
    setFormData((prev: any) => ({ ...prev, platforms: newPlatforms }));
  };

  const handleFileChange = (e: any) => {
    if (e.target.files) {
      const files = Array.from(e.target.files) as File[];
      setNewImages(prev => [...prev, ...files]);
      setImageChanged(true);
    }
  };

  const removeNewImage = (index: number) => {
    setNewImages(prev => prev.filter((_, i) => i !== index));
    setImageChanged(true);
  };

  const deleteExistingImage = async (id: string) => {
    try {
      await api.delete(`/images/${id}`);
      setImages(prev => prev.filter(img => img.id !== id));
      setImageChanged(true);
    } catch (err) {
       alert("Görsel silinemedi");
    }
  };

  const handleSubmit = async () => {
    if (!formData.name || !formData.title || formData.total_stock === '' || formData.total_stock === null || formData.total_stock === undefined) {
       alert("Lütfen zorunlu alanları (Ad, Başlık, Stok) doldurunuz.");
       return;
    }
    setLoading(true);
    try {
      let savedId = productId;
      const centralStock = parseInt(formData.total_stock) || 0;
      const payload = {
        ...formData,
        central_stock: centralStock,
        total_stock: centralStock,
        platforms: (formData.platforms || []).map((platform: any) => ({
          ...platform,
          stock: 0,
        })),
        images,
        imageChanged,
      };
      
      if (productId) {
        await api.put(`/products/${productId}`, payload);
      } else {
        const res = await api.post('/products', payload);
        savedId = res.id;
      }

      if (newImages.length > 0 && savedId) {
        const fd = new FormData();
        newImages.forEach(img => fd.append('images', img));
        await api.upload(`/products/${savedId}/images`, fd);
      }

      onClose();
    } catch (err) {
      alert("Hata oluştu, lütfen alanları kontrol edin.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div 
        className="absolute inset-0 bg-[#0F172A]/40 backdrop-blur-sm animate-in fade-in duration-300"
        onClick={onClose}
      ></div>
      
      <div className="bg-white w-full max-w-5xl max-h-[92vh] rounded-[32px] shadow-2xl flex flex-col overflow-hidden relative animate-in slide-in-from-bottom-8 duration-500">
        {/* Header */}
        <div className="px-5 lg:px-10 py-5 lg:py-6 border-b border-border-color flex items-center justify-between bg-white sticky top-0 z-20">
          <div>
            <h2 className="text-xl lg:text-2xl font-black text-text-main tracking-tight">{productId ? 'Ürünü Düzenle' : 'Yeni Ürün Kaydı'}</h2>
            <p className="text-[10px] text-text-muted font-bold uppercase tracking-widest mt-1">Lütfen aşağıdaki tüm bilgileri eksiksiz doldurunuz.</p>
          </div>
          <button 
            onClick={onClose}
            className="p-2.5 hover:bg-bg-main rounded-2xl text-text-muted hover:text-text-main transition-all"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 lg:p-10 space-y-12 bg-white custom-scrollbar pb-32">
          {/* Section: Basic Info */}
          <section className="space-y-6">
            <div className="flex items-center space-x-3 pb-2 border-b border-bg-main">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <Info className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-black text-text-main uppercase tracking-widest">1. Temel Ürün Bilgileri</h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <Field label="Ürün Başlığı (Platformlarda Görünecek)" required>
                  <input 
                    name="title" 
                    value={formData.title} 
                    onChange={handleInputChange} 
                    placeholder="Örn: Pamuklu Siyah T-Shirt - %100 Pamuk"
                    className="form-input text-lg font-bold" 
                  />
                </Field>
              </div>
              <Field label="Dahili Ürün Adı" required>
                <input 
                  name="name" 
                  value={formData.name} 
                  onChange={handleInputChange} 
                  placeholder="Örn: Siyah T-Shirt"
                  className="form-input" 
                />
              </Field>
              <Field label="SKU / Stok Kodu">
                <input 
                  name="sku" 
                  value={formData.sku} 
                  onChange={handleInputChange} 
                  placeholder="Otomatik oluşturulur..."
                  className="form-input font-mono font-bold" 
                />
              </Field>
              <Field label="Barkod No">
                <input 
                  name="barcode" 
                  value={formData.barcode} 
                  onChange={handleInputChange} 
                  placeholder="EAN / UPC / Barkod"
                  className="form-input font-mono" 
                />
              </Field>
              <Field label="Ürün Durumu">
                 <select name="status" value={formData.status} onChange={handleInputChange} className="form-input font-bold">
                   <option value="Active">Aktif (Satışta)</option>
                   <option value="Passive">Pasif (Gizli)</option>
                   <option value="Out of stock">Tükendi</option>
                 </select>
              </Field>
              <Field label="Ürün Ağırlığı (GR)">
                <input 
                  type="number"
                  name="weight" 
                  value={formData.weight} 
                  onChange={handleInputChange} 
                  placeholder="Örn: 250"
                  className="form-input font-bold" 
                />
              </Field>
              <Field label="Kritik Stok Seviyesi">
                <input 
                  type="number"
                  name="min_stock_level" 
                  value={formData.min_stock_level} 
                  onChange={(e) => setFormData({...formData, min_stock_level: parseInt(e.target.value) || 0})}
                  placeholder="Örn: 50"
                  className="form-input font-bold" 
                />
              </Field>
              <Field label="Merkez Depo Stoğu" required>
                <input 
                  type="number"
                  name="total_stock" 
                  value={formData.total_stock} 
                  onChange={handleInputChange} 
                  placeholder="Örn: 100"
                  className="form-input font-bold" 
                />
              </Field>
            </div>
          </section>

          {/* Section: Category & Details */}
          <section className="space-y-6">
            <div className="flex items-center space-x-3 pb-2 border-b border-bg-main">
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-500">
                <Package className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-black text-text-main uppercase tracking-widest">2. Kategorizasyon & Detaylar</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <Field label="Ürün Malzemesi">
                 <div className="flex flex-wrap gap-2">
                   {settings?.product_categories.map(c => (
                     <button 
                       key={c} 
                       type="button"
                       onClick={() => setFormData((prev: any) => ({ ...prev, category: c }))}
                       className={cn(
                         "whitespace-normal text-left break-words px-4 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-wider transition-all",
                         formData.category === c ? "bg-primary border-primary text-white shadow-lg" : "bg-white border-border-color text-text-muted hover:bg-bg-main"
                       )}
                     >
                       {c}
                     </button>
                   ))}
                 </div>
              </Field>
              <Field label="Model / Sınıflandırma">
                 <input 
                    name="model" 
                    value={formData.model} 
                    onChange={handleInputChange} 
                    placeholder="Örn: Standart, XL, M vb."
                    className="form-input" 
                 />
              </Field>
              <Field label="Boru Ölçüsü">
                 <input 
                    name="pipe_size" 
                    value={formData.pipe_size} 
                    onChange={handleInputChange} 
                    placeholder="Örn: 20 mm, 1/2 inç vb."
                    className="form-input font-bold" 
                 />
              </Field>
              <div className="md:col-span-2">
                <Field label="Depo Lokasyonu">
                  <input 
                    name="warehouse_location" 
                    value={formData.warehouse_location} 
                    onChange={handleInputChange} 
                    placeholder="Örn: Raf A-12 / Bölüm 4"
                    className="form-input" 
                  />
                </Field>
              </div>
            </div>
          </section>

          {/* Section: Pricing & Stock */}
          <section className="space-y-6">
            <div className="flex items-center space-x-3 pb-2 border-b border-bg-main">
              <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center text-green-500">
                <CircleDollarSign className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-black text-text-main uppercase tracking-widest">3. Fiyatlandırma & Stok Yönetimi</h3>
            </div>

            <div className="p-6 lg:p-8 bg-primary/5 rounded-[24px] border border-primary/10 space-y-8">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <Field label="Alış Fiyatı ($)" required>
                  <div className="relative">
                    <div className="absolute left-4 top-3.5 text-text-muted font-bold text-sm">$</div>
                    <input 
                      type="number" 
                      step="0.01"
                      min="0"
                      value={formData.purchase_price_usd} 
                      onChange={(e) => {
                        const usd = parseFloat(e.target.value) || 0;
                        const costTl = usd * formData.exchange_rate_used;
                        const bufferedCostTl = costTl * (1 + formData.buffer_percentage / 100);
                        const saleTl = bufferedCostTl * (1 + formData.profit_percentage / 100);
                        setFormData((prev: any) => ({ 
                          ...prev, 
                          purchase_price_usd: usd, 
                          purchase_cost: costTl,
                          sale_price: prev.price_locked ? prev.sale_price : (saleTl > 0 ? Math.ceil(saleTl) : prev.sale_price)
                        }));
                      }}
                      className="form-input pl-10 font-black text-lg" 
                    />
                  </div>
                </Field>
                <Field label="USD Kuru ($ → ₺)">
                  <div className="relative">
                    <div className="absolute left-4 top-3.5 text-text-muted font-bold text-sm">₺</div>
                    <input 
                      type="number" 
                      step="0.01"
                      min="0"
                      value={formData.exchange_rate_used} 
                      onChange={(e) => {
                        const rate = parseFloat(e.target.value) || 0;
                        const costTl = formData.purchase_price_usd * rate;
                        const bufferedCostTl = costTl * (1 + formData.buffer_percentage / 100);
                        const saleTl = bufferedCostTl * (1 + formData.profit_percentage / 100);
                        setFormData((prev: any) => ({ 
                          ...prev, 
                          exchange_rate_used: rate, 
                          purchase_cost: costTl,
                          sale_price: prev.price_locked ? prev.sale_price : (saleTl > 0 ? Math.ceil(saleTl) : prev.sale_price)
                        }));
                      }}
                      className="form-input pl-10 font-bold" 
                    />
                  </div>
                </Field>
                <Field label="Buffer Marjı (%)">
                  <div className="relative">
                    <div className="absolute right-4 top-3.5 text-text-muted font-bold text-sm">%</div>
                    <input 
                      type="number" 
                      min="0"
                      value={formData.buffer_percentage} 
                      onChange={(e) => {
                        const buff = parseFloat(e.target.value) || 0;
                        const bufferedCostTl = formData.purchase_cost * (1 + buff / 100);
                        const saleTl = bufferedCostTl * (1 + formData.profit_percentage / 100);
                        setFormData((prev: any) => ({ 
                          ...prev, 
                          buffer_percentage: buff, 
                          sale_price: prev.price_locked ? prev.sale_price : (saleTl > 0 ? Math.ceil(saleTl) : prev.sale_price)
                        }));
                      }}
                      className="form-input pr-10 font-bold text-orange-600" 
                    />
                  </div>
                </Field>
                <Field label="Kâr Yüzdesi (%)">
                  <div className="relative">
                    <div className="absolute right-4 top-3.5 text-text-muted font-bold text-sm">%</div>
                    <input 
                      type="number" 
                      min="0"
                      value={formData.profit_percentage} 
                      onChange={(e) => {
                        const profit = parseFloat(e.target.value) || 0;
                        const bufferedCostTl = formData.purchase_cost * (1 + formData.buffer_percentage / 100);
                        const saleTl = bufferedCostTl * (1 + profit / 100);
                        setFormData((prev: any) => ({ 
                          ...prev, 
                          profit_percentage: profit, 
                          sale_price: prev.price_locked ? prev.sale_price : (saleTl > 0 ? Math.ceil(saleTl) : prev.sale_price)
                        }));
                      }}
                      className="form-input pr-10 font-bold text-green-600" 
                    />
                  </div>
                </Field>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 border-t border-primary/10 pt-8">
                <Field label="Net Alış Maliyeti (₺)">
                  <div className="relative">
                    <div className="absolute left-4 top-3.5 text-text-muted font-bold text-sm">₺</div>
                    <input 
                      type="number" 
                      value={formData.purchase_cost.toFixed(2)} 
                      readOnly
                      className="form-input pl-10 font-bold bg-bg-main/50" 
                    />
                  </div>
                </Field>
                <Field label="Bufferlı Maliyet (₺)">
                  <div className="relative">
                    <div className="absolute left-4 top-3.5 text-text-muted font-bold text-sm">₺</div>
                    <input 
                      type="number" 
                      value={(formData.purchase_cost * (1 + formData.buffer_percentage / 100)).toFixed(2)} 
                      readOnly
                      className="form-input pl-10 font-bold bg-bg-main/50 text-orange-700" 
                    />
                  </div>
                </Field>
                <Field label="Satış Fiyatı (₺)" required>
                  <div className="relative">
                    <div className="absolute left-4 top-3.5 text-primary font-bold text-sm">₺</div>
                    <input 
                      type="number" 
                      value={formData.sale_price} 
                      onChange={(e) => setFormData((prev: any) => ({ ...prev, sale_price: parseFloat(e.target.value) || 0 }))}
                      className="form-input pl-10 font-black text-xl text-primary border-primary/30 focus:border-primary shadow-lg shadow-primary/5" 
                    />
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      id="price_locked"
                      checked={formData.price_locked}
                      onChange={(e) => setFormData((prev: any) => ({ ...prev, price_locked: e.target.checked }))}
                      className="w-4 h-4 text-primary rounded focus:ring-primary"
                    />
                    <label htmlFor="price_locked" className="text-xs font-semibold text-text-main cursor-pointer">
                      Toplu güncellemelerde fiyatı kitle
                    </label>
                  </div>
                </Field>
              </div>
            </div>
          </section>

          {/* Section: Media & Content */}
          <section className="space-y-6">
            <div className="flex items-center space-x-3 pb-2 border-b border-bg-main">
              <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-500">
                <Upload className="w-4 h-4" />
              </div>
              <h3 className="text-sm font-black text-text-main uppercase tracking-widest">4. Görseller & Detaylı İçerik</h3>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
              <div className="space-y-6">
                <Field label="Ürün Açıklaması / İçerik">
                  <textarea 
                    name="description" 
                    value={formData.description} 
                    onChange={handleInputChange} 
                    className="form-input min-h-[240px] py-4 resize-none leading-relaxed"
                    placeholder="Platformlarda görünecek ürün özelliklerini, kullanım detaylarını ve içeriği buraya yazın..."
                  />
                </Field>
                <Field label="Dahili Notlar">
                  <textarea 
                    name="notes" 
                    value={formData.notes} 
                    onChange={handleInputChange} 
                    placeholder="Bu ürünle ilgili sadece yönetim ekibinin göreceği notlar..."
                    className="form-input min-h-[100px] py-3 resize-none bg-bg-main"
                  />
                </Field>
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-black text-text-muted uppercase tracking-widest">Ürün Galerisi</p>
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="text-[10px] font-black text-primary uppercase tracking-widest border-b-2 border-primary/20 hover:border-primary transition-all"
                  >
                    Dosya Seç
                  </button>
                </div>

                <div className="p-2 border-2 border-dashed border-border-color rounded-2xl bg-bg-main/30">
                  <div className="flex space-x-2 mb-4">
                     <input 
                        type="text"
                        placeholder="Görsel URL yapıştırın..."
                        className="form-input flex-1 py-3 text-xs bg-white rounded-xl"
                        onKeyDown={async (e: any) => {
                           if (e.key === 'Enter') {
                              const url = e.target.value.trim();
                              if (url) {
                                 setImages(prev => [...prev, { id: 'temp-' + Date.now(), path: url, is_url: true }]);
                                 e.target.value = '';
                              }
                           }
                        }}
                     />
                     <div className="px-3 bg-white border border-border-color rounded-xl flex items-center">
                        <Upload className="w-4 h-4 text-text-muted" />
                     </div>
                  </div>

                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                     {images.map((img) => (
                       <div key={img.id} className="aspect-square bg-white rounded-xl relative border border-border-color overflow-hidden group p-1.5 shadow-sm">
                         <img src={img.path} className="w-full h-full object-contain" />
                         <button 
                           onClick={() => deleteExistingImage(img.id)}
                           className="absolute top-1 right-1 p-1 bg-white/90 shadow-sm rounded-lg text-danger hover:bg-danger hover:text-white opacity-0 group-hover:opacity-100 transition-all border border-border-color"
                         >
                           <Trash2 className="w-3 h-3" />
                         </button>
                       </div>
                     ))}
                     {newImages.map((file, idx) => (
                        <div key={idx} className="aspect-square bg-white rounded-xl relative border border-border-color overflow-hidden group p-1.5 shadow-sm">
                          <img src={URL.createObjectURL(file)} className="w-full h-full object-contain opacity-60" />
                          <button 
                            onClick={() => removeNewImage(idx)}
                            className="absolute top-1 right-1 p-1 bg-white/90 shadow-sm rounded-lg text-danger hover:bg-danger hover:text-white opacity-0 group-hover:opacity-100 transition-all border border-border-color"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                     ))}
                     <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="aspect-square bg-white/50 border-2 border-dashed border-border-color rounded-xl flex flex-col items-center justify-center text-text-muted hover:border-primary hover:bg-white transition-all group"
                     >
                        <Upload className="w-5 h-5 mb-1 group-hover:scale-110 transition-transform" />
                        <span className="text-[8px] font-black uppercase">Yükle</span>
                     </button>
                  </div>
                </div>
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} accept="image/*" />
                <p className="text-[10px] text-text-muted text-center italic mt-2">İlk sıradaki görsel vitrin görseli olarak kullanılacaktır.</p>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-5 lg:px-10 py-6 border-t border-border-color flex flex-col sm:flex-row items-center justify-between bg-bg-main/50 backdrop-blur-md absolute bottom-0 inset-x-0 z-20">
          <div className="hidden sm:flex items-center space-x-2 text-text-muted">
             <div className="w-2 h-2 rounded-full bg-success"></div>
             <span className="text-[10px] font-bold uppercase tracking-widest">Sistem Bağlantısı Aktif</span>
          </div>

          <div className="flex items-center space-x-4 w-full sm:w-auto">
             <button 
               onClick={onClose}
               className="flex-1 sm:flex-none px-8 py-3.5 text-text-muted font-bold text-sm hover:text-text-main transition-colors"
             >
               Vazgeç
             </button>
             <button 
               onClick={handleSubmit}
               disabled={loading || !formData.name || !formData.title}
               className="flex-[2] sm:flex-none flex items-center justify-center px-12 py-3.5 bg-primary text-white rounded-2xl font-black text-sm shadow-2xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:scale-100 disabled:shadow-none"
             >
               {loading ? (
                 <span className="flex items-center">
                   <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"></div>
                   Kaydediliyor...
                 </span>
               ) : (
                 <span className="flex items-center">
                   <CheckCircle2 className="w-4 h-4 mr-2" />
                   {productId ? 'Değişiklikleri Kaydet' : 'Ürünü Sisteme Kaydet'}
                 </span>
               )}
             </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string, required?: boolean, children: any }) {
  return (
    <div className="space-y-2">
      <label className="text-[11px] font-black text-[#475569] uppercase tracking-[0.15em] flex items-center px-1">
        {label}
        {required && <span className="text-rose-500 ml-1.5">*</span>}
      </label>
      {children}
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { ArrowLeft, User, Phone, MapPin, Truck, Hash, Search, Plus, Trash2, Package } from 'lucide-react';

const DEFAULT_SALES_CHANNELS = ['Satış Sistemi', 'Website', 'Trendyol', 'Hepsiburada', 'Amazon', 'N11'];
const DEFAULT_PENDING_CHANNELS = ['Trendyol', 'Hepsiburada', 'Amazon', 'N11'];
const DIRECT_SALES_CHANNELS = ['Satış Sistemi', 'Website'];

export default function SalesForm({ onBack }: { onBack: () => void }) {
  const [formData, setFormData] = useState({
    customer_name: '',
    customer_phone: '',
    customer_address: '',
    shipping_company: '',
    tracking_number: '',
    external_order_id: '',
    platform: 'Satış Sistemi',
    commission_rate: 0,
    shipping_cost: 0,
    discount: 0,
    cash_account_id: ''
  });

  const [products, setProducts] = useState<any[]>([]);
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({});
  const [searchQuery, setSearchQuery] = useState('');
  
  const [selectedItems, setSelectedItems] = useState<any[]>([]); // { product_id, product_name, quantity, weight_per_unit, sale_price }
  
  const [saving, setSaving] = useState(false);

  const normalizeSettings = (data: any) => {
    if (!Array.isArray(data)) return data || {};
    return data.reduce((acc: any, curr: any) => {
      try {
        acc[curr.key] = JSON.parse(curr.value);
      } catch {
        acc[curr.key] = curr.value;
      }
      return acc;
    }, {});
  };

  const getCommissionRates = (settingsValue = settings) => {
    const raw = settingsValue?.commission_rates || {};
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return raw && typeof raw === 'object' ? raw : {};
  };

  const getSalesChannels = (settingsValue = settings) => {
    const rawChannels = settingsValue?.sales_channels;
    const parsedChannels = Array.isArray(rawChannels)
      ? rawChannels
      : typeof rawChannels === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(rawChannels);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          })()
        : [];
    const commissionChannels = Object.keys(getCommissionRates(settingsValue));
    const sourceChannels = parsedChannels.length > 0
      ? parsedChannels
      : commissionChannels.length > 0
        ? commissionChannels
        : DEFAULT_SALES_CHANNELS;
    const result: string[] = [];
    ['Satış Sistemi', ...sourceChannels].forEach((channel) => {
      const value = String(channel || '').trim();
      if (value && !result.includes(value)) result.push(value);
    });
    return result;
  };

  const isPendingChannel = (platform: string) => {
    if (DEFAULT_PENDING_CHANNELS.includes(platform)) return true;
    return cashAccounts.some((account) =>
      account.type === 'platform' &&
      account.is_active !== 0 &&
      account.name === `${platform} Bekleyen`
    );
  };

  const requiresPlatformOrderNumber = (platform: string) => {
    const normalized = String(platform || '').trim().toLocaleLowerCase('tr-TR');
    return !!normalized && !DIRECT_SALES_CHANNELS.some((channel) => channel.toLocaleLowerCase('tr-TR') === normalized);
  };

  useEffect(() => {
    loadProducts();
    loadSettings();
    api.get('/cash-accounts').then(setCashAccounts).catch(console.error);
  }, []);

  const loadSettings = async () => {
    try {
      const data = normalizeSettings(await api.get('/settings'));
      const settingsObj = {
        ...data,
        sales_channels: getSalesChannels(data),
        commission_rates: getCommissionRates(data),
      };
      setSettings(settingsObj);
      const initialPlatform = settingsObj.sales_channels.includes(formData.platform)
        ? formData.platform
        : settingsObj.sales_channels[0] || 'Satış Sistemi';
      setFormData(prev => ({
        ...prev,
        platform: initialPlatform,
        commission_rate: Number(settingsObj.commission_rates?.[initialPlatform] ?? prev.commission_rate ?? 0),
      }));
    } catch (err) {
      console.error(err);
    }
  };

  const loadProducts = async () => {
    try {
      const data = await api.get('/products');
      setProducts(data);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePlatformChange = (platform: string) => {
    const rates = getCommissionRates();
    const rate = Number(rates[platform] ?? 0);
    setFormData(prev => ({
      ...prev,
      platform,
      commission_rate: rate,
      cash_account_id: isPendingChannel(platform) ? '' : prev.cash_account_id,
      external_order_id: requiresPlatformOrderNumber(platform) ? prev.external_order_id : '',
    }));
  };

  const handleAddItem = (product: any) => {
    if (product.total_stock <= 0) {
      alert("Bu ürünün stoğu bitmiş, eklenemez.");
      return;
    }
    setSelectedItems(prev => {
      const exists = prev.find(p => p.product_id === product.id);
      if (exists) {
        if (exists.quantity >= product.total_stock) {
           alert("Maksimum stok sınırına ulaştınız.");
           return prev;
        }
        return prev.map(p => p.product_id === product.id ? { ...p, quantity: p.quantity + 1 } : p);
      }
      return [...prev, {
        product_id: product.id,
        product_name: product.name || product.title,
        quantity: 1,
        weight_per_unit: product.weight || 0,
        sale_price: product.sale_price || 0,
        total_stock: product.total_stock || 0
      }];
    });
    setSearchQuery('');
  };

  const updateItemQuantity = (id: string, qty: number) => {
    if (qty < 1) return;
    setSelectedItems(prev => prev.map(p => {
      if (p.product_id === id) {
        if (qty > p.total_stock) {
           alert(`En fazla mevcut stok kadar (${p.total_stock}) girebilirsiniz.`);
           return { ...p, quantity: p.total_stock };
        }
        return { ...p, quantity: qty };
      }
      return p;
    }));
  };

  const updateItemPrice = (id: string, price: number) => {
    setSelectedItems(prev => prev.map(p => p.product_id === id ? { ...p, sale_price: price } : p));
  };
  
  const updateItemWeight = (id: string, weight: number) => {
    setSelectedItems(prev => prev.map(p => p.product_id === id ? { ...p, weight_per_unit: weight } : p));
  };

  const removeItem = (id: string) => {
    setSelectedItems(prev => prev.filter(p => p.product_id !== id));
  };

  const filteredProducts = products.filter(p => 
    (p.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) || 
    (p.title?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
    (p.sku?.toLowerCase() || '').includes(searchQuery.toLowerCase())
  ).slice(0, 5); // show top 5 results

  const totalQuantity = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
  const totalWeight = selectedItems.reduce((sum, item) => sum + (item.weight_per_unit * item.quantity), 0);
  const totalAmount = selectedItems.reduce((sum, item) => sum + (parseFloat(item.sale_price) * item.quantity), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedItems.length === 0) return alert('Lütfen en az bir ürün ekleyin.');
    if (requiresPlatformOrderNumber(formData.platform) && !formData.external_order_id.trim()) {
      return alert(`${formData.platform} için platform sipariş numarası zorunludur.`);
    }
    
    // Additional validation check just in case
    for (const item of selectedItems) {
      if (item.quantity > item.total_stock) {
        return alert(`Yetersiz stok: ${item.product_name} için mevcut stok ${item.total_stock} adet. Lütfen miktarı düşürün.`);
      }
    }
    
    setSaving(true);
    try {
      const response = await api.post('/sales', {
        ...formData,
        external_order_id: formData.external_order_id.trim(),
        total_quantity: totalQuantity,
        total_weight: totalWeight,
        total_amount: totalAmount,
        items: selectedItems.map(item => ({
          ...item,
          weight: item.weight_per_unit * item.quantity,
          price: parseFloat(item.sale_price)
        }))
      });
      if (response.success === false) {
        alert(response.error || 'Satış oluşturulurken bir hata oluştu');
      } else {
        alert(response.message || 'Satış başarıyla kaydedildi.');
        onBack();
      }
    } catch (err: any) {
      console.error(err);
      alert(err.response?.data?.error || err.message || 'Satış eklenirken hata oluştu');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-3xl shadow-lg border border-border-color overflow-hidden">
      <div className="px-6 py-4 border-b border-border-color flex items-center justify-between bg-bg-main/50">
        <div className="flex items-center gap-4">
          <button onClick={onBack} className="p-2 hover:bg-white rounded-xl transition-colors">
            <ArrowLeft className="w-5 h-5 text-text-main" />
          </button>
          <h2 className="text-xl font-black text-text-main">Yeni Satış Ekle</h2>
        </div>
      </div>

      <div className="p-6">
        <form onSubmit={handleSubmit} className="space-y-8">
          
          {/* MÜŞTERİ BİLGİLERİ */}
          <div>
            <h3 className="text-sm font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <User className="w-4 h-4" /> Müşteri Bilgileri
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <User className="w-4 h-4 text-gray-400" />
                </div>
                <input 
                  required
                  type="text" 
                  placeholder="Müşteri Adı / Ünvanı" 
                  value={formData.customer_name}
                  onChange={e => setFormData({...formData, customer_name: e.target.value})}
                  className="pl-10 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Phone className="w-4 h-4 text-gray-400" />
                </div>
                <input 
                  type="text" 
                  placeholder="Telefon" 
                  value={formData.customer_phone}
                  onChange={e => setFormData({...formData, customer_phone: e.target.value})}
                  className="pl-10 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
              <div className="relative md:col-span-2">
                <div className="absolute inset-y-0 left-0 pl-3 pt-3 pointer-events-none">
                  <MapPin className="w-4 h-4 text-gray-400" />
                </div>
                <textarea 
                  rows={2}
                  placeholder="Teslimat Adresi" 
                  value={formData.customer_address}
                  onChange={e => setFormData({...formData, customer_address: e.target.value})}
                  className="pl-10 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
            </div>
          </div>

          {/* KARGO BİLGİLERİ */}
          <div>
            <h3 className="text-sm font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <Truck className="w-4 h-4" /> Kargo Bilgileri
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Truck className="w-4 h-4 text-gray-400" />
                </div>
                <input 
                  type="text" 
                  placeholder="Kargo Firması (Örn: Yurtiçi, Aras, MNG)" 
                  value={formData.shipping_company}
                  onChange={e => setFormData({...formData, shipping_company: e.target.value})}
                  className="pl-10 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Hash className="w-4 h-4 text-gray-400" />
                </div>
                <input 
                  type="text" 
                  placeholder="Takip Numarası" 
                  value={formData.tracking_number}
                  onChange={e => setFormData({...formData, tracking_number: e.target.value})}
                  className="pl-10 w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
            </div>
          </div>

          {/* FİNANS VE PLATFORM BİLGİLERİ */}
          <div>
            <h3 className="text-sm font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <Hash className="w-4 h-4" /> Satış Kanalı ve Finans
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Platform / Satış Kanalı</label>
                <select
                  value={formData.platform}
                  onChange={e => handlePlatformChange(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                >
                  {getSalesChannels().map(k => (
                     <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              {requiresPlatformOrderNumber(formData.platform) && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">
                    Platform Sipariş No <span className="text-red-500">*</span>
                  </label>
                  <input
                    required
                    type="text"
                    value={formData.external_order_id}
                    onChange={e => setFormData({...formData, external_order_id: e.target.value})}
                    placeholder={`${formData.platform} sipariş numarası`}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                  />
                </div>
              )}
              {!isPendingChannel(formData.platform) && (
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Kasa Hesabı (Giriş)</label>
                  <select
                    required
                    value={formData.cash_account_id}
                    onChange={e => setFormData({...formData, cash_account_id: e.target.value})}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                  >
                    <option value="">Seçiniz...</option>
                    {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Komisyon Oranı (%)</label>
                <input 
                  type="number" 
                  step="0.1"
                  min="0"
                  value={formData.commission_rate}
                  onChange={e => setFormData({...formData, commission_rate: parseFloat(e.target.value) || 0})}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Kargo Maliyeti (₺)</label>
                <input 
                  type="number" 
                  step="0.1"
                  min="0"
                  value={formData.shipping_cost}
                  onChange={e => setFormData({...formData, shipping_cost: parseFloat(e.target.value) || 0})}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">İndirim Tutarı (₺)</label>
                <input 
                  type="number" 
                  step="0.1"
                  min="0"
                  value={formData.discount}
                  onChange={e => setFormData({...formData, discount: parseFloat(e.target.value) || 0})}
                  className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
                />
              </div>
            </div>
          </div>

          {/* SİPARİŞ İÇERİĞİ (ÜRÜNLER) */}
          <div>
            <h3 className="text-sm font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <Package className="w-4 h-4" /> Sipariş Edilen Ürünler
            </h3>
            
            <div className="mb-4 relative">
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="w-5 h-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Ürün adı veya Stok Kodu ile ara..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full px-4 py-3 bg-white border border-gray-300 shadow-sm rounded-xl text-sm font-medium outline-none focus:ring-2 focus:border-primary"
                />
              </div>

              {searchQuery && (
                <div className="absolute z-10 top-full mt-2 w-full bg-white border border-gray-200 shadow-2xl rounded-xl overflow-hidden">
                  {filteredProducts.length > 0 ? (
                    <ul className="divide-y divide-gray-100">
                      {filteredProducts.map(p => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => handleAddItem(p)}
                            disabled={p.total_stock <= 0}
                            className={`w-full text-left px-4 py-3 flex items-center justify-between transition-colors ${p.total_stock <= 0 ? 'bg-gray-50 opacity-60 cursor-not-allowed' : 'hover:bg-bg-main'}`}
                          >
                            <div>
                              <div className="font-bold text-sm text-text-main flex items-center gap-2">
                                {p.name || p.title}
                                {p.total_stock <= 0 && <span className="text-[10px] bg-red-100 text-red-600 px-2 py-0.5 rounded uppercase font-bold">Stok Yok</span>}
                                {p.total_stock > 0 && p.total_stock <= 10 && <span className="text-[10px] bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded uppercase font-bold">Son {p.total_stock}</span>}
                              </div>
                              <div className="text-xs text-text-muted mt-1 flex items-center gap-3">
                                {p.sku && <span>SKU: {p.sku}</span>}
                                <span className={p.total_stock > 0 ? "font-semibold text-primary" : "text-gray-400"}>Stok: {p.total_stock || 0}</span>
                                <span className="font-bold text-gray-700">{p.sale_price ? p.sale_price.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' }) : '0,00 ₺'}</span>
                              </div>
                            </div>
                            {p.total_stock > 0 && <Plus className="w-5 h-5 text-primary" />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="p-4 text-center text-sm text-gray-500">Ürün bulunamadı.</div>
                  )}
                </div>
              )}
            </div>

            {selectedItems.length > 0 && (
              <div className="bg-bg-main border border-border-color rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                   <table className="w-full text-sm text-left min-w-[800px]">
                    <thead className="bg-gray-100/50 text-gray-500 font-bold text-xs uppercase tracking-wider">
                      <tr>
                        <th className="px-4 py-3">Ürün</th>
                        <th className="px-4 py-3 w-32 text-center">Birim Fiyat</th>
                        <th className="px-4 py-3 w-32 text-center">Adet</th>
                        <th className="px-4 py-3 w-32 text-center">Toplam Fiyat</th>
                        <th className="px-4 py-3 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {selectedItems.map((item) => (
                        <tr key={item.product_id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-3">
                            <div className="font-bold text-text-main">{item.product_name}</div>
                            <div className="text-[10px] text-text-muted mt-0.5">Stok: {item.total_stock}</div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="relative">
                              <input 
                                type="number" 
                                min="0"
                                step="0.01"
                                value={item.sale_price}
                                onChange={(e) => updateItemPrice(item.product_id, parseFloat(e.target.value) || 0)}
                                className="w-24 text-center border-gray-300 rounded-lg py-1.5 focus:ring-1 focus:ring-primary focus:outline-none"
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <input 
                              type="number" 
                              min="1"
                              max={item.total_stock}
                              value={item.quantity}
                              onChange={(e) => updateItemQuantity(item.product_id, parseInt(e.target.value) || 1)}
                              className={`w-full text-center border-gray-300 rounded-lg py-1.5 focus:ring-1 focus:ring-primary focus:outline-none ${item.quantity > item.total_stock ? 'border-red-500 bg-red-50 text-red-700' : ''}`}
                            />
                            {item.quantity > item.total_stock && <div className="text-[9px] text-red-500 text-center mt-1">Yetersiz Stok</div>}
                          </td>
                          <td className="px-4 py-3 text-center font-bold text-primary">
                            {(item.sale_price * item.quantity).toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button type="button" onClick={() => removeItem(item.product_id)} className="p-2 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                   </table>
                </div>
              </div>
            )}
            
            {/* HESAPLANAN TOPLAMLAR */}
            {selectedItems.length > 0 && (
              <div className="mt-6 bg-primary/5 border border-primary/20 rounded-2xl p-6 flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex flex-col items-center sm:items-start">
                  <div className="text-sm font-bold text-primary uppercase tracking-wider">Toplam Sipariş Miktarı</div>
                  <div className="text-3xl font-black text-gray-800">{totalQuantity} <span className="text-lg text-gray-500 font-semibold">adet</span></div>
                </div>
                <div className="flex flex-col items-center sm:items-end">
                  <div className="text-sm font-bold text-primary uppercase tracking-wider">Sipariş Toplam Tutarı</div>
                  <div className="text-4xl font-black text-primary">{totalAmount.toLocaleString('tr-TR', { style: 'currency', currency: 'TRY' })}</div>
                </div>
              </div>
            )}
          </div>

          <div className="pt-6 border-t border-border-color flex justify-end gap-4">
             <button type="button" onClick={onBack} className="px-6 py-3 font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">
               İptal
             </button>
             <button 
               disabled={saving || selectedItems.some(i => i.quantity > i.total_stock) || selectedItems.length === 0} 
               type="submit" 
               className="px-8 py-3 font-bold text-white bg-primary hover:bg-primary-hover rounded-xl shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
             >
               {saving ? 'Kaydediliyor...' : 'Satışı Kaydet'}
             </button>
          </div>
        </form>
      </div>
    </div>
  );
}

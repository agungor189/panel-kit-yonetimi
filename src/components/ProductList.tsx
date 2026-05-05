import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Search,
  Filter,
  LayoutGrid,
  List,
  Package,
  MoreVertical,
  ChevronDown,
  Download,
  Upload,
  Trash2,
  FileText,
  ScanLine
} from 'lucide-react';
import { api, PLATFORMS } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { Product } from '../types';
import Papa from 'papaparse';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import BarcodeScannerModal from './BarcodeScannerModal';
import PricingSettingsModal from './PricingSettingsModal';
import { Calculator, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../App';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ProductListProps {
  onAddProduct: () => void;
  onProductClick: (id: string) => void;
}

export default function ProductList({ onAddProduct, onProductClick }: ProductListProps) {
  const { isReadOnly } = useAuth();
  const { FormatAmount, activeRate, viewCurrency } = useCurrency();
  const [products, setProducts] = useState<Product[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('Hepsi');
  const [filterStatus, setFilterStatus] = useState('Hepsi');
  const [showScanner, setShowScanner] = useState(false);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      const data = await api.get('/products');
      setProducts(data);
    } catch (err) {
      console.error(err);
    }
  };

  const filteredProducts = products.filter(p => {
    const searchLower = search.toLowerCase();
    const matchesSearch =
      (p.name?.toLowerCase().includes(searchLower)) ||
      (p.title?.toLowerCase().includes(searchLower)) ||
      (p.sku?.toLowerCase().includes(searchLower)) ||
      (p.barcode?.toLowerCase().includes(searchLower)) ||
      (p.product_series?.toLowerCase().includes(searchLower));
    const matchesCategory = filterCategory === 'Hepsi' || p.category === filterCategory;
    const matchesStatus = filterStatus === 'Hepsi' || p.status === filterStatus;
    return matchesSearch && matchesCategory && matchesStatus;
  });

  const categories = ['Hepsi', ...new Set(products.map(p => p.category))];
  const csvInputRef = useRef<HTMLInputElement>(null);

  // CSV Mapping State
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [importProgress, setImportProgress] = useState<{current: number, total: number} | null>(null);

  const [mapping, setMapping] = useState<Record<string, string>>({
    sku: 'Ürün Kodu',
    name: 'Ürün Adı',
    category: 'Malzeme',
    stock: 'Merkez Depo Stoğu',
    price: 'Satış Fiyatı',
    barcode: 'Barkod',
    description: 'Açıklama',
    weight: 'Ağırlık',
    location: 'Lokasyon',
    notes: 'Notlar',
    pipe_size: 'Boru Ölçüsü',
    series: 'Seri'
  });

  const exportToCsv = () => {
    const data = filteredProducts.map((p, index) => ({
      'Sıra No': index + 1,
      'Ürün Kodu': p.sku,
      'Malzeme': p.category,
      'Seri': p.product_series || '',
      'Ürün Adı': p.name || p.title,
      'Boru Ölçüsü': p.pipe_size || '',
      'Merkez Depo Stoğu': p.total_stock || 0,
      'Satış Fiyatı': p.sale_price,
      'Barkod': p.barcode || '',
      'Açıklama': p.description || '',
      'Ağırlık': p.weight || 0,
      'Lokasyon': p.warehouse_location || '',
      'Notlar': p.notes || ''
    }));

    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `urun_listesi_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isReadOnly) return;
    const file = e.target.files?.[0];
    if (!file) return;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const { data, meta } = results;
        if (data.length === 0) return;

        setCsvData(data);
        setCsvHeaders(meta.fields || []);

        // Try to auto-map based on headers
        const newMapping = { ...mapping };
        const headers = meta.fields || [];

        const findMatch = (keys: string[]) => headers.find(h => keys.some(k => h.toLowerCase().includes(k.toLowerCase())));

        newMapping.sku = findMatch(['sku', 'kod', 'ürün kodu']) || headers[0] || '';
        newMapping.name = findMatch(['ad', 'isim', 'başlık', 'ürün adı']) || headers[1] || '';
        newMapping.category = findMatch(['malzeme', 'kategori', 'category']) || headers[2] || '';
        newMapping.stock = findMatch(['stok', 'adet', 'stock', 'toplam stok', 'merkez depo stoğu']) || headers[3] || '';
        newMapping.price = findMatch(['fiyat', 'price', 'satış fiyatı']) || headers[4] || '';
        newMapping.barcode = findMatch(['barkod', 'barcode', 'ean']) || headers[5] || '';
        newMapping.description = findMatch(['açıklama', 'description', 'detay']) || headers[6] || '';
        newMapping.weight = findMatch(['ağırlık', 'weight', 'gram']) || headers[7] || '';
        newMapping.location = findMatch(['lokasyon', 'konum', 'location', 'raf']) || headers[8] || '';
        newMapping.notes = findMatch(['not', 'notes', 'bilgi']) || headers[9] || '';
        newMapping.pipe_size = findMatch(['boru ölçüsü', 'boru olcusu', 'ölçü', 'olcu', 'size', 'pipe size', 'diameter', 'çap', 'cap', 'nominal size', 'nominal bore', 'outside diameter', 'tube size', 'profil ölçüsü', 'profil olcusu']) || '';
        newMapping.series = findMatch(['seri', 'series', 'product series', 'ürün serisi', 'urun serisi', 'oya', 'prm']) || '';

        setMapping(newMapping);
        setShowMappingModal(true);
      }
    });
  };

  const executeImport = async () => {
    let successCount = 0;
    let errorCount = 0;

    setDeletingAll(true); // Reuse loading state
    setShowMappingModal(false);
    setImportProgress({ current: 0, total: csvData.length });

    for (let i = 0; i < csvData.length; i++) {
      const row = csvData[i];
      try {
        const sku = row[mapping.sku] || `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const name = row[mapping.name] || 'İsimsiz Ürün';
        const category = row[mapping.category] || 'Genel';
        const totalStock = parseInt(row[mapping.stock]) || 0;

        const parseCSVPrice = (val: any) => {
          if (!val) return 0;
          let s = String(val).replace(/[^0-9.,-]/g, '');
          s = s.replace(',', '.');
          const lastDot = s.lastIndexOf('.');
          if (lastDot !== -1) {
             const before = s.slice(0, lastDot).replace(/\./g, '');
             const after = s.slice(lastDot + 1);
             s = before + '.' + after;
          }
          const num = parseFloat(s);
          return isNaN(num) ? 0 : num;
        };
        const purchasePriceUSD = parseCSVPrice(row[mapping.price]);
        const barcode = row[mapping.barcode] || '';
        const description = row[mapping.description] || '';
        const weight = parseInt(row[mapping.weight]) || 0;
        const location = row[mapping.location] || '';
        const notes = row[mapping.notes] || '';
        const pipe_size = row[mapping.pipe_size] || '';
        const product_series = row[mapping.series] || '';

        await api.post('/products', {
          name: name,
          title: name,
          sku: sku,
          barcode: barcode,
          category: category,
          product_series,
          pipe_size: pipe_size,
          description: description,
          notes: notes,
          warehouse_location: location,
          weight: weight,
          model: 'Standart',
          purchase_price_usd: purchasePriceUSD,
          purchase_cost: 0,
          sale_price: 0,
          buffer_percentage: 0,
          profit_percentage: 0,
          price_locked: false,
          exchange_rate_used: 0,
          central_stock: totalStock,
          total_stock: totalStock,
          status: totalStock > 0 ? 'Active' : 'Out of stock',
          platforms: PLATFORMS.map((pName) => ({
            name: pName,
            stock: 0,
            price: 0,
            is_listed: true
          }))
        });
        successCount++;
      } catch (err) {
        console.error('Import error for row:', row, err);
        errorCount++;
      }
      setImportProgress({ current: i + 1, total: csvData.length });
    }

    setDeletingAll(false);
    setImportProgress(null);

    if (successCount > 0) {
      setTimeout(() => {
        setShowPricingModal(true);
      }, 500);
      toast.success(`${successCount} ürün başarıyla eklendi`);
    }

    if (errorCount > 0) {
      toast.error(`${errorCount} ürün eklenirken hata oluştu`);
    }

    loadProducts();
    if (csvInputRef.current) csvInputRef.current.value = '';
  };

  const [deletingAll, setDeletingAll] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [deleteAllInput, setDeleteAllInput] = useState("");
  const [showPricingModal, setShowPricingModal] = useState(false);

  const deleteAllProducts = async () => {
    if (isReadOnly) return;
    if (deleteAllInput !== "SİL") return;
    try {
      setDeletingAll(true);
      const res = await api.delete('/products');
      console.log("Delete all result:", res);
      await loadProducts();
      setShowDeleteAllConfirm(false);
    } catch (err) {
      console.error("Hepsini silme hatası:", err);
      alert("Silme işlemi sırasında bir hata oluştu.");
    } finally {
      setDeletingAll(false);
    }
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500">
      {importProgress && (
         <div className="fixed inset-0 bg-[#0F172A]/40 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
            <div className="bg-white rounded-3xl p-8 flex flex-col items-center shadow-2xl max-w-sm w-full mx-auto">
               <Loader2 className="w-10 h-10 animate-spin text-blue-600 mb-6" />
               <h3 className="text-xl font-black text-gray-900 tracking-tight mb-2">İçe Aktarılıyor</h3>
               <p className="text-gray-500 text-sm font-medium mb-6 text-center">
                 Lütfen bekleyin, ürünler sisteme aktarılıyor...
               </p>
               <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden mb-3 text-center relative">
                  <div
                    className="h-full bg-blue-600 rounded-full transition-all duration-300 relative overflow-hidden"
                    style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }}
                  >
                     <div className="absolute inset-0 bg-white/20 w-full h-full animate-[shimmer_1s_infinite] -skew-x-12" />
                  </div>
               </div>
               <div className="flex w-full justify-between items-center px-1">
                 <span className="text-xs text-blue-700 font-bold bg-blue-50 px-2 py-1 rounded-full border border-blue-100 shadow-sm">{importProgress.current} / {importProgress.total} satır</span>
                 <span className="text-sm font-black text-gray-900 tracking-tight">{Math.round((importProgress.current / importProgress.total) * 100)}%</span>
               </div>
            </div>
         </div>
      )}

      {!isReadOnly && showPricingModal && (
        <PricingSettingsModal
          onClose={() => setShowPricingModal(false)}
          onRefresh={loadProducts}
          products={products}
        />
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-text-main tracking-tight">Ürün Yönetimi</h2>
          <p className="text-xs lg:text-sm text-text-muted">{products.length} toplam ürün listeleniyor.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            ref={csvInputRef}
            onChange={handleFileSelect}
            accept=".csv"
            className="hidden"
          />
          {!isReadOnly && (
            <>
              <button
                onClick={() => setShowPricingModal(true)}
                className="px-4 h-11 border border-blue-200 bg-blue-50/50 rounded-xl text-xs font-bold text-blue-700 hover:bg-blue-100 transition-all flex items-center shadow-sm"
              >
                <Calculator className="w-4 h-4 mr-2" />
                Toplu Fiyat Yönetimi
              </button>
              <button
                onClick={() => csvInputRef.current?.click()}
                className="px-4 h-11 border border-border-color bg-white rounded-xl text-xs font-bold text-text-muted hover:text-primary hover:border-primary transition-all flex items-center shadow-sm"
              >
                <Upload className="w-4 h-4 mr-2" />
                Gelişmiş İçe Aktar
              </button>
            </>
          )}
          <button
            onClick={exportToCsv}
            className="px-4 h-11 border border-border-color bg-white rounded-xl text-xs font-bold text-text-muted hover:text-primary hover:border-primary transition-all flex items-center"
          >
            <Download className="w-4 h-4 mr-2" />
            CSV Dışa Aktar
          </button>
          <button
            onClick={() => {
              const data = [{
                'Ürün Kodu': 'URUN-001',
                'Ürün Adı': 'Örnek Ürün',
                'Malzeme': 'Aliminyum',
                'Seri': 'OYA',
                'Merkez Depo Stoğu': '100',
                'Satış Fiyatı': '250',
                'Barkod': '8690000000001',
                'Açıklama': 'Siyah kaliteli kaplama',
                'Ağırlık': '500',
                'Lokasyon': 'A-12-3',
                'Notlar': 'Acil sevkiyat ürünü'
              }];
              const csv = Papa.unparse(data);
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const link = document.createElement('a');
              const url = URL.createObjectURL(blob);
              link.setAttribute('href', url);
              link.setAttribute('download', `sablon.csv`);
              link.style.visibility = 'hidden';
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }}
            className="px-4 h-11 border border-dashed border-border-color bg-gray-50 rounded-xl text-[10px] font-bold text-text-muted hover:text-primary hover:border-primary transition-all flex items-center"
            title="Örnek CSV Formatını İndir"
          >
            <FileText className="w-4 h-4 mr-2" />
            Şablon İndir
          </button>
          {!isReadOnly && products.length > 0 && (
            <button
              onClick={() => {
                setDeleteAllInput("");
                setShowDeleteAllConfirm(true);
              }}
              className="px-4 h-11 border border-border-color bg-white rounded-xl text-xs font-bold text-rose-500 hover:bg-rose-50 hover:border-rose-200 transition-all flex items-center shadow-sm"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Tümünü Sil
            </button>
          )}
          {!isReadOnly && (
            <button
              onClick={onAddProduct}
              className="btn-primary px-6 py-2 leading-none flex items-center justify-center h-11 w-full sm:w-auto"
            >
              <Plus className="w-4 h-4 mr-2" />
              <span>Yeni Ürün Ekle</span>
            </button>
          )}
        </div>
      </div>

      {showDeleteAllConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowDeleteAllConfirm(false)}>
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="p-6 text-center">
              <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Trash2 className="w-8 h-8 text-rose-500" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">Tüm Ürünleri Sil</h3>
              <p className="text-gray-500 text-sm mb-6">
                Bu işlem geri alınamaz. Onaylamak için lütfen kutuya büyük harflerle <strong>SİL</strong> yazın.
              </p>
              <div className="mb-6">
                <input
                  type="text"
                  value={deleteAllInput}
                  onChange={(e) => setDeleteAllInput(e.target.value)}
                  placeholder="SİL yazın"
                  className="w-full text-center tracking-widest font-bold h-11 bg-gray-50 border border-gray-200 rounded-xl focus:border-rose-500 focus:ring-1 focus:ring-rose-500 outline-none"
                />
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={deleteAllProducts}
                  disabled={deletingAll || deleteAllInput !== "SİL"}
                  className="w-full py-3 bg-rose-500 hover:bg-rose-600 text-white rounded-xl font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deletingAll ? "Siliniyor..." : "Evet, Tümünü Seçili Sil"}
                </button>
                <button
                  onClick={() => setShowDeleteAllConfirm(false)}
                  disabled={deletingAll}
                  className="w-full py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold transition-colors disabled:opacity-50"
                >
                  İptal
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filters Bar */}
      <div className="card p-3 lg:p-4 flex flex-col lg:flex-row items-stretch lg:items-center gap-3 lg:gap-4 bg-white shadow-sm">
        <div className="relative flex-1 flex items-center">
          <Search className="w-4 h-4 text-text-muted absolute left-3.5" />
          <input
            type="text"
            placeholder="Ürün Ara Veya Barkod Okut..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-12 py-3 lg:py-2.5 bg-bg-main rounded-xl lg:rounded-lg text-sm border border-border-color focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none"
          />
          <button
            onClick={() => setShowScanner(true)}
            className="absolute right-2 p-1.5 text-text-muted hover:text-primary transition-colors hover:bg-bg-main rounded-md"
            title="Kamera ile Barkod Oku"
          >
            <ScanLine className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center space-x-2 lg:space-x-3">
                  <div className="flex-1 lg:flex-none flex items-center px-3 py-3 lg:py-2 bg-bg-main rounded-xl lg:rounded-lg border border-border-color">
            <Filter className="w-3.5 h-3.5 text-text-muted mr-2" />
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="bg-transparent text-xs lg:text-sm font-semibold outline-none cursor-pointer text-text-main w-full"
            >
              {categories.map(c => <option key={c} value={c}>{c === 'Hepsi' ? 'Tüm Malzemeler' : c}</option>)}
            </select>
          </div>

          <div className="flex bg-bg-main rounded-xl lg:rounded-lg p-1 border border-border-color">
            <button
              onClick={() => setViewMode('grid')}
              className={cn("p-2 lg:p-1.5 rounded-lg lg:rounded-md transition-all", viewMode === 'grid' ? "bg-white shadow-sm text-primary" : "text-text-muted")}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={cn("p-2 lg:p-1.5 rounded-lg lg:rounded-md transition-all", viewMode === 'table' ? "bg-white shadow-sm text-primary" : "text-text-muted")}
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4 lg:gap-6">
          {filteredProducts.map((p) => (
            <div
              key={p.id}
              onClick={() => onProductClick(p.id)}
              className="group card overflow-hidden hover:shadow-md transition-all cursor-pointer relative bg-white"
            >
              <div className="aspect-square bg-bg-main relative">
                 {p.cover_image ? (
                   <img src={p.cover_image} alt="" className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-500 p-4" referrerPolicy="no-referrer" />
                 ) : (
                   <div className="flex items-center justify-center w-full h-full">
                     <Package className="w-8 h-8 text-border-color" />
                   </div>
                 )}
                 <div className="absolute top-2 right-2 shadow-sm">
                   <StatusBadge status={p.status} />
                 </div>
              </div>
              <div className="p-4">
                <p className="text-[9px] lg:text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1">{p.category}</p>
                <h3 className="font-bold text-text-main text-sm group-hover:text-primary transition-colors line-clamp-1 h-5">{p.name || p.title}</h3>
                <p className="text-[10px] text-text-muted font-mono mt-1">{p.sku}</p>
                {p.product_series && (
                  <p className="text-[9px] font-black text-primary uppercase tracking-widest mt-2">
                    Seri: {p.product_series}
                  </p>
                )}

                <div className="mt-3 lg:mt-4 pt-3 lg:pt-4 border-t border-border-color flex items-center justify-between">
                   <p className="font-bold text-base text-text-main"><FormatAmount amount={p.sale_price || 0} /></p>
                   <div className="text-right">
                     <p className={cn(
                       "text-xs font-bold",
                       (p.total_stock || 0) < 10 ? "text-danger" : "text-success"
                     )}>
                       {p.total_stock || 0} Adet
                     </p>
                   </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[1000px]">
              <thead>
                <tr className="bg-bg-main text-[10px] uppercase tracking-widest text-text-muted font-extrabold border-b border-border-color">
                  <th className="px-4 py-5 w-12 text-center text-text-muted">#</th>
                  <th className="px-4 py-5">Ürün</th>
                  <th className="px-4 py-5 hidden xl:table-cell">Kategori</th>
                  <th className="px-4 py-5 hidden md:table-cell text-right">Alış USD</th>
                  <th className="px-4 py-5 hidden lg:table-cell text-right">Buffer TL</th>
                  <th className="px-4 py-5 font-bold text-blue-600 text-right">Satış TL</th>
                  <th className="px-4 py-5 hidden sm:table-cell text-center">Marj %</th>
                  <th className="px-4 py-5 text-center">Merkez Stok</th>
                  <th className="px-4 py-5 font-bold text-gray-700 text-right">Toplam Değer</th>
                  <th className="px-4 py-5 hidden sm:table-cell text-center">Durum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {filteredProducts.map((p, index) => {
                  const margin = p.sale_price && p.purchase_price_usd && p.exchange_rate_used
                    ? ((p.sale_price - (p.purchase_price_usd * p.exchange_rate_used)) / p.sale_price) * 100
                    : 0;
                  const stockValue = (p.total_stock || 0) * (p.sale_price || 0);
                  const bufferedCostTRY = (p.purchase_price_usd || 0) * (p.exchange_rate_used || 0) * (1 + (p.buffer_percentage || 0) / 100);

                  return (
                  <tr key={p.id} onClick={() => onProductClick(p.id)} className="hover:bg-bg-main cursor-pointer group transition-colors">
                    <td className="px-4 py-4 text-center text-xs font-bold text-text-muted/60">
                      {index + 1}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-lg bg-bg-main border border-border-color overflow-hidden p-1 flex items-center justify-center shrink-0">
                          {p.cover_image ? (
                            <img src={p.cover_image} alt="" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                          ) : (
                            <Package className="w-5 h-5 text-text-muted" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-bold text-text-main group-hover:text-primary transition-colors line-clamp-1">{p.name || p.title}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-[10px] text-text-muted font-mono uppercase tracking-tighter truncate">{p.sku}</p>
                            {p.product_series && (
                              <span className="text-[9px] font-black text-primary bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded uppercase tracking-widest">
                                {p.product_series}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 hidden xl:table-cell">
                      <div className="flex flex-col gap-1 items-start">
                        <span className="inline-block whitespace-normal break-words text-[10px] font-bold text-text-muted uppercase tracking-widest bg-bg-main px-2 py-1 rounded border border-border-color max-w-[150px]">
                          {p.category}
                        </span>
                        {p.pipe_size && p.pipe_size !== 'Bilinmiyor' && (
                          <span className="inline-block whitespace-normal break-words text-[10px] font-bold text-primary bg-blue-50 px-2 py-1 rounded border border-blue-100 max-w-[150px]">
                            Ölçü: {p.pipe_size}
                          </span>
                        )}
                        {p.product_series && (
                          <span className="inline-block whitespace-normal break-words text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-1 rounded border border-emerald-100 max-w-[150px]">
                            Seri: {p.product_series}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 hidden md:table-cell text-sm font-medium text-gray-500 text-right">
                      ${(p.purchase_price_usd || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-4 hidden lg:table-cell text-sm font-medium text-gray-500 text-right">
                      <FormatAmount align="right" amount={bufferedCostTRY} />
                    </td>
                    <td className="px-4 py-4 text-sm font-extrabold text-blue-600 text-right">
                      <FormatAmount align="right" amount={p.sale_price || 0} />
                    </td>
                    <td className="px-4 py-4 hidden sm:table-cell text-center">
                      <span className={cn(
                        "text-[11px] font-bold px-2 py-1 rounded-md",
                        margin > 0 ? "bg-green-100 text-green-700" : margin < 0 ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"
                      )}>
                        {margin > 0 ? '+' : ''}{margin.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <span className={cn(
                        "font-bold text-sm px-2 py-1 rounded-lg",
                        (p.total_stock || 0) < 10 ? "text-danger bg-red-50" : "text-text-main bg-bg-main"
                      )}>
                        {p.total_stock}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-sm font-bold text-gray-700 text-right">
                      <FormatAmount align="right" amount={stockValue} />
                    </td>
                    <td className="px-4 py-4 hidden sm:table-cell text-center"><StatusBadge status={p.status} /></td>
                  </tr>
                )})}
              </tbody>
              <tfoot className="bg-blue-50/50 border-t-2 border-blue-100">
                <tr>
                  <td colSpan={2} className="px-4 py-4 text-right font-bold text-gray-700">Genel Toplam:</td>
                  <td className="px-4 py-4 hidden xl:table-cell"></td>
                  <td className="px-4 py-4 hidden md:table-cell"></td>
                  <td className="px-4 py-4 hidden lg:table-cell"></td>
                  <td className="px-4 py-4 text-right"></td>
                  <td className="px-4 py-4 hidden sm:table-cell"></td>
                  <td className="px-4 py-4 text-center font-black text-gray-900 text-sm">
                    {filteredProducts.reduce((sum, p) => sum + (p.total_stock || 0), 0)}
                  </td>
                  <td className="px-4 py-4 text-right font-black text-blue-700 text-sm">
                    <FormatAmount align="right" amount={filteredProducts.reduce((sum, p) => sum + ((p.total_stock || 0) * (p.sale_price || 0)), 0)} />
                  </td>
                  <td className="px-4 py-4 hidden sm:table-cell"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {filteredProducts.length === 0 && (
        <div className="py-24 text-center bg-white rounded-3xl border-2 border-dashed border-border-color">
          <Package className="w-16 h-16 text-border-color mx-auto mb-4" />
          <h3 className="text-xl font-bold text-text-main">Ürün bulunamadı</h3>
          <p className="text-text-muted mt-1">Arama kriterlerinizi değiştirmeyi deneyin.</p>
        </div>
      )}

      {/* CSV Mapping Modal */}
      {showMappingModal && (
        <div className="fixed inset-0 bg-[#0F172A]/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden animate-in zoom-in duration-300">
             <div className="p-8 border-b border-border-color bg-gray-50 flex items-center justify-between">
                <div>
                   <h3 className="text-xl font-black text-[#0F172A] tracking-tight">CSV Sütun Eşleştirme</h3>
                   <p className="text-sm text-text-muted mt-1">Dosyanızdaki sütunları sistem alanlarıyla eşleştirin.</p>
                </div>
                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center border border-border-color shadow-sm">
                   <Upload className="w-6 h-6 text-primary" />
                </div>
             </div>

             <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-4">
                   {Object.entries(mapping).map(([field, selectedHeader]) => (
                     <div key={field} className="space-y-1">
                        <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest block ml-1">
                          {field === 'sku' && 'Ürün Kodu (Zorunlu)'}
                          {field === 'name' && 'Ürün Adı (Zorunlu)'}
                          {field === 'category' && 'Malzeme / Kategori'}
                          {field === 'stock' && 'Merkez Depo Stoğu'}
                          {field === 'price' && 'Alış Fiyatı (USD)'}
                          {field === 'barcode' && 'Barkod'}
                          {field === 'description' && 'Açıklama'}
                          {field === 'weight' && 'Ağırlık (Gram)'}
                          {field === 'location' && 'Raf Lokasyonu'}
                          {field === 'notes' && 'Dahili Notlar'}
                          {field === 'pipe_size' && 'Boru Ölçüsü (Önerilen)'}
                          {field === 'series' && 'Seri'}
                        </label>
                        <div className="relative">
                           <select
                             value={selectedHeader}
                             onChange={(e) => setMapping(prev => ({ ...prev, [field]: e.target.value }))}
                             className="w-full pl-3 pr-10 py-2.5 bg-bg-main border border-border-color rounded-xl text-sm font-bold appearance-none hover:border-primary transition-colors focus:ring-2 focus:ring-primary/20 outline-none"
                           >
                             <option value="">Seçilmedi</option>
                             {csvHeaders.map(h => (
                               <option key={h} value={h}>{h}</option>
                             ))}
                           </select>
                           <ChevronDown className="w-4 h-4 text-text-muted absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                     </div>
                   ))}
                </div>

                <div className="bg-blue-50 border border-blue-100 p-4 rounded-2xl">
                   <p className="text-xs text-blue-700 leading-relaxed font-medium">
                     <strong>İpucu:</strong> Sütun başlıklarınız Ürün Kodu, Ürün Adı vb. ise otomatik eşleştirme yapılır. İlk 5 satır örnek olarak okunur.
                   </p>
                </div>
             </div>

             <div className="p-8 bg-gray-50 border-t border-border-color flex items-center justify-between">
                <button
                  onClick={() => setShowMappingModal(false)}
                  className="px-6 h-12 text-sm font-bold text-text-muted hover:text-[#0F172A] transition-colors"
                >
                  Vazgeç
                </button>
                <button
                  onClick={executeImport}
                  disabled={deletingAll}
                  className="px-8 h-12 bg-[#0F172A] text-white rounded-xl font-bold text-sm shadow-xl hover:scale-105 transition-all disabled:opacity-50"
                >
                  {deletingAll ? (
                    <div className="flex items-center">
                       <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" />
                       İçe Aktarılıyor...
                    </div>
                  ) : 'İçe Aktarımı Başlat'}
                </button>
             </div>
          </div>
        </div>
      )}

      {showScanner && (
        <BarcodeScannerModal
          onClose={() => setShowScanner(false)}
          onScan={(barcode) => {
            const matchedProduct = products.find(p => p.barcode === barcode);
            if (matchedProduct) {
              setShowScanner(false);
              onProductClick(matchedProduct.id);
            } else {
               setSearch(barcode);
               setShowScanner(false);
            }
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles = {
    'Active': 'bg-green-50/50 text-success border-green-100',
    'Passive': 'bg-bg-main text-text-muted border-border-color',
    'Out of stock': 'bg-red-50/50 text-danger border-red-100'
  };
  const labels = {
    'Active': 'Aktif',
    'Passive': 'Pasif',
    'Out of stock': 'Tükendi'
  };
  return (
    <span className={cn(
      "px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-tight border",
      styles[status as keyof typeof styles] || styles.Passive
    )}>
      {labels[status as keyof typeof labels] || status}
    </span>
  );
}

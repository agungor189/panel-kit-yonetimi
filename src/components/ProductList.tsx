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
  Images,
  Trash2,
  FileText,
  ScanLine,
  SlidersHorizontal,
  X
} from 'lucide-react';
import { api } from '../lib/api';
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

const PRODUCT_KIND_STYLE: Record<string, string> = {
  assembly: "bg-blue-50 text-blue-700 border-blue-100",
  component: "bg-amber-50 text-amber-700 border-amber-100",
  accessory: "bg-violet-50 text-violet-700 border-violet-100",
  normal: "bg-slate-50 text-slate-600 border-slate-200",
};

function getProductKind(product: Product) {
  if (product.stock_source === 'bom' || product.product_type === 'assembly') {
    return { key: 'assembly', label: 'Assembly' };
  }
  if (product.product_type === 'component') {
    return { key: 'component', label: 'Component' };
  }
  if (product.product_type === 'accessory') {
    return { key: 'accessory', label: 'Accessory' };
  }
  return { key: 'normal', label: 'Normal ürün' };
}

function ProductKindBadge({ product }: { product: Product }) {
  const kind = getProductKind(product);
  return (
    <span className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest",
      PRODUCT_KIND_STYLE[kind.key] || PRODUCT_KIND_STYLE.normal
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

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  labels = {},
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  allLabel: string;
  labels?: Record<string, string>;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 ml-1 block text-[10px] font-black uppercase tracking-widest text-text-muted">
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 w-full appearance-none rounded-xl border border-border-color bg-bg-main px-3 pr-9 text-sm font-bold text-text-main outline-none transition-all hover:border-primary focus:border-primary focus:ring-2 focus:ring-primary/20"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option === 'Hepsi' ? allLabel : labels[option] || option}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
      </div>
    </label>
  );
}

interface ProductListProps {
  onAddProduct: () => void;
  onProductClick: (id: string) => void;
}

type ProductCsvImportReport = {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  rows: number;
  products_created: number;
  products_updated: number;
  bom_parents: number;
  bom_lines_created: number;
  bom_lines_updated: number;
  bom_lines_removed: number;
  matched_columns: Array<{ csv_header: string; product_field: string; label: string }>;
  unknown_columns: string[];
  validation_errors: Array<{ row?: number; field?: string; code: string; message: string }>;
  warnings: string[];
};

type BulkImagePreviewItem = {
  file: File;
  sku: string;
  matchedSku?: string;
  status: 'matched' | 'missing' | 'duplicate' | 'invalid';
  message: string;
};

type BulkImageUploadReport = {
  total: number;
  uploaded: number;
  skipped: number;
  results: Array<{
    original_filename: string;
    sku: string;
    matched_sku?: string;
    status: 'uploaded' | 'skipped';
    code: string;
    message: string;
    image_path?: string;
  }>;
};

export default function ProductList({ onAddProduct, onProductClick }: ProductListProps) {
  const { isReadOnly } = useAuth();
  const { FormatAmount, activeRate, viewCurrency } = useCurrency();
  const [products, setProducts] = useState<Product[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('table');
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('Hepsi');
  const [filterProfileType, setFilterProfileType] = useState('Hepsi');
  const [filterSize, setFilterSize] = useState('Hepsi');
  const [filterStatus, setFilterStatus] = useState('Hepsi');
  const [sortKey, setSortKey] = useState('name_asc');
  const [showScanner, setShowScanner] = useState(false);
  const [nameLanguage, setNameLanguage] = useState<'tr' | 'en'>(() =>
    localStorage.getItem('products.nameLanguage') === 'en' ? 'en' : 'tr'
  );

  useEffect(() => {
    localStorage.setItem('products.nameLanguage', nameLanguage);
  }, [nameLanguage]);

  useEffect(() => {
    loadProducts();
  }, []);

  const loadProducts = async () => {
    try {
      const data = await api.get('/products?include_bom=1&include_components=1');
      setProducts(data);
    } catch (err) {
      console.error(err);
    }
  };

  const normalizeFilterValue = (value: unknown) => String(value || '').trim();
  const profileTypeOf = (product: Product) => normalizeFilterValue((product as any).normalized_tube_type || product.form_code || product.tube_type_code || product.model);
  const sizeOf = (product: Product) => normalizeFilterValue((product as any).normalized_pipe_size || product.pipe_size || product.size || product.size_code);
  const materialOf = (product: Product) => normalizeFilterValue(product.category || product.material || (product as any).normalized_material);
  const productName = (product: Product) => nameLanguage === 'en'
    ? (product.name_en || product.name_tr || product.name || product.title)
    : (product.name_tr || product.name_en || product.name || product.title);
  const productWeight = (product: Product) => Number(product.weight_grams ?? product.weight ?? 0);
  const purchaseUsd = (product: Product) => Number(product.purchase_price_usd || 0);
  const purchaseTry = (product: Product) => Number(product.purchase_cost || 0);
  const saleTry = (product: Product) => Number(product.sale_price || 0);
  const stockQty = (product: Product) => Number(product.total_stock ?? product.central_stock ?? 0);
  const sortedUnique = (values: string[]) => [...new Set(values.map(normalizeFilterValue).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'tr'));
  const byText = (a: string, b: string) => a.localeCompare(b, 'tr', { numeric: true, sensitivity: 'base' });

  const filteredProducts = products.filter(p => {
    const searchLower = search.toLowerCase();
    const matchesSearch =
      (p.name_tr?.toLowerCase().includes(searchLower)) ||
      (p.name_en?.toLowerCase().includes(searchLower)) ||
      (p.sku?.toLowerCase().includes(searchLower)) ||
      (p.supplier_code?.toLowerCase().includes(searchLower)) ||
      (p.barcode?.toLowerCase().includes(searchLower));
    const matchesCategory = filterCategory === 'Hepsi' || materialOf(p) === filterCategory;
    const matchesProfileType = filterProfileType === 'Hepsi' || profileTypeOf(p) === filterProfileType;
    const matchesSize = filterSize === 'Hepsi' || sizeOf(p) === filterSize;
    const matchesStatus = filterStatus === 'Hepsi' || p.status === filterStatus;
    return matchesSearch && matchesCategory && matchesProfileType && matchesSize && matchesStatus;
  }).sort((a, b) => {
    switch (sortKey) {
      case 'sku_asc': return byText(a.sku || '', b.sku || '');
      case 'material_asc': return byText(materialOf(a), materialOf(b));
      case 'profile_asc': return byText(profileTypeOf(a), profileTypeOf(b)) || byText(sizeOf(a), sizeOf(b));
      case 'size_asc': return byText(sizeOf(a), sizeOf(b)) || byText(profileTypeOf(a), profileTypeOf(b));
      case 'weight_desc': return productWeight(b) - productWeight(a);
      case 'weight_asc': return productWeight(a) - productWeight(b);
      case 'purchase_usd_desc': return purchaseUsd(b) - purchaseUsd(a);
      case 'purchase_usd_asc': return purchaseUsd(a) - purchaseUsd(b);
      case 'purchase_try_desc': return purchaseTry(b) - purchaseTry(a);
      case 'purchase_try_asc': return purchaseTry(a) - purchaseTry(b);
      case 'sale_desc': return saleTry(b) - saleTry(a);
      case 'sale_asc': return saleTry(a) - saleTry(b);
      case 'stock_desc': return stockQty(b) - stockQty(a);
      case 'stock_asc': return stockQty(a) - stockQty(b);
      case 'value_desc': return (stockQty(b) * saleTry(b)) - (stockQty(a) * saleTry(a));
      case 'name_asc':
      default: return byText(productName(a), productName(b));
    }
  });

  const categories = ['Hepsi', ...sortedUnique(products.map(materialOf))];
  const profileTypes = ['Hepsi', ...sortedUnique(products.map(profileTypeOf))];
  const profileSizes = ['Hepsi', ...sortedUnique(products.map(sizeOf))];
  const hasActiveFilters = Boolean(search) || filterCategory !== 'Hepsi' || filterProfileType !== 'Hepsi' || filterSize !== 'Hepsi' || filterStatus !== 'Hepsi' || sortKey !== 'name_asc';
  const clearFilters = () => {
    setSearch('');
    setFilterCategory('Hepsi');
    setFilterProfileType('Hepsi');
    setFilterSize('Hepsi');
    setFilterStatus('Hepsi');
    setSortKey('name_asc');
  };
  const csvInputRef = useRef<HTMLInputElement>(null);
  const bulkImageInputRef = useRef<HTMLInputElement>(null);

  // CSV import preview/report state. Mapping itself lives in shared/productCsvMapping.ts.
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [csvData, setCsvData] = useState<any[]>([]);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvFileName, setCsvFileName] = useState('products.csv');
  const [importReport, setImportReport] = useState<ProductCsvImportReport | null>(null);
  const [importProgress, setImportProgress] = useState<{current: number, total: number} | null>(null);
  const [showBulkImageModal, setShowBulkImageModal] = useState(false);
  const [bulkImagePreview, setBulkImagePreview] = useState<BulkImagePreviewItem[]>([]);
  const [bulkImageReport, setBulkImageReport] = useState<BulkImageUploadReport | null>(null);
  const [bulkImageUploading, setBulkImageUploading] = useState(false);

  const closeBulkImageModal = () => {
    if (bulkImageUploading) return;
    setShowBulkImageModal(false);
    setBulkImagePreview([]);
    setBulkImageReport(null);
    if (bulkImageInputRef.current) bulkImageInputRef.current.value = '';
  };

  const handleBulkImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (isReadOnly) return;
    const files = Array.from(event.target.files || []);
    if (files.length === 0) return;

    const mimeByExtension: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
    };
    const productBySku = new Map(products.map((product) => [String(product.sku || '').toLocaleUpperCase('en-US'), product]));
    const seenSkus = new Set<string>();
    const preview = files.slice(0, 100).map((file): BulkImagePreviewItem => {
      const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
      const sku = extension ? file.name.slice(0, -(extension.length + 1)).trim() : file.name.trim();
      const expectedMime = mimeByExtension[extension];
      if (!expectedMime || file.type !== expectedMime || file.size > 8 * 1024 * 1024 || !sku) {
        return { file, sku, status: 'invalid', message: 'Geçersiz dosya tipi, MIME veya 8 MB dosya sınırı.' };
      }

      const product = productBySku.get(sku.toLocaleUpperCase('en-US'));
      if (!product) return { file, sku, status: 'missing', message: 'Ürün bulunamadı.' };
      const productKey = String(product.id);
      if (seenSkus.has(productKey)) {
        return { file, sku, matchedSku: product.sku, status: 'duplicate', message: 'Bu SKU için bir dosya zaten seçildi.' };
      }
      seenSkus.add(productKey);
      return { file, sku, matchedSku: product.sku, status: 'matched', message: 'Ürün eşleşti.' };
    });

    setBulkImagePreview(preview);
    setBulkImageReport(null);
    setShowBulkImageModal(true);
    if (files.length > 100) toast.error('Tek seferde en fazla 100 görsel seçilebilir.');
  };

  const uploadBulkImages = async () => {
    if (isReadOnly || bulkImageUploading || bulkImagePreview.length === 0) return;
    if (bulkImagePreview.some((item) => item.status === 'invalid')) {
      toast.error('Geçersiz dosyaları seçimden çıkarın.');
      return;
    }

    const formData = new FormData();
    bulkImagePreview.forEach((item) => formData.append('images', item.file));
    try {
      setBulkImageUploading(true);
      const report = await api.upload('/products/images/bulk', formData) as BulkImageUploadReport;
      setBulkImageReport(report);
      toast.success(`${report.uploaded} görsel yüklendi${report.skipped ? `, ${report.skipped} dosya atlandı` : ''}.`);
      await loadProducts();
    } catch (error: any) {
      toast.error(error.message || 'Toplu görsel yükleme başarısız');
    } finally {
      setBulkImageUploading(false);
    }
  };

  const exportToCsv = () => {
    const data = filteredProducts.map((p, index) => ({
      'Sıra No': index + 1,
      'Ürün Kodu': p.sku,
      'Tedarik NO': p.supplier_code || '',
      'Malzeme': p.category,
      'Seri': p.product_series || '',
      'Isim - TR': p.name_tr || '',
      'İsim - EN': p.name_en || '',
      'Boru Ölçüsü': p.pipe_size || '',
      'Merkez Depo Stoğu': p.total_stock || 0,
      'Satış Fiyatı': p.sale_price,
      'Barkod': p.barcode || '',
      'Açıklama': p.description || '',
      'Parça Ağırlığı': p.weight_grams ?? p.weight ?? 0,
      'Toplama Lokasyonu': p.warehouse_location || '',
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
      complete: async (results) => {
        const { data, meta } = results;
        if (data.length === 0) return;
        if (results.errors.length > 0) {
          toast.error(`CSV okunamadı: ${results.errors[0].message}`);
          return;
        }
        const headers = meta.fields || [];
        setCsvData(data);
        setCsvHeaders(headers);
        setCsvFileName(file.name);
        setImportProgress({ current: 0, total: data.length });
        try {
          const report = await api.post('/products/import', { rows: data, headers, dry_run: true, source_name: file.name });
          setImportReport(report);
          setShowMappingModal(true);
        } catch (error: any) {
          toast.error(error.message || 'CSV önizlemesi oluşturulamadı');
        } finally {
          setImportProgress(null);
        }
      }
    });
  };

  const executeImport = async () => {
    if (!importReport || importReport.validation_errors.length > 0) return;
    setDeletingAll(true);
    setImportProgress({ current: 0, total: csvData.length });
    try {
      const report = await api.post('/products/import', { rows: csvData, headers: csvHeaders, dry_run: false, source_name: csvFileName });
      setImportReport(report);
      toast.success(`${report.products_created} ürün oluşturuldu, ${report.products_updated} ürün güncellendi`);
      await loadProducts();
    } catch (error: any) {
      toast.error(error.message || 'İçe aktarma başarısız');
    } finally {
      setDeletingAll(false);
      setImportProgress(null);
      if (csvInputRef.current) csvInputRef.current.value = '';
    }
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
          <input
            type="file"
            ref={bulkImageInputRef}
            onChange={handleBulkImageSelect}
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            multiple
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
              <button
                onClick={() => bulkImageInputRef.current?.click()}
                className="px-4 h-11 border border-border-color bg-white rounded-xl text-xs font-bold text-text-muted hover:text-primary hover:border-primary transition-all flex items-center shadow-sm"
              >
                <Images className="w-4 h-4 mr-2" />
                Toplu Görsel Yükle
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
                'SKU': 'URUN-001',
                'Tedarik NO': 'TED-001',
                'Isim - TR': 'Örnek Ürün',
                'İsim - EN': 'Sample Product',
                'Malzeme': 'Aliminyum',
                'Profil Tipi': 'Yuvarlak',
                'Ölçü': '25 mm',
                'Toplam Adet': '100',
                'Parça Ağırlığı': '500',
                'Alış Fiyatı': '$2.50',
                'TÜR': 'simple',
                'BOM': '',
                'Açıklama': 'Siyah kaliteli kaplama',
                'Toplama Lokasyonu': 'A-12-3',
                'Rezerv Lokasyon': 'R-01; R-02',
                'Kutu sayısı': '2',
                'Kutu içi adet': '50',
                'Kutu Ağırlığı': '25',
                'Toplam Ağırlık': '50'
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
      <div className="card bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative flex min-w-[260px] flex-1 items-center">
              <Search className="absolute left-3.5 h-4 w-4 text-text-muted" />
              <input
                type="text"
                placeholder="TR/EN ad, SKU, tedarikçi kodu veya barkod ara..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-border-color bg-bg-main py-3 pl-10 pr-12 text-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              <button
                onClick={() => setShowScanner(true)}
                className="absolute right-2 rounded-md p-1.5 text-text-muted transition-colors hover:bg-white hover:text-primary"
                title="Kamera ile barkod oku"
              >
                <ScanLine className="h-5 w-5" />
              </button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-color bg-bg-main px-3 py-2 xl:w-auto">
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-text-muted">
                <SlidersHorizontal className="h-4 w-4" />
                Filtreler
              </div>
              <div className="rounded-full bg-white px-3 py-1 text-xs font-bold text-primary shadow-sm">
                {filteredProducts.length} / {products.length} ürün
              </div>
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1 rounded-lg border border-border-color bg-white px-3 py-1.5 text-xs font-bold text-text-muted transition-colors hover:border-primary hover:text-primary"
                >
                  <X className="h-3.5 w-3.5" />
                  Temizle
                </button>
              )}
            </div>

            <div className="flex w-fit items-center rounded-xl border border-border-color bg-bg-main p-1" aria-label="Ürün adı dili">
              {(['tr', 'en'] as const).map((language) => (
                <button
                  key={language}
                  type="button"
                  onClick={() => setNameLanguage(language)}
                  className={cn(
                    "rounded-lg px-3 py-2 text-xs font-black uppercase transition-all",
                    nameLanguage === language ? "bg-white text-primary shadow-sm" : "text-text-muted"
                  )}
                >
                  {language}
                </button>
              ))}
            </div>

            <div className="flex w-fit rounded-xl border border-border-color bg-bg-main p-1">
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

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <FilterSelect
              label="Malzeme"
              value={filterCategory}
              onChange={setFilterCategory}
              options={categories}
              allLabel="Tüm malzemeler"
            />
            <FilterSelect
              label="Profil türü"
              value={filterProfileType}
              onChange={setFilterProfileType}
              options={profileTypes}
              allLabel="Tüm profil türleri"
            />
            <FilterSelect
              label="Ölçü"
              value={filterSize}
              onChange={setFilterSize}
              options={profileSizes}
              allLabel="Tüm ölçüler"
            />
            <FilterSelect
              label="Durum"
              value={filterStatus}
              onChange={setFilterStatus}
              options={['Hepsi', 'Active', 'Passive', 'Out of stock']}
              allLabel="Tüm durumlar"
              labels={{ Active: 'Aktif', Passive: 'Pasif', 'Out of stock': 'Stok yok' }}
            />
            <FilterSelect
              label="Sıralama"
              value={sortKey}
              onChange={setSortKey}
              options={[
                'name_asc',
                'sku_asc',
                'material_asc',
                'profile_asc',
                'size_asc',
                'weight_desc',
                'weight_asc',
                'purchase_usd_desc',
                'purchase_usd_asc',
                'purchase_try_desc',
                'purchase_try_asc',
                'sale_desc',
                'sale_asc',
                'stock_desc',
                'stock_asc',
                'value_desc',
              ]}
              allLabel="Ada göre"
              labels={{
                name_asc: 'Ada göre A-Z',
                sku_asc: 'Stok koduna göre',
                material_asc: 'Malzemeye göre',
                profile_asc: 'Profil türüne göre',
                size_asc: 'Ölçüye göre',
                weight_desc: 'Ağırlık yüksekten',
                weight_asc: 'Ağırlık düşükten',
                purchase_usd_desc: 'Alış USD yüksekten',
                purchase_usd_asc: 'Alış USD düşükten',
                purchase_try_desc: 'Alış TL yüksekten',
                purchase_try_asc: 'Alış TL düşükten',
                sale_desc: 'Satış yüksekten',
                sale_asc: 'Satış düşükten',
                stock_desc: 'Stok yüksekten',
                stock_asc: 'Stok düşükten',
                value_desc: 'Toplam değer yüksekten',
              }}
            />
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
                <h3 className="font-bold text-text-main text-sm group-hover:text-primary transition-colors line-clamp-1 h-5">{productName(p)}</h3>
                <p className="text-[10px] text-text-muted font-mono mt-1">{p.sku}</p>
                {p.product_series && (
                  <p className="text-[9px] font-black text-primary uppercase tracking-widest mt-2">
                    Seri: {p.product_series}
                  </p>
                )}
                <div className="mt-2">
                  <ProductKindBadge product={p} />
                </div>

                <div className="mt-3 lg:mt-4 pt-3 lg:pt-4 border-t border-border-color flex items-center justify-between">
                   <p className="font-bold text-base text-text-main"><FormatAmount amount={p.sale_price || 0} /></p>
                   <div className="text-right">
                     {p.stock_source === 'bom' ? (
                       <div className="space-y-0.5">
                         <p className={cn("text-xs font-black", (p.total_stock || 0) < 10 ? "text-danger" : "text-success")}>
                           Üretilebilir {p.total_stock || 0}
                         </p>
                         <p className="text-[10px] font-bold text-text-muted">Fiziksel {p.physical_stock ?? p.central_stock ?? 0}</p>
                         <p className="text-[9px] font-bold text-amber-600 truncate max-w-[120px]">
                           Darboğaz {getBottleneckComponent(p)?.sku || '—'}
                         </p>
                       </div>
                     ) : (
                       <p className={cn(
                         "text-xs font-bold",
                         (p.total_stock || 0) < 10 ? "text-danger" : "text-success"
                       )}>
                         {p.total_stock || 0} Adet
                       </p>
                     )}
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
                          <p className="text-sm font-bold text-text-main group-hover:text-primary transition-colors line-clamp-1">{productName(p)}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-[10px] text-text-muted font-mono uppercase tracking-tighter truncate">{p.sku}</p>
                            <ProductKindBadge product={p} />
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
                      {p.stock_source === 'bom' ? (
                        <div className="inline-flex flex-col items-end gap-1 text-right">
                          <span className={cn(
                            "font-black text-sm px-2 py-1 rounded-lg",
                            (p.total_stock || 0) < 10 ? "text-danger bg-red-50" : "text-blue-700 bg-blue-50"
                          )}>
                            Üretilebilir: {p.total_stock || 0}
                          </span>
                          <span className="text-[10px] font-bold text-text-muted">
                            Fiziksel final: {p.physical_stock ?? p.central_stock ?? 0}
                          </span>
                          <span className="text-[10px] font-bold text-amber-600">
                            Darboğaz: {getBottleneckComponent(p)?.sku || '—'}
                          </span>
                        </div>
                      ) : (
                        <span className={cn(
                          "font-bold text-sm px-2 py-1 rounded-lg",
                          (p.total_stock || 0) < 10 ? "text-danger bg-red-50" : "text-text-main bg-bg-main"
                        )}>
                          {p.total_stock}
                        </span>
                      )}
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

      {/* CSV mapping and validation report */}
      {showMappingModal && importReport && (
        <div className="fixed inset-0 bg-[#0F172A]/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-3xl shadow-2xl overflow-hidden animate-in zoom-in duration-300">
             <div className="p-8 border-b border-border-color bg-gray-50 flex items-center justify-between">
                <div>
                   <h3 className="text-xl font-black text-[#0F172A] tracking-tight">CSV İçe Aktarma Raporu</h3>
                   <p className="text-sm text-text-muted mt-1">{csvFileName} · {importReport.rows} satır · {importReport.mode === 'dry-run' ? 'önizleme' : 'uygulandı'}</p>
                </div>
                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center border border-border-color shadow-sm">
                   <Upload className="w-6 h-6 text-primary" />
                </div>
             </div>

             <div className="p-8 space-y-6 max-h-[65vh] overflow-y-auto">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {[
                    ['Oluşturulacak', importReport.products_created],
                    ['Güncellenecek', importReport.products_updated],
                    ['BOM üst ürünü', importReport.bom_parents],
                    ['Yeni BOM satırı', importReport.bom_lines_created],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-2xl border border-border-color bg-bg-main p-4">
                      <p className="text-[10px] font-black uppercase tracking-widest text-text-muted">{label}</p>
                      <p className="mt-1 text-2xl font-black text-text-main">{value}</p>
                    </div>
                  ))}
                </div>

                <section>
                  <h4 className="mb-2 text-xs font-black uppercase tracking-widest text-text-muted">Eşleşen kolonlar</h4>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {importReport.matched_columns.map((column) => (
                      <div key={`${column.csv_header}-${column.product_field}`} className="flex items-center justify-between gap-3 rounded-xl border border-border-color px-3 py-2 text-xs">
                        <span className="font-bold text-text-main">{column.csv_header}</span>
                        <span className="text-right font-mono text-primary">{column.product_field}</span>
                      </div>
                    ))}
                  </div>
                </section>

                {importReport.unknown_columns.length > 0 && (
                  <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                    <h4 className="text-xs font-black uppercase tracking-widest text-amber-800">Tanınmayan kolonlar</h4>
                    <p className="mt-2 text-sm text-amber-900">{importReport.unknown_columns.join(', ')}</p>
                  </section>
                )}

                {importReport.validation_errors.length > 0 ? (
                  <section className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                    <h4 className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-rose-800">
                      <AlertTriangle className="h-4 w-4" /> Validation hataları ({importReport.validation_errors.length})
                    </h4>
                    <ul className="mt-3 space-y-2 text-sm text-rose-900">
                      {importReport.validation_errors.slice(0, 50).map((error, index) => (
                        <li key={`${error.code}-${error.row || 0}-${index}`}>• {error.row ? `Satır ${error.row}: ` : ''}{error.message}</li>
                      ))}
                    </ul>
                  </section>
                ) : (
                  <div className="flex items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-800">
                    <CheckCircle className="h-5 w-5" /> Doğrulama tamamlandı. İçe aktarma uygulanabilir.
                  </div>
                )}

                {importReport.applied && (
                  <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
                    {importReport.products_created} ürün oluşturuldu, {importReport.products_updated} ürün güncellendi; {importReport.bom_lines_created} BOM satırı oluşturuldu ve {importReport.bom_lines_updated} BOM satırı güncellendi.
                  </div>
                )}
             </div>

             <div className="p-8 bg-gray-50 border-t border-border-color flex items-center justify-between">
                <button
                  onClick={() => setShowMappingModal(false)}
                  className="px-6 h-12 text-sm font-bold text-text-muted hover:text-[#0F172A] transition-colors"
                >
                  {importReport.applied ? 'Kapat' : 'Vazgeç'}
                </button>
                {!importReport.applied && (
                  <button
                    onClick={executeImport}
                    disabled={deletingAll || importReport.validation_errors.length > 0}
                    className="px-8 h-12 bg-[#0F172A] text-white rounded-xl font-bold text-sm shadow-xl hover:scale-105 transition-all disabled:opacity-50 disabled:hover:scale-100"
                  >
                    {deletingAll ? 'İçe Aktarılıyor...' : 'İçe Aktarımı Uygula'}
                  </button>
                )}
             </div>
          </div>
        </div>
      )}

      {showBulkImageModal && (
        <div className="fixed inset-0 z-[180] flex items-center justify-center bg-[#0F172A]/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-color bg-gray-50 p-7">
              <div>
                <h3 className="text-xl font-black text-[#0F172A]">Toplu Ürün Görseli Yükle</h3>
                <p className="mt-1 text-sm text-text-muted">Dosya adı, uzantı çıkarıldıktan sonra SKU ile eşleştirilir.</p>
              </div>
              <Images className="h-7 w-7 text-primary" />
            </div>

            <div className="max-h-[60vh] space-y-4 overflow-y-auto p-7">
              {bulkImageReport && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    ['Toplam', bulkImageReport.total],
                    ['Yüklendi', bulkImageReport.uploaded],
                    ['Atlandı', bulkImageReport.skipped],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-2xl border border-border-color bg-bg-main p-4 text-center">
                      <p className="text-[10px] font-black uppercase tracking-widest text-text-muted">{label}</p>
                      <p className="mt-1 text-2xl font-black text-text-main">{value}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className="divide-y divide-border-color overflow-hidden rounded-2xl border border-border-color">
                {(bulkImageReport ? bulkImageReport.results : bulkImagePreview).map((item: any, index) => {
                  const uploaded = item.status === 'uploaded' || item.status === 'matched';
                  const filename = item.original_filename || item.file?.name;
                  const matchedSku = item.matched_sku || item.matchedSku;
                  return (
                    <div key={`${filename}-${index}`} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-bold text-text-main">{filename}</p>
                        <p className="mt-0.5 text-xs text-text-muted">
                          {item.sku || '—'}{matchedSku ? ` → ${matchedSku}` : ''} · {item.message}
                        </p>
                      </div>
                      <span className={cn(
                        "shrink-0 rounded-full px-3 py-1 text-xs font-black",
                        uploaded ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                      )}>
                        {uploaded ? '✓' : '⚠'}
                      </span>
                    </div>
                  );
                })}
              </div>

              {!bulkImageReport && bulkImagePreview.some((item) => item.status === 'invalid') && (
                <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">
                  Geçersiz dosya bulundu. Yüklemeye devam etmek için dosya seçimini düzeltin.
                </p>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-border-color bg-gray-50 p-7">
              <button onClick={closeBulkImageModal} disabled={bulkImageUploading} className="px-5 py-3 text-sm font-bold text-text-muted disabled:opacity-50">
                {bulkImageReport ? 'Kapat' : 'Vazgeç'}
              </button>
              {!bulkImageReport && (
                <button
                  onClick={uploadBulkImages}
                  disabled={bulkImageUploading || !bulkImagePreview.some((item) => item.status === 'matched') || bulkImagePreview.some((item) => item.status === 'invalid')}
                  className="flex h-12 items-center rounded-xl bg-[#0F172A] px-7 text-sm font-bold text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {bulkImageUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                  {bulkImageUploading ? 'Yükleniyor...' : 'Görselleri Yükle'}
                </button>
              )}
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

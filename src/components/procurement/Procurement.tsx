import { ProcurementImport } from './ProcurementImport';
import { PurchaseProductTree } from './PurchaseProductTree';
import { DraftCostsPanel, parseVatRate } from './DraftCostsPanel';
import { useEffect, useMemo, useState } from 'react';
import { FileUp, Plus, RefreshCw, ShoppingBasket, Truck } from 'lucide-react';
import Papa from 'papaparse';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { Badge, Button, Card, Input, PageHeader, Select } from '../ui';

type Tab = 'overview' | 'orders' | 'costs' | 'suppliers';
type Supplier = { id: string; name: string; defaultCurrency: string; taxIdentifier?: string };
type Product = { id: string; sku: string; title?: string; name?: string; catalog_type?: string };
type Packing = {
  sku: string; supplierNo: string; productType: 'simple' | 'component' | 'assembly' | 'accessory';
  size?: string | null; material?: string | null; profileType?: string | null; nameEn?: string | null; nameTr?: string | null;
  totalQuantity: number; boxCount: number; unitsPerBox: number; boxWeightKg: number; totalWeightKg: number; partWeightG: number;
};
type CatalogProposal = Omit<Packing, 'totalQuantity' | 'boxCount' | 'unitsPerBox' | 'boxWeightKg' | 'totalWeightKg'>;
type DraftLine = {
  productId: string; quantity: string; unitPrice: string; quoteBasis: string; profileLengthMm: string;
  packing?: Packing | null; catalogProposal?: CatalogProposal | null; sku?: string; title?: string;
};
type PurchaseSummary = {
  id: string; purchaseNumber: string; orderDate: string; workflowState: string; supplierName: string;
  supplierCurrency: string; totalGrossMinor: number | null; lineCount: number; receivedLineCount: number; finalizedAt?: string; costDecisionPending?: boolean;
};
type Purchase = PurchaseSummary & {
  sourcePacking?: any[];
  supplier: Supplier; vatPolicy: string | null; status: string;
  goodsAmountUsdMinor?: number | null; additionalCostsUsdMinor?: number | null; estimatedTotalUsdMinor?: number | null;
  estimateFx?: { numerator: number; denominator: number; observedAt: string } | null;
  draftCosts?: Array<{ id: string; title: string; amountMinor: number; currency: 'USD' | 'TRY'; description: string | null; version: number; paymentStatus?: string; vatMode:'INCLUDED'|'EXCLUDED'; netMinor:number|null; vatRateBps:number|null; vatMinor:number|null; grossMinor:number; estimateUsdMinor: number | null }>;
  lines: Array<{ id: string; productId: string; product: { sku: string; title: string; supplierCode?: string | null; nameTr?: string | null; nameEn?: string | null; size?: string | null; material?: string | null; profileType?: string | null; productType?: string | null }; quote: { originalQuantity: string; supplierUnitPriceMinor: number; currency: string }; normalizedQuantity: { baseQuantity: number; baseUomCode: string }; sourceLineAmountMinor?: number | null; plannedPackages?: { count: number; mixedCount: number; distribution: Array<{ quantity: number; count: number }> } | null; packing?: Packing | null }>;
  acquisitionCosts: Array<{ id: string; category: string; expenseType: string; counterparty?: string; description?: string; occurredOn: string; sourceAmountMinor: number; currency: string; targetLineIds: string[]; vat:{mode:string;rateBps:number}; amounts: { source:{netMinor:number;vatMinor:number;grossMinor:number}; baseTry: { netMinor: number; grossMinor:number } }; fx: { numerator: number; denominator: number; observedAt: string } }>;
  lots: Array<{ id: string; lineId: string; productId: string; landedCostTryMinor: number; merchandiseCostTryMinor: number; freightCostTryMinor: number; customsCostTryMinor: number; cuttingLaborCostTryMinor: number; otherDirectCostTryMinor: number; normalizedAcquisitionUnitCostTry: { numerator: number; denominator: number; perBaseUom: string } }>;
  documents: Array<{ id: string; documentType: string; fileName: string; storageReference: string; createdAt: string }>;
};
type CostPreview = {
  formulaVersion: string;
  lines: Array<{ lineId: string; sku: string; quantityBaseInt: number; baseUomCode: string; unitPurchaseCostTry: { numerator: number; denominator: number }; allocatedExpenseTryMinor: number; estimatedUnitLandedCostTry: { numerator: number; denominator: number }; totalCostTryMinor: number }>;
  unallocatedCosts: Array<{ componentId: string; amountTryMinor: number; category: string }>;
  warnings: Array<{ code: string; message: string }>;
};

const stateLabels: Record<string, string> = {
  DRAFT: 'Taslak', ORDERED: 'Sipariş Verildi', IN_TRANSIT: 'Yolda', COST_PENDING: 'Maliyet Bekliyor',
  RECEIPT_PENDING: 'Mal Kabul Bekliyor', COMPLETED: 'Tamamlandı',
};

const op = (prefix: string) => ({ operationId: `${prefix}-${crypto.randomUUID()}` });
const money = (minor: number | null, currency = 'TRY') => minor == null ? '—' : new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(minor / 100);

export default function Procurement() {
  const [tab, setTab] = useState<Tab>('overview');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [purchases, setPurchases] = useState<PurchaseSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState<Purchase | null>(null);
  const [busy, setBusy] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ name: '', defaultCurrency: 'USD', taxIdentifier: '' });
  const [order, setOrder] = useState<{ purchaseNumber: string; orderDate: string; supplierId: string; notes: string; lines: DraftLine[] }>({ purchaseNumber: '', orderDate: new Date().toISOString().slice(0, 10), supplierId: '', notes: '',
    lines: [{ productId: '', quantity: '1', unitPrice: '0', quoteBasis: 'piece', profileLengthMm: '' }] });
  const [cost, setCost] = useState({ counterparty: '', vatMode: 'INCLUDED', vatRate: '20', expenseType: 'FREIGHT', amount: '', currency: 'USD', occurredOn: new Date().toISOString().slice(0, 10), description: '', targetLineIds: [] as string[] });
  const [documentType, setDocumentType] = useState('COMMERCIAL_INVOICE');
  const [documentCostId, setDocumentCostId] = useState('');
  const [unifiedCsv, setUnifiedCsv] = useState('');
  const [csvPreview, setCsvPreview] = useState<any[]>([]);
  const [costPreview, setCostPreview] = useState<CostPreview | null>(null);

  const load = async () => {
    const [supplierData, productData, purchaseData] = await Promise.all([
      api.get('/procurement/v1/suppliers'), api.get('/products?include_components=1'), api.get('/procurement/v1/purchases'),
    ]);
    setSuppliers(supplierData.data || []);
    setProducts(productData || []);
    setPurchases(purchaseData.data || []);
    setOrder((current) => ({ ...current, supplierId: current.supplierId || supplierData.data?.[0]?.id || '' }));
  };

  const loadPurchase = async (id: string) => {
    setSelectedId(id);
    setCostPreview(null);
    if (!id) return setSelected(null);
    const data = await api.get(`/procurement/v1/purchases/${id}`);
    setSelected(data.data);
  };

  useEffect(() => { load().catch((error) => toast.error(error.message)); }, []);
  useEffect(() => { if (selectedId) loadPurchase(selectedId).catch((error) => toast.error(error.message)); }, [selectedId]);

  const mutate = async (work: () => Promise<any>, message: string) => {
    try {
      setBusy(true);
      const result = await work();
      toast.success(message);
      await load();
      if (selectedId) await loadPurchase(selectedId);
      return result;
    } catch (error: any) {
      toast.error(error.message || 'İşlem tamamlanamadı.');
    } finally { setBusy(false); }
  };

  const cancelDraft = async () => {
    if (!selected?.costDecisionPending || !window.confirm('Bu satın alma taslağı iptal edilsin mi? Ürün kartları ve işlem geçmişi korunur.')) return;
    try {
      setBusy(true);
      await api.post(`/procurement/v1/imports/drafts/${selected.id}/cancel`,{},op('import-draft-cancel'));
      setSelected(null); setSelectedId(''); setCostPreview(null);
      await load();
      toast.success('Taslak listeden kaldırıldı. Aynı CSV yeniden aktarılabilir.');
    } catch (error:any) { toast.error(error.message || 'Taslak iptal edilemedi.'); }
    finally { setBusy(false); }
  };

  const createSupplier = () => mutate(async () => {
    const result = await api.post('/procurement/v1/suppliers', supplierForm, op('supplier-create'));
    setSupplierForm({ name: '', defaultCurrency: 'USD', taxIdentifier: '' });
    return result;
  }, 'Tedarikçi kaydedildi.');

  const addLine = () => setOrder((current) => ({ ...current, lines: [...current.lines, { productId: '', quantity: '1', unitPrice: '0', quoteBasis: 'piece', profileLengthMm: '' }] }));
  const updateLine = (index: number, field: string, value: string) => setOrder((current) => ({ ...current, lines: current.lines.map((line, position) => position === index ? { ...line, [field]: value } : line) }));

  const createOrder = () => mutate(async () => {
    const payload = {
      purchaseNumber: order.purchaseNumber || undefined, orderDate: order.orderDate, supplierId: order.supplierId, notes: order.notes || undefined,
      acquisitionCostVatPolicy: 'VAT_EXCLUDED_FROM_INVENTORY_COST',
      lines: order.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, quoteBasis: line.quoteBasis,
        profileLengthMm: line.quoteBasis === 'profile_bar' ? Number(line.profileLengthMm) : undefined,
        supplierUnitPriceMinor: Math.round(Number(line.unitPrice) * 100), currency: 'USD', vatMode: 'EXCLUDED', vatRateBps: 0,
        packing: line.packing || undefined, catalogProposal: line.catalogProposal || undefined })),
    };
    const result = await api.post('/procurement/v1/purchases', payload, op('purchase-create'));
    setOrder((current) => ({ ...current, purchaseNumber: '', lines: [{ productId: '', quantity: '1', unitPrice: '0', quoteBasis: 'piece', profileLengthMm: '' }] }));
    setSelectedId(result.data.id);
    return result;
  }, 'Satın alma siparişi oluşturuldu.');

  const addCost = () => selected && mutate(() => api.post(`/procurement/v1/purchases/${selected.id}/costs`, {
    category: cost.expenseType === 'FREIGHT' || cost.expenseType === 'DOMESTIC_FREIGHT' ? 'FREIGHT' : cost.expenseType === 'CUSTOMS_DUTY' || cost.expenseType === 'ADDITIONAL_TAX' ? 'CUSTOMS' : 'OTHER',
    counterparty: cost.counterparty, expenseType: cost.expenseType, amountMinor: Math.round(Number(cost.amount) * 100), currency: cost.currency,
    vatMode: cost.vatMode, vatRateBps: parseVatRate(cost.vatRate), occurredOn: cost.occurredOn, description: cost.description,
    targetLineIds: cost.targetLineIds,
  }, op('purchase-cost')), 'Maliyet kalemi ve kur snapshotı kaydedildi.');

  const transition = (state: string) => selected && mutate(() => api.post(`/procurement/v1/purchases/${selected.id}/workflow`, { state }, op('purchase-state')), `${stateLabels[state]} durumuna geçildi.`);
  const allocationPayload = () => ({
    allocations: selected?.acquisitionCosts.map((item) => ({ componentId: item.id, mode: 'ACCEPT_SUGGESTION' })) || [],
  });
  const previewCosts = async () => {
    if (!selected) return;
    try {
      setBusy(true);
      const response = await api.post(`/procurement/v1/purchases/${selected.id}/cost-preview`, allocationPayload());
      setCostPreview(response.data);
    } catch (error: any) {
      toast.error(error.message || 'Maliyet önizlemesi oluşturulamadı.');
    } finally { setBusy(false); }
  };
  const finalize = () => selected && mutate(() => api.post(`/procurement/v1/purchases/${selected.id}/finalize-costs`, {
    ...allocationPayload(),
  }, op('purchase-finalize')), 'FINAL Landed Cost kesinleştirildi.');
  const approveReceipt = () => selected && mutate(() => api.post(`/procurement/v1/purchases/${selected.id}/approve-receipt`, {}, op('receipt-approve')), 'Warehouse mal kabul onayı verildi.');

  const uploadDocument = (file?: File) => {
    if (!selected || !file) return;
    const form = new FormData();
    form.set('file', file); form.set('documentType', documentType);
    if (documentCostId) form.set('costComponentId', documentCostId);
    mutate(() => api.upload(`/procurement/v1/purchases/${selected.id}/documents`, form, op('purchase-document')), 'Belge değiştirilemez kayıt olarak eklendi.');
  };

  const previewCsv = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    const probe = Papa.parse(text, { header: true, preview: 1 });
    if (probe.meta.fields?.includes('schema_version') || probe.meta.fields?.includes('record_type')) { setUnifiedCsv(text); setCsvPreview([]); return; }
    setUnifiedCsv('');
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: async (result) => {
      const response = await api.post('/procurement/v1/purchases/csv-preview', { rows: result.data });
      setCsvPreview(response.data || []);
    }});
  };
  const importCsvRows = () => {
    if (csvPreview.some((row) => row.errors.length > 0)) return toast.error('Hatalı CSV satırları düzeltilmeden aktarılamaz.');
    setOrder((current) => ({ ...current, lines: csvPreview.map((row) => ({
      productId: row.product?.id || '', quantity: row.quantity, unitPrice: row.unitPriceUsd,
      quoteBasis: row.product?.catalog_type === 'profile' ? 'meter' : row.product?.base_uom_code || 'piece', profileLengthMm: '',
      packing: row.packing, catalogProposal: row.catalogProposal, sku: row.sku,
      title: row.product?.title || row.catalogProposal?.nameTr || row.catalogProposal?.nameEn || row.sku,
    })) }));
    toast.success(`${csvPreview.length} CSV satırı sipariş taslağına aktarıldı.`);
  };

  const counts = useMemo(() => Object.keys(stateLabels).map((state) => ({ state, count: purchases.filter((item) => item.workflowState === state).length })), [purchases]);

  return <div className="space-y-6">
    <PageHeader title="Satın Alma" description="Siparişten FINAL Landed Cost ve Warehouse mal kabul onayına kadar tek akış." />
    <div className="flex flex-wrap gap-2">{([
      ['overview', 'Genel Bakış'], ['orders', 'Siparişler'], ['costs', 'Maliyetlendirme'], ['suppliers', 'Tedarikçiler'],
    ] as Array<[Tab, string]>).map(([id, label]) => <Button key={id} variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>{label}</Button>)}</div>

    {tab === 'overview' && <div className="grid gap-4 md:grid-cols-3">{counts.map(({ state, count }) => <Card key={state} padding="lg"><p className="text-xs font-black uppercase tracking-widest text-text-muted">{stateLabels[state]}</p><p className="mt-3 text-3xl font-black">{count}</p></Card>)}</div>}

    {tab === 'suppliers' && <div className="grid gap-6 lg:grid-cols-2">
      <Card padding="lg" className="space-y-4"><h3 className="font-black">Yeni Tedarikçi</h3><Input placeholder="Tedarikçi adı" value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })}/><div className="grid grid-cols-2 gap-3"><Select value={supplierForm.defaultCurrency} onChange={(e) => setSupplierForm({ ...supplierForm, defaultCurrency: e.target.value })}><option>USD</option><option>TRY</option></Select><Input placeholder="Vergi no" value={supplierForm.taxIdentifier} onChange={(e) => setSupplierForm({ ...supplierForm, taxIdentifier: e.target.value })}/></div><Button disabled={busy || !supplierForm.name} onClick={createSupplier}><Plus className="h-4 w-4"/> Kaydet</Button></Card>
      <Card padding="lg"><div className="space-y-3">{suppliers.map((supplier) => <div key={supplier.id} className="rounded-xl border p-4"><strong>{supplier.name}</strong><p className="text-xs text-text-muted">{supplier.defaultCurrency} · {supplier.taxIdentifier || 'Vergi no yok'}</p></div>)}</div></Card>
    </div>}

    {tab === 'orders' && <div className="space-y-6">
      <Card padding="lg" className="space-y-4"><div className="flex items-center justify-between"><h3 className="font-black">Yeni Sipariş</h3><label className="cursor-pointer rounded-xl border px-4 py-2 text-sm font-bold"><FileUp className="mr-2 inline h-4 w-4"/>CSV Önizle<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => previewCsv(e.target.files?.[0])}/></label></div>
        <div className="grid gap-3 md:grid-cols-3"><Input placeholder="Sipariş no (otomatik olabilir)" value={order.purchaseNumber} onChange={(e) => setOrder({ ...order, purchaseNumber: e.target.value })}/><Input type="date" value={order.orderDate} onChange={(e) => setOrder({ ...order, orderDate: e.target.value })}/><Select value={order.supplierId} onChange={(e) => setOrder({ ...order, supplierId: e.target.value })}><option value="">Tedarikçi seçin</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Input className="md:col-span-3" placeholder="Sipariş notu" value={order.notes} onChange={(e) => setOrder({ ...order, notes: e.target.value })}/></div>
        {order.lines.map((line, index) => <div key={index} className="grid gap-3 rounded-xl bg-bg-main p-3 md:grid-cols-4">{line.catalogProposal ? <div className="rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm"><strong>Yeni SKU: {line.sku}</strong><span className="block text-xs text-text-muted">{line.title} · Pasif canonical kayıt</span></div> : <Select value={line.productId} onChange={(e) => updateLine(index, 'productId', e.target.value)}><option value="">SKU seçin</option>{products.map((item) => <option key={item.id} value={item.id}>{item.sku} · {item.title || item.name}</option>)}</Select>}<Input type="number" min="0.0001" step="0.0001" value={line.quantity} onChange={(e) => updateLine(index, 'quantity', e.target.value)} placeholder="Miktar"/><Input type="number" min="0" step="0.01" value={line.unitPrice} onChange={(e) => updateLine(index, 'unitPrice', e.target.value)} placeholder="USD birim fiyat"/><Select value={line.quoteBasis} onChange={(e) => updateLine(index, 'quoteBasis', e.target.value)}><option value="piece">Adet</option><option value="meter">Metre</option><option value="square_meter">m²</option><option value="kg">Kg</option><option value="roll">Rulo</option><option value="package">Paket</option><option value="box">Kutu</option><option value="profile_bar">Profil boyu</option></Select>{line.packing && <p className="md:col-span-4 text-xs text-text-muted">{line.packing.boxCount} koli × {line.packing.unitsPerBox} adet · Koli {line.packing.boxWeightKg.toFixed(2)} kg · Toplam {line.packing.totalWeightKg.toFixed(2)} kg</p>}{line.quoteBasis === 'profile_bar' && <Input type="number" min="1" value={line.profileLengthMm} onChange={(e) => updateLine(index, 'profileLengthMm', e.target.value)} placeholder="Profil boyu (mm)"/>}</div>)}
        <div className="text-right text-sm font-black">Toplam ürün bedeli: ${order.lines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice || 0), 0).toFixed(2)}</div>
        <div className="flex gap-2"><Button variant="secondary" onClick={addLine}><Plus className="h-4 w-4"/>Satır</Button><Button disabled={busy || !order.supplierId || order.lines.some((line) => !line.productId && !line.catalogProposal)} onClick={createOrder}><ShoppingBasket className="h-4 w-4"/>Siparişi Oluştur</Button></div>
        <a className="text-sm text-primary underline" href="/examples/procurement-import-v1.csv" download>Örnek CSV indir · Giderler manuel girilir</a>
        {unifiedCsv && <ProcurementImport key={unifiedCsv + order.supplierId} csv={unifiedCsv} supplierId={order.supplierId} onCreated={(id) => { setUnifiedCsv(''); setSelectedId(id); setTab('costs'); void load(); }}/>}
        {csvPreview.length > 0 && <div className="space-y-3 rounded-xl border p-3 text-xs"><strong>CSV doğrulama:</strong>{csvPreview.map((row) => <div key={row.row} className={row.errors.length ? 'space-y-1 text-danger' : 'text-success'}>{row.errors.length ? row.errors.map((error: string) => <p key={error}>• {error}</p>) : <p>Satır {row.row} · SKU {row.sku} · {row.isNewProduct ? 'Yeni pasif ürün oluşturulacak' : 'Hazır'}</p>}</div>)}<Button variant="secondary" disabled={csvPreview.some((row) => row.errors.length)} onClick={importCsvRows}>Doğrulanan Satırları Siparişe Aktar</Button></div>}
      </Card>
      <PurchasePicker purchases={purchases} selectedId={selectedId} onSelect={loadPurchase}/>
    </div>}

    {tab === 'costs' && <div className="space-y-6"><PurchasePicker purchases={purchases} selectedId={selectedId} onSelect={loadPurchase}/>{selected && <>
      <Card padding="lg" className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-black">{selected.purchaseNumber}</h3><p className="text-sm text-text-muted">{selected.supplier.name}</p></div><Badge>{stateLabels[selected.workflowState]}</Badge></div>
        <div className="flex flex-wrap gap-2">{selected.costDecisionPending && <Button variant="secondary" disabled={busy} onClick={cancelDraft}>Taslağı Sil</Button>}{!selected.costDecisionPending && selected.workflowState === 'DRAFT' && <Button variant="secondary" onClick={() => transition('ORDERED')}>Sipariş Verildi</Button>}{selected.workflowState === 'ORDERED' && <Button variant="secondary" onClick={() => transition('IN_TRANSIT')}>Yolda</Button>}{!selected.costDecisionPending && ['DRAFT','ORDERED','IN_TRANSIT'].includes(selected.workflowState) && <Button variant="secondary" onClick={() => transition('COST_PENDING')}>Maliyet Bekliyor</Button>}</div>
        <PurchaseProductTree lines={selected.lines} lots={selected.lots}/>
      </Card>
      {selected.costDecisionPending && selected.draftCosts && <DraftCostsPanel draft={{ id:selected.id, goodsAmountUsdMinor:selected.goodsAmountUsdMinor ?? null,
        additionalCostsUsdMinor:selected.additionalCostsUsdMinor ?? null, estimatedTotalUsdMinor:selected.estimatedTotalUsdMinor ?? null,
        estimateFx:selected.estimateFx ?? null, draftCosts:selected.draftCosts }}
        onChanged={(data) => { setSelected(data); void load(); }}
        onFinalized={(data) => { setSelected(data); setSelectedId(data.id); void load(); }}/>}

      {Boolean(selected.sourcePacking?.length) && <Card padding="lg"><details><summary className="cursor-pointer font-bold">Kaynak koliler ve içerikleri</summary>{selected.sourcePacking!.filter(r => r.record_type === 'PACKAGE_GROUP').map(g => <div className="border-b py-2 text-xs" key={g.record_id}><strong>{g.record_id} · {g.package_count} koli {g.meta?.mixed ? '· Karışık kaynak koli' : ''}</strong><p>Grup net {g.net_weight_kg || '—'} kg · brüt {g.gross_weight_kg || '—'} kg</p>{selected.sourcePacking!.filter(r => r.parent_ref === g.record_id).map(i => <p key={i.record_id}>{i.sku || i.product_ref} · {i.quantity} toplam · {i.units_per_package}/koli · alış kaynağı {i.purchase_line_ref}</p>)}</div>)}</details></Card>}
      {selected.acquisitionCosts.length > 0 && <Card padding="lg" className="space-y-2"><h3 className="font-black">Kaydedilmiş Giderler</h3>{selected.acquisitionCosts.map((item) => <div key={item.id} className="rounded-xl border p-3 text-sm"><strong>{item.counterparty === 'SUPPLIER' ? 'Tedarikçi ek bedeli' : item.counterparty === 'THIRD_PARTY' ? 'Üçüncü taraf' : 'Geçmiş kayıt · muhatap belirtilmemiş'} · {item.expenseType} · Genel toplam {money(item.amounts.source.grossMinor, item.currency)}</strong><p>Ana tutar {money(item.amounts.source.netMinor,item.currency)} · KDV %{item.vat.rateBps/100}: {money(item.amounts.source.vatMinor,item.currency)}</p><p className="text-xs text-text-muted">Brüt TL karşılığı {money(item.amounts.baseTry.grossMinor)} · kur {item.fx.numerator / item.fx.denominator} · {item.occurredOn} · {item.targetLineIds.length ? `${item.targetLineIds.length} seçili satır` : 'ortak gider'}</p></div>)}</Card>}
      {selected.status === 'DRAFT' && <Card padding="lg" className="space-y-4"><h3 className="font-black">Maliyet Kalemi</h3><p className="text-sm">Tedarikçi ek bedeli fatura borcuna eklenir; üçüncü taraf gideri eklenmez. Her ikisi maliyete bir kez dağıtılır. Gider kaydı ödeme değildir.</p><Select value={cost.counterparty} onChange={e => setCost({ ...cost, counterparty: e.target.value })}><option value="">Gider muhatabını seçin</option><option value="SUPPLIER">Tedarikçiye ödenecek fatura ek bedeli</option><option value="THIRD_PARTY">Üçüncü taraf gideri</option></Select><label className="text-sm">KDV (%)<Input type="number" min="0" max="100" step="0.01" value={cost.vatRate} onChange={e => setCost({ ...cost, vatRate: e.target.value })}/></label><div className="grid gap-3 md:grid-cols-3"><Select value={cost.expenseType} onChange={(e) => setCost({ ...cost, expenseType: e.target.value })}>{['FREIGHT','CUSTOMS_DUTY','ADDITIONAL_TAX','CUSTOMS_BROKER','WAREHOUSE_PORT','DOMESTIC_FREIGHT','INSURANCE','BANK_TRANSFER','OTHER'].map((item) => <option key={item}>{item}</option>)}</Select><Input type="number" min="0" step="0.01" placeholder="KDV dahil toplam tutar" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })}/><Select value={cost.currency} onChange={(e) => setCost({ ...cost, currency: e.target.value })}><option>USD</option><option>TRY</option></Select><Input type="date" value={cost.occurredOn} onChange={(e) => setCost({ ...cost, occurredOn: e.target.value })}/><Input className="md:col-span-2" placeholder="Açıklama" value={cost.description} onChange={(e) => setCost({ ...cost, description: e.target.value })}/></div><div><p className="mb-2 text-xs font-bold text-text-muted">Boş bırakırsanız tüm satırlara ürün bedeli oranında dağıtılır.</p><div className="flex flex-wrap gap-2">{selected.lines.map((line) => <label key={line.id} className="rounded-lg border px-3 py-2 text-xs"><input className="mr-2" type="checkbox" checked={cost.targetLineIds.includes(line.id)} onChange={(e) => setCost({ ...cost, targetLineIds: e.target.checked ? [...cost.targetLineIds, line.id] : cost.targetLineIds.filter((id) => id !== line.id) })}/>{line.product.sku}</label>)}</div></div><Button disabled={busy || !cost.amount || !cost.counterparty || !cost.vatMode || cost.vatRate === ''} onClick={addCost}><Plus className="h-4 w-4"/>Maliyet Ekle</Button></Card>}
      {costPreview && <Card padding="lg" className="space-y-4"><div><h3 className="font-black">Salt-okunur FINAL Landed Cost Önizlemesi</h3><p className="text-xs text-text-muted">{costPreview.formulaVersion} · Önizleme kesinleştirme ile aynı hesap motorunu kullanır.</p></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-xs text-text-muted"><th>SKU</th><th>Miktar</th><th>Birim alış</th><th>Gider payı</th><th>Tahmini birim LC</th><th>Toplam maliyet</th></tr></thead><tbody>{costPreview.lines.map((line) => <tr key={line.lineId} className="border-t"><td className="py-3 font-bold">{line.sku}</td><td>{line.quantityBaseInt} {line.baseUomCode}</td><td>{money(line.unitPurchaseCostTry.numerator / line.unitPurchaseCostTry.denominator)}</td><td>{money(line.allocatedExpenseTryMinor)}</td><td className="font-bold">{money(line.estimatedUnitLandedCostTry.numerator / line.estimatedUnitLandedCostTry.denominator)}</td><td>{money(line.totalCostTryMinor)}</td></tr>)}</tbody></table></div>{costPreview.unallocatedCosts.length > 0 && <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><strong>Dağıtılmamış giderler</strong>{costPreview.warnings.map((warning) => <p key={warning.message}>{warning.message}</p>)}</div>}</Card>}
      {!selected.costDecisionPending && <Card padding="lg" className="space-y-4"><h3 className="font-black">Belgeler</h3><div className="flex flex-wrap gap-3"><Select value={documentType} onChange={(e) => setDocumentType(e.target.value)}>{['PROFORMA_INVOICE','COMMERCIAL_INVOICE','PACKING_LIST','CUSTOMS_DOCUMENT','FREIGHT_DOCUMENT','EXPENSE_INVOICE','OTHER'].map((item) => <option key={item}>{item}</option>)}</Select><Select value={documentCostId} onChange={(e) => setDocumentCostId(e.target.value)}><option value="">Genel satın alma evrakı</option>{selected.acquisitionCosts.map((item) => <option key={item.id} value={item.id}>{item.expenseType} · {item.description || item.occurredOn}</option>)}</Select><label className="cursor-pointer rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white"><FileUp className="mr-2 inline h-4 w-4"/>Belge Yükle<input className="hidden" type="file" accept=".pdf,image/png,image/jpeg,image/webp" onChange={(e) => uploadDocument(e.target.files?.[0])}/></label></div>{selected.documents.map((doc) => <a className="block text-sm font-bold text-primary" href={doc.storageReference} key={doc.id} target="_blank" rel="noreferrer">{doc.documentType} · {doc.fileName}</a>)}</Card>}
      {!selected.costDecisionPending && <Card padding="lg" className="space-y-3"><h3 className="font-black">Kesinleştirme ve Mal Kabul</h3><p className="text-sm text-text-muted">FINAL Landed Cost kesinleşmeden Warehouse onayı açılamaz; fiziksel stok sadece Warehouse mal kabulüyle artar.</p><div className="flex flex-wrap gap-2">{selected.status === 'DRAFT' && <Button variant="secondary" disabled={busy} onClick={previewCosts}>Maliyet Önizlemesi</Button>}{selected.status === 'DRAFT' && costPreview && <Button disabled={busy} onClick={finalize}><RefreshCw className="h-4 w-4"/>Önizlemeyi Onayla ve Kesinleştir</Button>}{selected.status === 'APPROVED' && selected.workflowState === 'COST_PENDING' && <Button disabled={busy} onClick={approveReceipt}><Truck className="h-4 w-4"/>Mal Kabul İçin Onayla</Button>}</div></Card>}
    </>}</div>}
  </div>;
}

function PurchasePicker({ purchases, selectedId, onSelect }: { purchases: PurchaseSummary[]; selectedId: string; onSelect: (id: string) => void }) {
  return <Card padding="lg" className="space-y-3"><h3 className="font-black">Siparişler</h3><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{purchases.map((purchase) => <button type="button" key={purchase.id} onClick={() => onSelect(purchase.id)} className={`rounded-xl border p-4 text-left ${selectedId === purchase.id ? 'border-primary bg-primary/5' : 'border-border-color'}`}><div className="flex items-start justify-between gap-2"><strong>{purchase.purchaseNumber}</strong><Badge>{stateLabels[purchase.workflowState] || purchase.workflowState}</Badge></div><p className="mt-2 text-sm">{purchase.supplierName}</p><p className="text-xs text-text-muted">{purchase.orderDate} · {purchase.lineCount} kalem · {money(purchase.totalGrossMinor, purchase.supplierCurrency)}</p></button>)}</div></Card>;
}

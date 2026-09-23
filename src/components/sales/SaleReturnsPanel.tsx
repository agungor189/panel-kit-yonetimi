import { useEffect, useMemo, useRef, useState } from "react";
import { api, createRetryOperation } from "../../lib/api";

const reasons = [
  "CUSTOMER_CHANGED_MIND", "WRONG_PRODUCT", "DAMAGED", "MISSING_PART", "INCOMPATIBLE", "OTHER",
] as const;

const money = (minor: number, currency = "TRY") => new Intl.NumberFormat("tr-TR", { style: "currency", currency }).format((minor || 0) / 100);
const minorFromInput = (value: string) => {
  const match = /^(0|[1-9]\d*)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Tutar en fazla iki ondalık basamaklı olmalıdır.");
  return Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
};

export function SaleReturnsPanel({ sale, readOnly }: { sale: any; readOnly: boolean }) {
  const [data, setData] = useState<any>({ returns: [], legacyUnknown: false });
  const [cashAccounts, setCashAccounts] = useState<any[]>([]);
  const [draft, setDraft] = useState<Record<string, { quantity: string; reason: string; explanation: string }>>({});
  const [shippingSelected, setShippingSelected] = useState(false);
  const [shippingAmount, setShippingAmount] = useState("0,00");
  const [refundDraft, setRefundDraft] = useState<Record<string, { amount: string; account: string; approval: string }>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const createOperation = useRef(createRetryOperation("return-create"));
  const refundOperation = useRef(createRetryOperation("return-refund"));

  const load = async () => {
    const response = await api.get(`/returns/v1/sales/${sale.id}`);
    setData(response.data);
  };
  useEffect(() => {
    void load().catch((error) => setFeedback(error.message));
    void api.get("/cash-accounts").then((rows) => setCashAccounts(Array.isArray(rows) ? rows : rows.data || [])).catch(() => setCashAccounts([]));
  }, [sale.id]);

  const financialLines = sale.financial?.lines || [];
  const selectedLines = useMemo(() => financialLines.flatMap((line: any) => {
    const row = draft[line.id];
    const quantity = Number(row?.quantity || 0);
    return quantity > 0 ? [{ financialLineId: line.id, quantityBaseInt: quantity, reasonCode: row.reason || "CUSTOMER_CHANGED_MIND", explanation: row.explanation || null }] : [];
  }), [draft, financialLines]);

  const submitReturn = async () => {
    if (!selectedLines.length) { setFeedback("En az bir satır ve iade adedi seçin."); return; }
    try {
      const payload = { lines: selectedLines, customerShippingRefund: { selected: shippingSelected, amountMinor: shippingSelected ? minorFromInput(shippingAmount) : 0 } };
      const operationId = createOperation.current.idFor(payload);
      setBusy(true); setFeedback("");
      await api.post(`/returns/v1/sales/${sale.id}`, payload, { operationId });
      createOperation.current.complete(operationId);
      setDraft({}); setShippingSelected(false); setShippingAmount("0,00");
      await load();
      setFeedback("İade talebi depoya gönderildi; stok ve kasa henüz değişmedi.");
    } catch (error: any) { setFeedback(error.message); } finally { setBusy(false); }
  };

  const submitRefund = async (returnFact: any) => {
    const row = refundDraft[returnFact.id] || { amount: "", account: "", approval: "" };
    try {
      const payload = { amountMinor: minorFromInput(row.amount), cashAccountId: row.account || null, approvalReference: row.approval.trim() };
      const operationId = refundOperation.current.idFor({ returnId: returnFact.id, ...payload });
      setBusy(true); setFeedback("");
      await api.post(`/returns/v1/${returnFact.id}/refunds`, payload, { operationId });
      refundOperation.current.complete(operationId);
      await load();
      setRefundDraft((current) => ({ ...current, [returnFact.id]: { amount: "", account: "", approval: "" } }));
      setFeedback("Yetkili iade ödemesi kaydedildi.");
    } catch (error: any) { setFeedback(error.message); } finally { setBusy(false); }
  };

  return <section className="rounded-2xl border border-rose-200 bg-rose-50/40 p-5" data-testid="sale-returns-panel">
    <div className="flex items-start justify-between gap-4"><div><h3 className="text-sm font-black text-gray-800">V2-10 İade ve para iadesi</h3><p className="mt-1 text-xs font-semibold text-gray-500">Fiziksel kabul, finansal ters kayıt ve ödeme birbirinden bağımsızdır.</p></div></div>
    {data.legacyUnknown && <p className="mt-4 rounded-xl bg-amber-100 p-3 text-xs font-bold text-amber-800">Eski “İade Edildi” kaydı V2-10 fact’lerine sahip değil; legacy/unknown olarak korunuyor.</p>}
    {!readOnly && sale.financial?.snapshot && <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs font-black uppercase tracking-wider text-gray-500">Yeni iade</p>
      <div className="mt-3 space-y-3">{financialLines.map((line: any) => {
        const row = draft[line.id] || { quantity: "", reason: "CUSTOMER_CHANGED_MIND", explanation: "" };
        return <div key={line.id} className="grid gap-2 rounded-lg bg-gray-50 p-3 md:grid-cols-[1fr_90px_190px]">
          <div><b className="text-sm">{line.productSku} · {line.productTitle}</b><p className="text-xs text-gray-500">Orijinal: {line.quantityBaseInt} · Brüt {money(line.grossMinor, sale.financial.currency)}</p></div>
          <input aria-label={`${line.productSku} iade adedi`} className="rounded-lg border px-2" type="number" min="0" max={line.quantityBaseInt} value={row.quantity} onChange={(event) => setDraft((current) => ({ ...current, [line.id]: { ...row, quantity: event.target.value } }))}/>
          <select className="rounded-lg border px-2 text-xs font-bold" value={row.reason} onChange={(event) => setDraft((current) => ({ ...current, [line.id]: { ...row, reason: event.target.value } }))}>{reasons.map((reason) => <option key={reason}>{reason}</option>)}</select>
          {row.reason === "OTHER" && <input className="rounded-lg border px-2 py-2 text-xs md:col-span-3" placeholder="Açıklama zorunlu" value={row.explanation} onChange={(event) => setDraft((current) => ({ ...current, [line.id]: { ...row, explanation: event.target.value } }))}/>} 
        </div>;
      })}</div>
      <label className="mt-3 flex items-center gap-2 text-xs font-bold"><input type="checkbox" checked={shippingSelected} onChange={(event) => setShippingSelected(event.target.checked)}/> Müşteri kargo ücretini ayrıca iade et</label>
      {shippingSelected && <input className="mt-2 rounded-lg border px-3 py-2 text-sm" value={shippingAmount} onChange={(event) => setShippingAmount(event.target.value)} placeholder="0,00"/>}
      <button disabled={busy} onClick={() => void submitReturn()} className="mt-3 rounded-lg bg-rose-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">İade oluştur</button>
    </div>}
    <div className="mt-4 space-y-3">{(data.returns || []).map((item: any) => {
      const refund = refundDraft[item.id] || { amount: "", account: "", approval: "" };
      const marketplace = item.refundMode === "MARKETPLACE_SETTLEMENT";
      return <article key={item.id} className="rounded-xl border border-gray-200 bg-white p-4">
        {item.commissionReversalState && <span className="mb-3 inline-block rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black text-amber-800">Komisyon: {item.commissionReversalState}</span>}
        <div className="grid gap-3 text-xs sm:grid-cols-3"><div><span className="text-gray-500">İade edilen / orijinal</span><b className="block">{item.inspection.inspectedQuantityBaseInt} / {item.inspection.requestedQuantityBaseInt}</b></div><div><span className="text-gray-500">Brüt / KDV / Net ters kayıt</span><b className="block">{money(item.financialReversal.grossMinor, item.currency)} / {money(item.financialReversal.vatMinor, item.currency)} / {money(item.financialReversal.netMinor, item.currency)}</b></div><div><span className="text-gray-500">COGS / RETURN_LOSS</span><b className="block">{money(item.lines.flatMap((line: any) => line.cogs).reduce((sum: number, row: any) => sum + row.costTryMinor, 0))} / {money(item.returnLossTryMinor)}</b></div></div>
        <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs"><b>İade edildi:</b> {money(item.refundable.refundedMinor, item.currency)} · <b>Kalan:</b> {money(item.refundable.remainingMinor, item.currency)} · <b>Müşteri kargosu:</b> {money(item.customerShippingRefund.amountMinor, item.currency)}</div>
        {!readOnly && item.inspection.complete && item.refundable.remainingMinor > 0 && <div className="mt-3 grid gap-2 md:grid-cols-4">
          <input className="rounded-lg border px-2 py-2 text-xs" placeholder="İade tutarı" value={refund.amount} onChange={(event) => setRefundDraft((current) => ({ ...current, [item.id]: { ...refund, amount: event.target.value } }))}/>
          <input className="rounded-lg border px-2 py-2 text-xs" placeholder="Onay referansı" value={refund.approval} onChange={(event) => setRefundDraft((current) => ({ ...current, [item.id]: { ...refund, approval: event.target.value } }))}/>
          {!marketplace ? <select className="rounded-lg border px-2 text-xs" value={refund.account} onChange={(event) => setRefundDraft((current) => ({ ...current, [item.id]: { ...refund, account: event.target.value } }))}><option value="">Kasa/banka seç</option>{cashAccounts.filter((account) => account.is_active !== 0 && account.type !== "platform" && account.currency === item.currency).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select> : <span className="rounded-lg bg-amber-50 p-2 text-xs font-bold">Settlement / alacak akışı</span>}
          <button disabled={busy || !refund.approval.trim()} onClick={() => void submitRefund(item)} className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-black text-white disabled:opacity-40">İadeyi onayla</button>
        </div>}
      </article>;
    })}</div>
    {feedback && <p className="mt-3 text-xs font-bold text-gray-700">{feedback}</p>}
  </section>;
}

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../App';

type Finding = { id:string;domain:string;code:string;severity:'INFO'|'WARN'|'CRITICAL';affectedType:'SKU'|'ORDER'|'SYSTEM';affectedId:string;expected:unknown;actual:unknown;status:string;repairStatus:string;occurrences:number;lastSeenAt:string;repairProposal?:{id:string;status:string;command_type:string;reason:string}|null };
type Summary = { counts:Record<'INFO'|'WARN'|'CRITICAL',number>;lastRun:any;activeBlocks:number };
const operationId=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
const severityStyle={INFO:'bg-blue-50 text-blue-700 border-blue-200',WARN:'bg-amber-50 text-amber-800 border-amber-200',CRITICAL:'bg-red-50 text-red-700 border-red-200'};

export default function ReconciliationCenter(){
  const {role}=useAuth();const [summary,setSummary]=useState<Summary|null>(null);const [findings,setFindings]=useState<Finding[]>([]);const [severity,setSeverity]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [history,setHistory]=useState<Record<string,any[]>>({});
  const load=useCallback(async()=>{setError('');try{const [summaryResponse,findingResponse]=await Promise.all([api.get('/reconciliation/v1/summary'),api.get(`/reconciliation/v1/findings?status=OPEN${severity?`&severity=${severity}`:''}`)]);setSummary(summaryResponse.data);setFindings(findingResponse.data);}catch(value){setError(value instanceof Error?value.message:'Sistem kontrolü yüklenemedi.');}},[severity]);
  useEffect(()=>{void load();},[load]);
  const runNow=async()=>{setBusy(true);setError('');try{await api.post('/reconciliation/v1/runs',{requested_at:new Date().toISOString()},{operationId:operationId('reconciliation-run')});await load();}catch(value){setError(value instanceof Error?value.message:'Kontrol başlatılamadı.');}finally{setBusy(false);}};
  const review=async(finding:Finding,action:'approve'|'reject')=>{if(!finding.repairProposal)return;const reason=window.prompt(action==='approve'?'Onay gerekçesi':'Ret gerekçesi');if(!reason?.trim())return;setBusy(true);try{await api.post(`/reconciliation/v1/repair-proposals/${finding.repairProposal.id}/${action}`,{reason},{operationId:operationId(`repair-${action}`)});await load();}catch(value){setError(value instanceof Error?value.message:'İnceleme kaydedilemedi.');}finally{setBusy(false);}};
  const toggleHistory=async(id:string)=>{if(history[id]){setHistory((current)=>{const next={...current};delete next[id];return next;});return;}try{const response=await api.get(`/reconciliation/v1/findings/${id}/history`);setHistory((current)=>({...current,[id]:response.data}));}catch(value){setError(value instanceof Error?value.message:'Geçmiş yüklenemedi.');}};
  return <div className="space-y-5">
    <div className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
      <div><p className="text-xs font-black uppercase tracking-[.16em] text-slate-500">Reconciliation / Sistem Kontrolü</p><h1 className="mt-1 text-2xl font-black text-slate-900">Kaynak kayıtları ve projeksiyonlar</h1><p className="mt-1 text-sm text-slate-500">Otomatik kontrol her gün 03:00'te çalışır. Kritik bulgular yalnız ilgili SKU veya siparişi engeller.</p></div>
      <button data-write-action="true" onClick={runNow} disabled={busy||role==='readonly'} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 text-sm font-black text-white disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${busy?'animate-spin':''}`}/>Şimdi kontrol et</button>
    </div>
    {error&&<div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {[['CRITICAL','Kritik',ShieldAlert],['WARN','Uyarı',AlertCircle],['INFO','Bilgi',CheckCircle2]].map(([key,label,Icon]:any)=><button key={key} onClick={()=>setSeverity(severity===key?'':key)} className={`rounded-2xl border bg-white p-4 text-left shadow-sm ${severity===key?'ring-2 ring-slate-800':''}`}><Icon className="h-5 w-5 text-slate-500"/><p className="mt-3 text-3xl font-black">{summary?.counts[key as keyof Summary['counts']]||0}</p><p className="text-xs font-bold text-slate-500">{label}</p></button>)}
      <div className="rounded-2xl border bg-white p-4 shadow-sm"><Wrench className="h-5 w-5 text-slate-500"/><p className="mt-3 text-3xl font-black">{summary?.activeBlocks||0}</p><p className="text-xs font-bold text-slate-500">Aktif kapsam engeli</p></div>
      <div className="rounded-2xl border bg-white p-4 shadow-sm"><Clock3 className="h-5 w-5 text-slate-500"/><p className="mt-3 text-sm font-black">{summary?.lastRun?.completed_at?new Date(summary.lastRun.completed_at).toLocaleString('tr-TR'):'Henüz yok'}</p><p className="mt-2 text-xs font-bold text-slate-500">Son kontrol</p></div>
    </div>
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-5 py-4"><h2 className="font-black">Açık bulgular</h2></div>
      {findings.length===0?<div className="p-10 text-center text-sm font-bold text-slate-500">Açık bulgu yok.</div>:<div className="divide-y divide-gray-100">{findings.map((finding)=><div key={finding.id} className="p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2.5 py-1 text-[11px] font-black ${severityStyle[finding.severity]}`}>{finding.severity}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-600">{finding.domain}</span><span className="text-xs font-bold text-slate-500">{finding.affectedType}: {finding.affectedId}</span></div><p className="mt-3 font-black text-slate-900">{finding.code}</p><p className="mt-1 text-xs text-slate-500">Tekrar: {finding.occurrences} · Onarım: {finding.repairStatus}</p></div>
          <div className="flex flex-wrap gap-2"><button onClick={()=>void toggleHistory(finding.id)} className="rounded-lg border px-3 py-2 text-xs font-black">Geçmiş</button>{role==='admin'&&finding.repairProposal?.status==='PROPOSED'&&<><button disabled={busy} onClick={()=>void review(finding,'reject')} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-black text-red-700">Reddet</button><button disabled={busy} onClick={()=>void review(finding,'approve')} className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-black text-white">Onayla</button></>}</div></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2"><div className="rounded-xl bg-emerald-50 p-3"><p className="text-[10px] font-black uppercase tracking-wider text-emerald-700">Beklenen</p><pre className="mt-2 overflow-auto text-xs text-emerald-950">{JSON.stringify(finding.expected,null,2)}</pre></div><div className="rounded-xl bg-red-50 p-3"><p className="text-[10px] font-black uppercase tracking-wider text-red-700">Gerçek</p><pre className="mt-2 overflow-auto text-xs text-red-950">{JSON.stringify(finding.actual,null,2)}</pre></div></div>
        {history[finding.id]&&<div className="mt-4 space-y-2 rounded-xl border bg-slate-50 p-3">{history[finding.id].map((event:any)=><div key={event.id} className="text-xs"><b>{event.event_type}</b> · {event.actor_id} · {new Date(event.created_at).toLocaleString('tr-TR')}<p className="text-slate-500">{event.reason}</p></div>)}</div>}
      </div>)}</div>}
    </div>
  </div>;
}

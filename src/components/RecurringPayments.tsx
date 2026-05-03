import { useState, useEffect, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  CreditCard,
  Building2,
  Settings as SettingsIcon,
  PlayCircle
} from 'lucide-react';
import { api } from '../lib/api';
import { useCurrency } from '../CurrencyContext';
import { RecurringPaymentPlan, RecurringPaymentOccurrence, Settings } from '../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '../App';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function RecurringPayments({ settings }: { settings: Settings | null }) {
  const { isReadOnly } = useAuth();
  const { FormatAmount } = useCurrency();
  const [plans, setPlans] = useState<RecurringPaymentPlan[]>([]);
  const [occurrences, setOccurrences] = useState<RecurringPaymentOccurrence[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [viewDate, setViewDate] = useState(new Date());

  // State for Add Plan
  const [formData, setFormData] = useState<Partial<RecurringPaymentPlan>>({
    title: '',
    category: settings?.expense_categories[0] || 'Kira',
    payment_type: 'expense',
    amount: 0,
    currency: 'TRY',
    due_day: 1,
    frequency: 'monthly',
    auto_process: false,
    document_required: false,
    is_active: true
  });

  const [selectedOccurrence, setSelectedOccurrence] = useState<RecurringPaymentOccurrence | null>(null);

  useEffect(() => {
    loadData();
  }, [viewDate]);

  const loadData = async () => {
    try {
      const year = viewDate.getFullYear();
      const month = (viewDate.getMonth() + 1).toString().padStart(2, '0');
      const monthStr = `${year}-${month}`;

      const [plansRes, occurrencesRes] = await Promise.all([
        api.get('/recurring-payments'),
        api.get(`/recurring-payments/calendar?month=${monthStr}`)
      ]);
      setPlans(plansRes);
      setOccurrences(occurrencesRes);
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadOnly) return;
    setLoading(true);
    try {
      await api.post('/recurring-payments', formData);
      setShowAdd(false);

      // Reset form
      setFormData({
        title: '',
        category: settings?.expense_categories[0] || 'Kira',
        payment_type: 'expense',
        amount: 0,
        currency: 'TRY',
        due_day: 1,
        frequency: 'monthly',
        auto_process: false,
        document_required: false,
        is_active: true,
        start_date: '',
        end_date: '',
        custom_interval_days: 0,
        start_month: 1,
        due_month: 1,
        week_day: 1
      });
      loadData();
    } catch (err) {
      alert("Plan oluşturulamadı.");
    } finally {
      setLoading(false);
    }
  };

  const processDuePayments = async () => {
    if (isReadOnly) return;
    setLoading(true);
    try {
      const res = await api.post('/recurring-payments/process-due', {});
      alert(`Başarıyla ${res.processed_count || 0} ödeme işlendi.`);
      loadData();
    } catch (err) {
      alert("Ödemeler işlenirken hata oluştu.");
    } finally {
      setLoading(false);
    }
  };

  const handleOccurrenceAction = async (id: string, action: 'process' | 'skip' | 'cancel') => {
    if (isReadOnly) return;
    try {
      await api.post(`/recurring-payments/occurrences/${id}/${action}`, {});
      setSelectedOccurrence(null);
      loadData();
    } catch(e) {
      alert("İşlem başarısız oldu.");
    }
  };

  const changeMonth = (offset: number) => {
    const newDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + offset, 1);
    setViewDate(newDate);
  };

  const handleDeletePlan = async (id: string) => {
    if (isReadOnly) return;
    if(!window.confirm("Bu planı ve gelecekteki tüm ödemeleri silmek istediğinize emin misiniz?")) return;
    try {
      await api.delete(`/recurring-payments/${id}`);
      loadData();
    } catch(e) {
      alert("Silme başarısız.");
    }
  };

  const monthInfo = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1).getDay();
    const startingBlankDays = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = new Intl.DateTimeFormat('tr-TR', { month: 'long', year: 'numeric' }).format(viewDate);

    const calendarDays = [];

    for (let i = 0; i < startingBlankDays; i++) {
       calendarDays.push({ blank: true });
    }

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${(today.getMonth()+1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;

    for (let i = 1; i <= daysInMonth; i++) {
       const dayStr = `${year}-${(month+1).toString().padStart(2, '0')}-${i.toString().padStart(2, '0')}`;
       const dayOccurrences = occurrences.filter(o => o.due_date === dayStr);

       calendarDays.push({
          day: i,
          dateStr: dayStr,
          occurrences: dayOccurrences,
          current: dayStr === todayStr
       });
    }
    return { calendarDays, monthName, year, month };
  }, [occurrences, viewDate]);

  const stats = useMemo(() => {
    const pendingTotal = occurrences.filter(o => ['pending', 'due', 'overdue'].includes(o.status)).reduce((a,b) => a + (b.amount_try || b.amount), 0);
    const pendingCount = occurrences.filter(o => ['pending', 'due', 'overdue'].includes(o.status)).length;
    const overdueCount = occurrences.filter(o => o.status === 'overdue').length;
    const processedCount = occurrences.filter(o => o.status === 'processed').length;
    const autoCount = occurrences.filter(o => o.plan_auto_process && ['pending', 'due', 'overdue'].includes(o.status)).length;

    return { pendingTotal, pendingCount, overdueCount, processedCount, autoCount };
  }, [occurrences]);

  const getStatusColorClass = (status: string, dateStr: string) => {
    if (status === 'processed') return 'bg-green-50 border-green-200 text-green-700';
    if (status === 'skipped' || status === 'cancelled') return 'bg-gray-50 border-gray-200 text-gray-500 line-through opacity-70';

    const todayStr = new Date().toISOString().split('T')[0];
    if (dateStr < todayStr) return 'bg-red-50 border-red-200 text-red-700'; // overdue visually
    if (dateStr === todayStr) return 'bg-amber-50 border-amber-200 text-amber-700'; // due today

    return 'bg-blue-50 border-blue-200 text-blue-700'; // upcoming
  };

  return (
    <div className="space-y-6 animate-in slide-in-from-bottom-4 duration-500 max-w-[1600px] mx-auto pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-text-main tracking-tight">Ödeme Takvimi</h2>
          <p className="text-xs lg:text-sm text-text-muted">Aylık finansal yükümlülüklerinizi (kira, elektrik, aidat, muhasebe vb.) takip edin ve yönetin.</p>
        </div>
        {!isReadOnly && (
          <div className="flex items-center space-x-2 sm:space-x-3 w-full sm:w-auto">
            <button
              disabled={loading}
              onClick={processDuePayments}
              className="flex-1 sm:flex-none flex items-center justify-center px-4 sm:px-5 py-2.5 bg-success text-white rounded-xl font-bold text-sm shadow-lg shadow-green-100 hover:scale-[1.02] transition-all disabled:opacity-50"
            >
              <PlayCircle className="w-4 h-4 mr-2" />
              <span className="truncate">Otomatik İşle (Vadesi Gelenler)</span>
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="flex-1 sm:flex-none flex items-center justify-center px-4 sm:px-5 py-2.5 bg-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-blue-100 hover:scale-[1.02] transition-all"
            >
              <Plus className="w-4 h-4 mr-2" />
              <span className="truncate">Plan Ekle</span>
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
         <div className="card p-4">
            <p className="text-[10px] uppercase font-bold text-text-muted">Bu Ay Bekleyen İşlem</p>
            <p className="text-2xl font-black mt-1">{stats.pendingCount}</p>
         </div>
         <div className="card p-4">
            <p className="text-[10px] uppercase font-bold text-text-muted">Bu Ay Bekleyen Tutar</p>
            <p className="text-2xl font-black mt-1 text-primary"><FormatAmount amount={stats.pendingTotal} /></p>
         </div>
         <div className="card p-4">
            <p className="text-[10px] uppercase font-bold text-text-muted">Otomatik İşlenecek</p>
            <p className="text-2xl font-black mt-1 text-blue-600">{stats.autoCount}</p>
         </div>
         <div className="card p-4">
            <p className="text-[10px] uppercase font-bold text-text-muted">Geciken Ödeme</p>
            <p className="text-2xl font-black mt-1 text-red-600">{stats.overdueCount}</p>
         </div>
         <div className="card p-4 bg-success text-white">
            <p className="text-[10px] uppercase font-bold opacity-80">İşlenen Ödeme</p>
            <p className="text-2xl font-black mt-1">{stats.processedCount}</p>
         </div>
      </div>

      {/* Calendar */}
      <div className="card shadow-md border-none overflow-hidden flex flex-col bg-white">
        <div className="px-5 py-4 border-b border-border-color flex justify-between items-center bg-white">
          <div className="flex items-center space-x-4">
            <h3 className="text-xl font-black text-text-main w-48">{monthInfo.monthName}</h3>
            <div className="flex items-center space-x-1 p-1 bg-bg-main rounded-xl border border-border-color">
              <button onClick={() => changeMonth(-1)} className="p-1.5 hover:bg-white rounded-lg text-text-muted transition-all">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => setViewDate(new Date())} className="px-3 py-1 text-xs font-bold text-text-main hover:bg-white rounded-lg transition-all">Bugün</button>
              <button onClick={() => changeMonth(1)} className="p-1.5 hover:bg-white rounded-lg text-text-muted transition-all">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="hidden md:flex items-center space-x-6 text-[10px] font-bold text-text-muted uppercase tracking-widest">
            <div className="flex items-center"><div className="w-2.5 h-2.5 rounded-full bg-green-500 mr-2" /> İşlendi</div>
            <div className="flex items-center"><div className="w-2.5 h-2.5 rounded-full bg-blue-500 mr-2" /> Yaklaşan</div>
            <div className="flex items-center"><div className="w-2.5 h-2.5 rounded-full bg-amber-500 mr-2" /> Bugün</div>
            <div className="flex items-center"><div className="w-2.5 h-2.5 rounded-full bg-red-500 mr-2" /> Gecikti</div>
            <div className="flex items-center"><div className="w-2.5 h-2.5 rounded-full bg-gray-400 mr-2" /> Pasif</div>
          </div>
        </div>

        <div className="hidden sm:grid grid-cols-7 bg-bg-main border-b border-border-color">
           {['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map(d => (
             <div key={d} className="py-2.5 text-center text-[10px] font-black text-text-muted uppercase tracking-widest border-r border-border-color last:border-0">{d}</div>
           ))}
        </div>

        <div className="flex-1 grid grid-cols-1 sm:grid-cols-7 auto-rows-fr bg-[#F1F5F9] gap-[1px]">
           {monthInfo.calendarDays.map((d, idx) => (
             <div
               key={idx}
               className={cn(
                 "p-2 bg-white flex flex-col group min-h-[120px] transition-all relative overflow-hidden",
                 d.blank ? "bg-bg-main/30 hidden sm:flex" : "",
                 d.current ? "bg-blue-50/10" : ""
               )}
             >
                {!d.blank && (
                  <>
                    <div className="flex justify-between items-start mb-2">
                      <span className={cn(
                        "w-6 h-6 flex items-center justify-center rounded-lg text-xs font-bold",
                        d.current ? "bg-primary text-white scale-110 shadow-sm" : "text-text-muted group-hover:text-text-main"
                      )}>
                        {d.day}
                      </span>
                    </div>

                    <div className="flex-1 space-y-1.5 overflow-y-auto custom-scrollbar">
                       {d.occurrences?.map((occ: any, occIdx: number) => (
                         <div
                           key={occ.id}
                           onClick={() => setSelectedOccurrence(occ)}
                           className={cn(
                             "px-2 py-1.5 rounded-md border text-[10px] font-bold flex flex-col transition-all shadow-sm cursor-pointer hover:shadow-md",
                             getStatusColorClass(occ.status, d.dateStr!)
                           )}
                         >
                            <div className="flex items-center justify-between">
                              <div className="flex flex-col min-w-0 flex-1">
                                <span className="truncate leading-tight mb-0.5" title={occ.plan_title}>{occ.plan_title}</span>
                                <span className="truncate text-[8px] opacity-70">
                                  {(!occ.plan_frequency || occ.plan_frequency === 'monthly') && 'Aylık'}
                                  {occ.plan_frequency === 'quarterly' && '3 Ayda Bir'}
                                  {occ.plan_frequency === 'semi_annually' && '6 Ayda Bir'}
                                  {occ.plan_frequency === 'yearly' && 'Yıllık'}
                                  {occ.plan_frequency === 'weekly' && 'Haftalık'}
                                  {occ.plan_frequency === 'custom' && 'Özel'}
                                </span>
                              </div>
                              <span title="Otomatik İşleme Açık" className="ml-1 flex-shrink-0">
                                {occ.plan_auto_process ? <SettingsIcon className="w-3 h-3 opacity-50" /> : null}
                              </span>
                            </div>
                            <div className="flex justify-between items-center mt-1">
                               <span className="font-black text-[11px]"><FormatAmount amount={occ.amount} /></span>
                            </div>
                         </div>
                       ))}
                    </div>
                  </>
                )}
             </div>
           ))}
        </div>
      </div>

     {/* Occurrence Action Modal */}
     {selectedOccurrence && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
           <div className="absolute inset-0 bg-[#0F172A]/40 backdrop-blur-sm" onClick={() => setSelectedOccurrence(null)}></div>
           <div className="bg-white w-full max-w-sm rounded-[24px] shadow-2xl flex flex-col relative animate-in zoom-in-95 duration-200">
              <div className="p-6">
                 <h3 className="text-lg font-black">{selectedOccurrence.plan_title}</h3>
                 <p className="text-xs text-text-muted">Vade: {new Date(selectedOccurrence.due_date).toLocaleDateString()}</p>

                 <div className="mt-4 p-4 rounded-xl bg-bg-main border border-border-color space-y-2">
                    <div className="flex justify-between text-sm">
                       <span className="text-text-muted">Tutar</span>
                       <span className="font-black text-primary"><FormatAmount amount={selectedOccurrence.amount} /></span>
                    </div>
                    <div className="flex justify-between text-sm">
                       <span className="text-text-muted">Durum</span>
                       <span className="font-bold uppercase text-[10px] mt-0.5">{selectedOccurrence.status}</span>
                    </div>
                 </div>

                 {!isReadOnly && selectedOccurrence.status !== 'processed' && selectedOccurrence.status !== 'cancelled' && (
                   <div className="mt-6 space-y-2">
                     <button onClick={() => handleOccurrenceAction(selectedOccurrence.id, 'process')} className="w-full btn-success py-3 text-sm">
                        Kasaya İşle (Gider Ekle)
                     </button>
                     <div className="flex gap-2">
                       <button onClick={() => handleOccurrenceAction(selectedOccurrence.id, 'skip')} className="flex-1 btn-secondary py-2 text-xs">Atla</button>
                       <button onClick={() => handleOccurrenceAction(selectedOccurrence.id, 'cancel')} className="flex-1 btn-danger py-2 text-xs">İptal Et</button>
                     </div>
                   </div>
                 )}
                 {selectedOccurrence.status === 'processed' && (
                   <div className="mt-6 text-center text-sm font-bold text-success border border-success/20 bg-green-50 rounded-xl py-3">
                      Bu ödeme kasaya işlenmiştir. (Gider no: {selectedOccurrence.expense_id?.substring(0,6)}...)
                   </div>
                 )}
              </div>
           </div>
        </div>
     )}

      {/* Plans List below calendar */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 flex justify-between items-center border-b border-border-color">
          <h3 className="font-bold text-lg">Aktif Ödeme Planları</h3>
        </div>
        <table className="w-full text-left text-sm min-w-[800px]">
           <thead>
             <tr className="bg-bg-main text-[10px] font-black text-text-muted uppercase tracking-widest border-b border-border-color">
                <th className="px-6 py-3">Başlık</th>
                <th className="px-6 py-3">Frekans / Gün</th>
                <th className="px-6 py-3">Kategori</th>
                <th className="px-6 py-3 text-right">Tutar</th>
                <th className="px-6 py-3 text-center">Oto</th>
                <th className="px-6 py-3 text-right"></th>
             </tr>
           </thead>
           <tbody className="divide-y divide-border-color">
             {plans.map(p => (
                <tr key={p.id}>
                   <td className="px-6 py-4 font-bold text-text-main">{p.title}</td>
                   <td className="px-6 py-4">
                     {p.frequency === 'monthly' && `Aylık / ${p.due_day}. Gün`}
                     {p.frequency === 'quarterly' && `3 Ayda Bir / ${p.start_month}. Aydan İtibaren ${p.due_day}. Gün`}
                     {p.frequency === 'semi_annually' && `6 Ayda Bir / ${p.start_month}. Aydan İtibaren ${p.due_day}. Gün`}
                     {p.frequency === 'yearly' && `Yıllık / ${p.due_month}. Ay, ${p.due_day}. Gün`}
                     {p.frequency === 'weekly' && `Haftalık / ${['Pzt','Sal','Çar','Per','Cum','Cmt','Pzr'][(p.week_day || 1)-1]}`}
                     {p.frequency === 'custom' && `${p.custom_interval_days} Günde Bir`}
                   </td>
                   <td className="px-6 py-4"><span className="px-2 py-1 bg-gray-100 rounded-md text-[10px] font-bold">{p.category}</span></td>
                   <td className="px-6 py-4 font-black text-right"><FormatAmount amount={p.amount} /></td>
                   <td className="px-6 py-4 text-center">
                      <div className={cn("inline-flex w-4 h-4 rounded-full border items-center justify-center", p.auto_process ? "bg-green-500 border-green-600" : "bg-gray-200 border-gray-300")}>
                        {p.auto_process && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>
                   </td>
                   <td className="px-6 py-4 text-right">
                     {!isReadOnly && <button onClick={() => handleDeletePlan(p.id)} className="p-1 text-text-muted hover:text-red-500"><Trash2 className="w-4 h-4"/></button>}
                   </td>
                </tr>
             ))}
             {plans.length === 0 && (
                <tr><td colSpan={6} className="px-6 py-8 text-center text-text-muted">Plan kaydı bulunamadı.</td></tr>
             )}
           </tbody>
        </table>
      </div>

      {!isReadOnly && showAdd && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
           <div className="absolute inset-0 bg-[#0F172A]/40 backdrop-blur-sm" onClick={() => setShowAdd(false)}></div>
           <div className="bg-white w-full max-w-xl rounded-[32px] shadow-2xl flex flex-col overflow-hidden relative animate-in zoom-in-95 duration-300 max-h-[90vh]">
              <div className="px-8 py-6 border-b border-border-color flex items-center justify-between bg-bg-main">
                <div>
                  <h3 className="font-black text-xl text-text-main">Yeni Ödeme Planı</h3>
                </div>
                <button onClick={() => setShowAdd(false)} className="p-2 hover:bg-white rounded-xl text-text-muted">
                  <Plus className="w-5 h-5 rotate-45" />
                </button>
              </div>
              <form onSubmit={handleCreatePlan} className="p-8 space-y-6 overflow-y-auto">
                 <div className="space-y-4">
                    <div className="space-y-2">
                       <label className="text-xs font-bold text-text-main">Başlık (Kira, Muhasebe vb.)</label>
                       <input required value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} className="form-input" />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="space-y-2">
                          <label className="text-xs font-bold text-text-main">Ödeme Sıklığı</label>
                          <select value={formData.frequency || 'monthly'} onChange={e => {
                             const f = e.target.value;
                             setFormData({...formData, frequency: f});
                          }} className="form-input">
                             <option value="monthly">Her Ay</option>
                             <option value="quarterly">3 Ayda Bir</option>
                             <option value="semi_annually">6 Ayda Bir</option>
                             <option value="yearly">Yılda Bir</option>
                             <option value="weekly">Haftalık</option>
                             <option value="custom">Özel Aralık</option>
                          </select>
                       </div>
                       <div className="space-y-2">
                          <label className="text-xs font-bold text-text-main">Kategori</label>
                          <select value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} className="form-input">
                             {settings?.expense_categories.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                       </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="space-y-2">
                          <label className="text-xs font-bold text-text-main">Tutar</label>
                          <div className="flex gap-2">
                            <input type="number" step="0.01" min="0.01" required value={formData.amount} onChange={e => setFormData({...formData, amount: parseFloat(e.target.value)})} className="form-input flex-1" />
                            <select value={formData.currency || 'TRY'} onChange={e => setFormData({...formData, currency: e.target.value})} className="form-input w-24">
                              <option value="TRY">₺</option>
                              <option value="USD">$</option>
                              <option value="EUR">€</option>
                            </select>
                          </div>
                       </div>

                       {['monthly', 'quarterly', 'semi_annually'].includes(formData.frequency || 'monthly') && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">Ayın kaçında?</label>
                            <input type="number" min="1" max="31" required value={formData.due_day || ''} onChange={e => setFormData({...formData, due_day: parseInt(e.target.value)})} className="form-input" />
                         </div>
                       )}

                       {formData.frequency === 'yearly' && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">Hangi ayda?</label>
                            <select required value={formData.due_month || 1} onChange={e => setFormData({...formData, due_month: parseInt(e.target.value)})} className="form-input">
                              {['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'].map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                            </select>
                         </div>
                       )}

                       {formData.frequency === 'yearly' && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">Ayın kaçında?</label>
                            <input type="number" min="1" max="31" required value={formData.due_day || ''} onChange={e => setFormData({...formData, due_day: parseInt(e.target.value)})} className="form-input" />
                         </div>
                       )}

                       {['quarterly', 'semi_annually'].includes(formData.frequency || '') && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">İlk ödeme ayı</label>
                            <select required value={formData.start_month || 1} onChange={e => setFormData({...formData, start_month: parseInt(e.target.value)})} className="form-input">
                               {['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'].map((m, i) => <option key={i} value={i+1}>{m}</option>)}
                            </select>
                         </div>
                       )}

                       {formData.frequency === 'weekly' && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">Haftanın Hangi Günü?</label>
                            <select required value={formData.week_day || 1} onChange={e => setFormData({...formData, week_day: parseInt(e.target.value)})} className="form-input">
                               <option value="1">Pazartesi</option>
                               <option value="2">Salı</option>
                               <option value="3">Çarşamba</option>
                               <option value="4">Perşembe</option>
                               <option value="5">Cuma</option>
                               <option value="6">Cumartesi</option>
                               <option value="7">Pazar</option>
                            </select>
                         </div>
                       )}

                       {formData.frequency === 'custom' && (
                         <div className="space-y-2">
                            <label className="text-xs font-bold text-text-main">Kaç günde bir?</label>
                            <input type="number" min="1" required value={formData.custom_interval_days || ''} onChange={e => setFormData({...formData, custom_interval_days: parseInt(e.target.value)})} className="form-input" />
                         </div>
                       )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="space-y-2">
                          <label className="text-xs font-bold text-text-main">Başlangıç Tarihi</label>
                          <input type="date" required value={formData.start_date || ''} onChange={e => setFormData({...formData, start_date: e.target.value})} className="form-input" />
                       </div>
                       <div className="space-y-2">
                          <label className="text-xs font-bold text-text-main">Bitiş Tarihi (Opsiyonel)</label>
                          <input type="date" value={formData.end_date || ''} onChange={e => setFormData({...formData, end_date: e.target.value})} className="form-input" />
                       </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                       <div className="space-y-2 flex items-end">
                         <label className="flex items-center space-x-3 bg-bg-main p-3 rounded-xl w-full cursor-pointer hover:bg-gray-100 transition-colors">
                           <input type="checkbox" checked={formData.auto_process} onChange={e => setFormData({...formData, auto_process: e.target.checked})} className="rounded text-primary focus:ring-primary h-5 w-5 border-gray-300" />
                           <span className="text-sm font-bold text-text-main">Otomatik İşle (Kasaya Düş)</span>
                         </label>
                       </div>
                    </div>

                    <div className="space-y-2">
                       <label className="text-xs font-bold text-text-main">Notlar</label>
                       <input value={formData.notes || ''} onChange={e => setFormData({...formData, notes: e.target.value})} className="form-input" placeholder="Opsiyonel..." />
                    </div>

                 </div>

                 <button disabled={loading} className="w-full btn-primary py-4 mt-6 font-black text-lg">
                   {loading ? 'Kaydediliyor...' : 'Planı Oluştur'}
                 </button>
              </form>
           </div>
        </div>
      )}
    </div>
  );
}

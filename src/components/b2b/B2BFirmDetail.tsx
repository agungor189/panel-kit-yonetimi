import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { ArrowLeft, Building2, MapPin, Globe, Phone, Mail, User, Link, Package, FileText, CheckCircle2, Clock, X, MessageSquare, Briefcase } from 'lucide-react';
import { useAuth } from '../../App';
import { Button, Card, EmptyState, Input, LoadingState, Select, cn } from '../ui';

export default function B2BFirmDetail({ firmId, onBack }: any) {
  const [firm, setFirm] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('notes'); // notes, offers, followups
  const { isReadOnly } = useAuth();

  useEffect(() => {
    loadFirm();
  }, [firmId]);

  const loadFirm = async () => {
    try {
      const data = await api.get(`/b2b/firms/${firmId}`);
      setFirm(data);
    } catch (err) {
      console.error(err);
    }
  };

  const updateStatus = async (newStatus: string) => {
    if (isReadOnly) return;
    try {
      await api.put(`/b2b/firms/${firmId}`, { ...firm, status: newStatus });
      loadFirm();
    } catch (err) {
      console.error(err);
    }
  };

  if (!firm) return <LoadingState label="Firma yükleniyor..." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Button variant="secondary" onClick={onBack} className="h-10 w-10 rounded-xl p-0 text-text-muted shadow-sm hover:text-text-main">
           <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          {['Yeni', 'İncelendi', 'Ulaşıldı', 'Teklif Verildi', 'Müşteri Oldu', 'Olumsuz'].map(s => (
             <Button variant={firm.status === s ? 'primary' : 'secondary'} size="sm"
               key={s} 
               onClick={() => updateStatus(s)}
               className={cn(
                 "rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all",
                 firm.status === s ? "bg-primary text-white shadow" : "bg-white border border-border-color text-text-muted hover:bg-bg-main"
               )}
             >{s}</Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <Card padding="md" className="divide-y divide-border-color">
             <div className="pb-6">
                <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center mb-4">
                  <Building2 className="w-6 h-6 text-primary" />
                </div>
                <h1 className="text-xl font-bold text-text-main">{firm.name}</h1>
                <p className="text-sm font-semibold text-text-muted flex items-center mt-2">
                  <MapPin className="w-4 h-4 mr-1" />
                  {firm.city || 'Şehir Belirtilmemiş'} • {firm.sector || 'Sektör Belirtilmemiş'}
                </p>
             </div>
             
             <div className="py-6 space-y-4">
                <InfoRow icon={User} label="YETKİLİ" value={firm.contact_person} />
                <InfoRow icon={Phone} label="TELEFON" value={firm.phone} />
                <InfoRow icon={Mail} label="E-POSTA" value={firm.email} />
                <InfoRow icon={Globe} label="WEB" value={firm.website} isLink />
                <InfoRow icon={Link} label="KAYNAK URL" value={firm.source_url} isLink />
                <InfoRow icon={Package} label="İLGİLİ ÜRÜN" value={firm.related_product} />
             </div>
             
             {firm.notes && (
               <div className="pt-6">
                 <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-2">NOTLAR</h4>
                 <p className="text-sm text-text-main whitespace-pre-wrap">{firm.notes}</p>
               </div>
             )}
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <div className="flex space-x-2 p-1 bg-white rounded-2xl border border-border-color shadow-sm">
             {['notes', 'offers', 'follow_ups'].map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "flex-1 py-3 text-sm font-bold rounded-xl transition-all capitalize",
                    activeTab === tab ? "bg-bg-main text-primary shadow-sm" : "text-text-muted hover:text-text-main hover:bg-gray-50"
                  )}
                >
                  {tab === 'notes' ? 'Takip Notları' : tab === 'offers' ? 'Teklifler' : 'Planlanan Takipler'}
                </button>
             ))}
          </div>

          <Card padding="md" className="min-h-[400px]">
             {activeTab === 'notes' && <FirmNotes firmId={firmId} initialNotes={firm.notes_list || []} onRefresh={loadFirm} />}
             {activeTab === 'offers' && <FirmOffers firmId={firmId} initialOffers={firm.offers || []} onRefresh={loadFirm} />}
             {activeTab === 'follow_ups' && <FirmFollowUps firmId={firmId} initialFollowUps={firm.follow_ups || []} onRefresh={loadFirm} />}
          </Card>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, isLink }: any) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mb-1 flex items-center">
        <Icon className="w-3 h-3 mr-1" /> {label}
      </p>
      {isLink ? (
        <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noreferrer" className="text-sm font-semibold text-primary hover:underline break-all">
          {value}
        </a>
      ) : (
        <p className="text-sm font-semibold text-text-main">{value}</p>
      )}
    </div>
  );
}

function FirmNotes({ firmId, initialNotes, onRefresh }: any) {
  const [note, setNote] = useState('');
  
  const handleAdd = async (e: any) => {
    e.preventDefault();
    if (!note) return;
    try {
      await api.post(`/b2b/firms/${firmId}/notes`, { note });
      setNote('');
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleAdd} className="flex gap-4">
        <Input
          containerClassName="flex-1"
          type="text" 
          value={note} 
          onChange={e => setNote(e.target.value)} 
          placeholder="Yeni takip notu ekle..." 
          className="flex-1 px-4 py-2 bg-bg-main border border-border-color rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary"
        />
        <Button type="submit" className="rounded-xl px-6 py-2 font-bold shadow-md">Ekle</Button>
      </form>
      <div className="space-y-4">
        {initialNotes.map((n: any) => (
          <div key={n.id} className="p-4 bg-bg-main rounded-xl border border-border-color">
            <p className="text-sm text-text-main font-semibold mb-2">{n.note}</p>
            <p className="text-[10px] text-text-muted font-mono">{new Date(n.created_at).toLocaleString('tr-TR')}</p>
          </div>
        ))}
        {initialNotes.length === 0 && <EmptyState title="Henüz not eklenmemiş." className="py-4" />}
      </div>
    </div>
  );
}

function FirmOffers({ firmId, initialOffers, onRefresh }: any) {
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({ title: '', description: '', amount: '', currency: '₺', status: 'Taslak' });

  const handleAdd = async (e: any) => {
    e.preventDefault();
    try {
      await api.post('/b2b/offers', { ...formData, firm_id: firmId });
      setShowAdd(false);
      setFormData({ title: '', description: '', amount: '', currency: '₺', status: 'Taslak' });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.put(`/b2b/offers/${id}/status`, { status });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {!showAdd ? (
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-text-main">Teklif Geçmişi</h3>
          <Button onClick={() => setShowAdd(true)} className="rounded-xl px-4 py-2 font-bold hover:scale-[1.02]">Teklif Ekle</Button>
        </div>
      ) : (
        <div className="bg-bg-main p-4 rounded-xl border border-border-color">
          <form onSubmit={handleAdd} className="space-y-4">
            <Input required type="text" placeholder="Teklif Başlığı" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} className="w-full px-4 py-2 border rounded-xl text-sm" />
            <textarea placeholder="Açıklama" value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} className="w-full px-4 py-2 border rounded-xl text-sm" />
            <div className="flex gap-4">
              <Input containerClassName="flex-1" type="number" placeholder="Tutar" value={formData.amount} onChange={e => setFormData({...formData, amount: e.target.value})} className="px-4 py-2 border rounded-xl text-sm" />
              <Select containerClassName="w-24" value={formData.currency} onChange={e => setFormData({...formData, currency: e.target.value})} className="w-24 px-4 py-2 border rounded-xl text-sm">
                <option value="₺">₺</option>
                <option value="$">$</option>
                <option value="€">€</option>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setShowAdd(false)} className="rounded-xl px-4 py-2 font-bold">İptal</Button>
              <Button type="submit" className="rounded-xl px-4 py-2 font-bold">Kaydet</Button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-4">
        {initialOffers.map((o: any) => (
          <div key={o.id} className="p-4 bg-white border border-border-color rounded-xl flex justify-between items-start shadow-sm">
            <div>
              <h4 className="font-bold text-text-main">{o.title}</h4>
              <p className="text-sm text-text-muted mt-1">{o.description}</p>
              <div className="text-[10px] text-text-muted font-mono mt-3">{new Date(o.created_at).toLocaleString('tr-TR')}</div>
            </div>
            <div className="text-right flex flex-col items-end gap-2">
              <div className="font-bold text-lg text-primary">{o.amount || 0} {o.currency}</div>
              <Select
                value={o.status} 
                onChange={(e) => updateStatus(o.id, e.target.value)}
                className={cn(
                  "px-2 py-1 text-xs font-bold rounded border uppercase tracking-wider outline-none cursor-pointer",
                  o.status === 'Kabul Edildi' ? 'bg-green-50 text-green-600 border-green-200' : 
                  o.status === 'Reddedildi' ? 'bg-red-50 text-red-600 border-red-200' :
                  'bg-gray-50 text-gray-600 border-gray-200'
                )}
              >
                <option value="Taslak">Taslak</option>
                <option value="Gönderildi">Gönderildi</option>
                <option value="Kabul Edildi">Kabul Edildi</option>
                <option value="Reddedildi">Reddedildi</option>
                <option value="Revize Edilecek">Revize</option>
              </Select>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FirmFollowUps({ firmId, initialFollowUps, onRefresh }: any) {
  const [showAdd, setShowAdd] = useState(false);
  const [formData, setFormData] = useState({ type: 'Arama', note: '', next_follow_up_date: '' });

  const handleAdd = async (e: any) => {
    e.preventDefault();
    try {
      await api.post('/b2b/follow-ups', { ...formData, firm_id: firmId });
      setShowAdd(false);
      setFormData({ type: 'Arama', note: '', next_follow_up_date: '' });
      onRefresh();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {!showAdd ? (
        <div className="flex justify-between items-center">
          <h3 className="font-bold text-text-main">Planlanan Takipler</h3>
          <Button onClick={() => setShowAdd(true)} className="rounded-xl px-4 py-2 font-bold hover:scale-[1.02]">Takip Ekle</Button>
        </div>
      ) : (
        <div className="bg-bg-main p-4 rounded-xl border border-border-color">
          <form onSubmit={handleAdd} className="space-y-4">
            <Select value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})} className="w-full px-4 py-2 border rounded-xl text-sm">
              <option value="Arama">Arama Yapılacak</option>
              <option value="E-Posta">E-Posta Gönderilecek</option>
              <option value="Toplantı">Toplantı / Görüşme</option>
              <option value="Ziyaret">Firma Ziyareti</option>
            </Select>
            <textarea required placeholder="Takip Notu" value={formData.note} onChange={e => setFormData({...formData, note: e.target.value})} className="w-full px-4 py-2 border rounded-xl text-sm" />
            <Input type="datetime-local" required value={formData.next_follow_up_date} onChange={e => setFormData({...formData, next_follow_up_date: e.target.value})} className="w-full px-4 py-2 border rounded-xl text-sm" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setShowAdd(false)} className="rounded-xl px-4 py-2 font-bold">İptal</Button>
              <Button type="submit" className="rounded-xl px-4 py-2 font-bold">Kaydet</Button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-4">
        {initialFollowUps.map((fu: any) => (
          <div key={fu.id} className="p-4 bg-white border border-border-color rounded-xl flex justify-between items-start shadow-sm line-l-4">
            <div className="flex-1">
              <h4 className="font-bold text-text-main uppercase text-[10px] tracking-widest">{fu.type}</h4>
              <p className="text-sm font-semibold mt-1">{fu.note}</p>
              <div className="text-xs text-text-muted mt-2">Tarih: {new Date(fu.next_follow_up_date).toLocaleString('tr-TR')}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

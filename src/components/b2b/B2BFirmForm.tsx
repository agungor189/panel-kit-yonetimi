import React, { useState } from 'react';
import { Building2, MapPin, Globe, Phone, Mail, User, Link, Package, FileText, Briefcase } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Modal } from '../ui';

export default function B2BFirmForm({ onClose, onSave }: any) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    sector: '',
    city: '',
    website: '',
    phone: '',
    email: '',
    contact_person: '',
    source_url: '',
    related_product: '',
    status: 'Yeni',
    notes: ''
  });

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    if (!formData.name) return alert('Firma adı zorunludur.');
    setLoading(true);
    try {
      await api.post('/b2b/firms', formData);
      onSave(); // Refresh data
      onClose();
    } catch (err) {
      console.error(err);
      alert('Kayıt edilemedi');
    } finally {
      setLoading(false);
    }
  };

  const InputField = ({ label, icon: Icon, ...props }: any) => (
    <div>
      <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest block ml-1 mb-1">{label}</label>
      <div className="relative">
        {Icon && <Icon className="w-4 h-4 text-text-muted absolute left-3 top-2.5" />}
        <input 
          {...props} 
          className={`w-full ${Icon ? 'pl-9' : 'px-3'} pr-4 py-2 bg-bg-main border border-border-color rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary`} 
        />
      </div>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Firma Ekle"
      size="lg"
      className="max-w-2xl rounded-[24px] animate-in fade-in zoom-in duration-200"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} className="rounded-xl font-bold">İptal</Button>
          <Button form="firm-form" type="submit" loading={loading} loadingText="Kaydediliyor..." className="rounded-xl font-bold shadow-lg shadow-primary/20">Firmayı Kaydet</Button>
        </>
      )}
    >
          <form id="firm-form" onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InputField label="Firma Adı *" value={formData.name} onChange={(e: any) => setFormData({...formData, name: e.target.value})} icon={Building2} required />
              <InputField label="Sektör" value={formData.sector} onChange={(e: any) => setFormData({...formData, sector: e.target.value})} icon={Briefcase} />
              
              <InputField label="Şehir" value={formData.city} onChange={(e: any) => setFormData({...formData, city: e.target.value})} icon={MapPin} />
              <InputField label="Web Sitesi" value={formData.website} onChange={(e: any) => setFormData({...formData, website: e.target.value})} icon={Globe} />
              
              <InputField label="Yetkili Kişi" value={formData.contact_person} onChange={(e: any) => setFormData({...formData, contact_person: e.target.value})} icon={User} />
              <InputField label="Telefon" value={formData.phone} onChange={(e: any) => setFormData({...formData, phone: e.target.value})} icon={Phone} />
              
              <InputField label="E-Posta" type="email" value={formData.email} onChange={(e: any) => setFormData({...formData, email: e.target.value})} icon={Mail} />
              <InputField label="Kaynak URL (Bulunan link)" value={formData.source_url} onChange={(e: any) => setFormData({...formData, source_url: e.target.value})} icon={Link} />
              
              <div className="md:col-span-2">
                <InputField label="İlgili Ürün (Satılmak istenen)" value={formData.related_product} onChange={(e: any) => setFormData({...formData, related_product: e.target.value})} icon={Package} />
              </div>

              <div className="md:col-span-2">
                <label className="text-[10px] font-bold text-text-muted uppercase tracking-widest block ml-1 mb-1">Notlar</label>
                <div className="relative">
                  <FileText className="w-4 h-4 text-text-muted absolute left-3 top-3" />
                  <textarea 
                    value={formData.notes}
                    onChange={(e) => setFormData({...formData, notes: e.target.value})}
                    rows={3}
                    className="w-full pl-9 pr-4 py-2 bg-bg-main border border-border-color rounded-xl text-sm font-semibold outline-none focus:ring-2 focus:border-primary resize-none"
                  ></textarea>
                </div>
              </div>
            </div>
          </form>
    </Modal>
  );
}

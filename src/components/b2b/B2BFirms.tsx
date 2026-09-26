import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { Building2, Search, Plus, Filter, MessageSquare, Briefcase, ChevronRight } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, cn } from '../ui';

import B2BFirmDetail from './B2BFirmDetail';
import B2BFirmForm from './B2BFirmForm';

export default function B2BFirms({ onFirmClick, onAddFirm }: any) {
  const [firms, setFirms] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [filterSector, setFilterSector] = useState('Hepsi');
  const [filterCity, setFilterCity] = useState('Hepsi');
  const [filterStatus, setFilterStatus] = useState('Hepsi');

  useEffect(() => {
    loadFirms();
  }, []);

  const loadFirms = async () => {
    try {
      const data = await api.get('/b2b/firms');
      setFirms(data);
    } catch (err) {
      console.error(err);
    }
  };

  const sectors = ['Hepsi', ...new Set(firms.map(f => f.sector).filter(Boolean))];
  const cities = ['Hepsi', ...new Set(firms.map(f => f.city).filter(Boolean))];
  const statuses = ['Hepsi', 'Yeni', 'İncelendi', 'Ulaşıldı', 'Teklif Verildi', 'Müşteri Oldu', 'Olumsuz'];

  const filteredFirms = firms.filter(f => {
    const matchesSearch = f.name?.toLowerCase().includes(search.toLowerCase()) || f.contact_person?.toLowerCase().includes(search.toLowerCase());
    const matchesSector = filterSector === 'Hepsi' || f.sector === filterSector;
    const matchesCity = filterCity === 'Hepsi' || f.city === filterCity;
    const matchesStatus = filterStatus === 'Hepsi' || f.status === filterStatus;
    return matchesSearch && matchesSector && matchesCity && matchesStatus;
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Firma Listesi" actions={<Button onClick={onAddFirm} className="rounded-xl px-4 py-2 font-bold shadow shadow-primary/20 hover:scale-[1.02]">
          <Plus className="w-4 h-4 mr-2" />
          Firma Ekle
        </Button>} />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="relative">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-3.5" />
          <Input
            type="text" 
            placeholder="Firma veya kişi ara..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-bg-main border border-border-color rounded-xl text-sm outline-none"
          />
        </div>
        
        <Select value={filterSector} onChange={e => setFilterSector(e.target.value)} className="px-4 py-2.5 bg-bg-main border border-border-color rounded-xl text-sm outline-none font-semibold">
          {sectors.map((s: any) => <option key={s} value={s}>{s}</option>)}
        </Select>
        
        <Select value={filterCity} onChange={e => setFilterCity(e.target.value)} className="px-4 py-2.5 bg-bg-main border border-border-color rounded-xl text-sm outline-none font-semibold">
          {cities.map((s: any) => <option key={s} value={s}>{s}</option>)}
        </Select>
        
        <Select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-4 py-2.5 bg-bg-main border border-border-color rounded-xl text-sm outline-none font-semibold">
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>

      <Card className="overflow-x-auto text-sm">
        <table className="w-full text-left min-w-[800px]">
          <thead>
            <tr className="bg-bg-main text-text-muted uppercase tracking-widest text-[10px] font-bold border-b border-border-color">
              <th className="px-6 py-4">Firma Adı</th>
              <th className="px-6 py-4">Sektör / Şehir</th>
              <th className="px-6 py-4">İletişim</th>
              <th className="px-6 py-4">Durum</th>
              <th className="px-6 py-4">Tarih</th>
              <th className="px-6 py-4 text-center">İşlem</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-color">
            {filteredFirms.map(firm => (
              <tr key={firm.id} className="hover:bg-bg-main/50 transition-colors">
                <td className="px-6 py-4 font-bold text-text-main">
                  <div>{firm.name}</div>
                  {firm.website && <a href={firm.website.startsWith('http') ? firm.website : `https://${firm.website}`} target="_blank" rel="noreferrer" className="text-[10px] text-primary hover:underline">{firm.website}</a>}
                </td>
                <td className="px-6 py-4">
                  <div className="font-semibold text-text-main">{firm.sector || '-'}</div>
                  <div className="text-[10px] text-text-muted">{firm.city || '-'}</div>
                </td>
                <td className="px-6 py-4">
                  <div className="font-semibold text-text-main">{firm.contact_person || '-'}</div>
                  <div className="text-[10px] text-text-muted">{firm.phone || '-'} / {firm.email || '-'}</div>
                </td>
                <td className="px-6 py-4">
                  <Badge className={cn(
                    "rounded px-2 py-1 text-[10px] tracking-widest uppercase",
                    firm.status === 'Yeni' ? "bg-blue-50 text-blue-600 border-blue-200" :
                    firm.status === 'Müşteri Oldu' ? "bg-green-50 text-green-600 border-green-200" :
                    firm.status === 'Olumsuz' ? "bg-red-50 text-red-600 border-red-200" :
                    "bg-gray-50 text-gray-600 border-gray-200"
                  )}>{firm.status || 'Yeni'}</Badge>
                </td>
                <td className="px-6 py-4 text-text-muted text-[11px] font-mono">
                  {new Date(firm.created_at).toLocaleDateString('tr-TR')}
                </td>
                <td className="px-6 py-4 text-center">
                  <button onClick={() => onFirmClick(firm.id)} className="w-8 h-8 inline-flex items-center justify-center rounded-xl border border-border-color hover:bg-primary hover:text-white hover:border-primary transition-colors">
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredFirms.length === 0 && (
          <EmptyState title="Firma bulunamadı." className="py-8" />
        )}
      </Card>
    </div>
  );
}

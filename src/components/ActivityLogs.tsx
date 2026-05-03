import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Activity, Clock, FileText, X, ArrowRight, UserRound, Info, PlusCircle, Trash2 } from 'lucide-react';

const getActionColor = (action: string) => {
  switch(action) {
    case 'CREATE': return 'bg-green-100 text-green-700';
    case 'UPDATE': return 'bg-blue-100 text-blue-700';
    case 'DELETE': return 'bg-red-100 text-red-700';
    case 'DELETE_ALL': return 'bg-red-100 text-red-700';
    case 'UPDATE_STOCK': return 'bg-orange-100 text-orange-700';
    default: return 'bg-primary/10 text-primary';
  }
};

const getActionText = (action: string) => {
  switch(action) {
    case 'CREATE': return 'Eklendi';
    case 'UPDATE': return 'Düzenlendi';
    case 'DELETE': return 'Silindi';
    case 'DELETE_ALL': return 'Tümü Silindi';
    case 'UPDATE_STOCK': return 'Stok Güncellendi';
    default: return action;
  }
};

type DiffEntry = {
  key: string;
  label: string;
  old?: any;
  new?: any;
  isSpecialToken?: 'image_update';
};

const HIDDEN_DETAIL_KEYS = new Set(['updated_at', 'imageChanged']);
const DETAIL_WRAPPER_KEYS = new Set(['before', 'after']);

const FIELD_LABELS: Record<string, string> = {
  title: 'Başlık',
  name: 'Ad',
  username: 'Kullanıcı Adı',
  category: 'Kategori',
  payment_type: 'Ödeme Tipi',
  amount: 'Tutar',
  amount_try: 'Tutar (TRY)',
  currency: 'Para Birimi',
  due_day: 'Vade Günü',
  due_date: 'Vade Tarihi',
  frequency: 'Sıklık',
  auto_process: 'Otomatik İşleme',
  document_required: 'Belge Zorunlu',
  is_active: 'Aktiflik',
  start_date: 'Başlangıç Tarihi',
  end_date: 'Bitiş Tarihi',
  description: 'Açıklama',
  notes: 'Notlar',
  role: 'Rol',
  must_change_password: 'Şifre Değiştirme Zorunlu',
  central_stock: 'Merkez Depo Stoğu',
  sale_price: 'Satış Fiyatı',
  purchase_cost: 'Alış Maliyeti',
  purchase_price_usd: 'Alış Fiyatı (USD)',
  sku: 'SKU',
  model: 'Model',
  material: 'Materyal',
  size: 'Ölçü',
  tube_type: 'Boru Tipi',
  connection_type: 'Bağlantı Tipi',
  status: 'Durum',
  platform: 'Platform',
  platforms: 'Platform Bilgileri',
  images: 'Görseller',
  before: 'Eski',
  after: 'Yeni',
  ip: 'IP',
  reason: 'Sebep',
};

const humanizeKey = (key: string) => FIELD_LABELS[key] || key
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toLocaleUpperCase('tr-TR'));

const isDateLikeKey = (key: string) => /(^|_)(date|at)$/.test(key) || key.endsWith('_at');
const isMoneyLikeKey = (key: string) => /(amount|price|cost|profit|revenue|total|maliyet|ciro|tutar)/i.test(key)
  && !/(stock|count|quantity|rate|percentage|margin|day)/i.test(key);

const formatDateValue = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatLogValue = (key: string, value: any): string => {
  if (value === null || value === undefined || value === '') return 'Boş';
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (value === 1 && (key.startsWith('is_') || key.includes('required') || key.includes('active'))) return 'Evet';
  if (value === 0 && (key.startsWith('is_') || key.includes('required') || key.includes('active'))) return 'Hayır';
  if (typeof value === 'number') {
    if (isMoneyLikeKey(key)) {
      return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(value);
    }
    if (/(rate|percentage|margin)/i.test(key)) return `%${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value)}`;
    return new Intl.NumberFormat('tr-TR').format(value);
  }
  if (typeof value === 'string') {
    if (isDateLikeKey(key)) return formatDateValue(value);
    return value;
  }
  if (Array.isArray(value)) {
    if (key === 'platforms') {
      return value.map((platform: any) => {
        const parts = [
          platform.platform_name || platform.name || 'Platform',
          platform.price !== undefined ? `Fiyat: ${formatLogValue('price', Number(platform.price))}` : null,
          platform.is_listed !== undefined ? `Durum: ${platform.is_listed ? 'Yayında' : 'Yayında Değil'}` : null,
        ].filter(Boolean);
        return parts.join(' / ');
      }).join('\n');
    }
    if (key === 'images') return `${value.length} görsel`;
    return value.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('\n');
  }
  if (typeof value === 'object') {
    if (value.username) return String(value.username);
    if (value.title) return String(value.title);
    if (value.name) return String(value.name);
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};

const getDisplayEntries = (obj: any) => Object.entries(obj || {})
  .filter(([key]) => !DETAIL_WRAPPER_KEYS.has(key) && !HIDDEN_DETAIL_KEYS.has(key));

const getDiffs = (details: any): DiffEntry[] => {
  const diffs: DiffEntry[] = [];
  if (!details || typeof details !== 'object' || !details.before || !details.after) {
    if (details && typeof details === 'object') {
      const targetObj = details.after || details.before;
      if (targetObj) return getDisplayEntries(targetObj).map(([key]) => ({ key, label: humanizeKey(key) }));
      return getDisplayEntries(details).map(([key]) => ({ key, label: humanizeKey(key) }));
    }
    return diffs;
  }

  if (details.after.imageChanged) {
    diffs.push({ key: 'images', label: 'Görseller', isSpecialToken: 'image_update' });
  }

  const beforeObj = details.before || {};
  const afterObj = details.after || {};
  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);

  for (const key of allKeys) {
    if (HIDDEN_DETAIL_KEYS.has(key)) continue;
    const bStr = JSON.stringify(beforeObj[key]);
    const aStr = JSON.stringify(afterObj[key]);
    if (bStr === aStr) continue;

    if (key === 'platforms' && Array.isArray(beforeObj[key]) && Array.isArray(afterObj[key])) {
      const oldP = beforeObj[key];
      const newP = afterObj[key];
      const platforms = new Set([
        ...oldP.map((p: any) => p.platform_name),
        ...newP.map((p: any) => p.platform_name),
      ]);

      platforms.forEach((platformName) => {
        const previous = oldP.find((p: any) => p.platform_name === platformName) || {};
        const current = newP.find((p: any) => p.platform_name === platformName) || {};
        ['price', 'is_listed', 'sku', 'barcode'].forEach((platformKey) => {
          if (JSON.stringify(previous[platformKey]) !== JSON.stringify(current[platformKey])) {
            diffs.push({
              key: `${platformName}_${platformKey}`,
              label: `${platformName} ${humanizeKey(platformKey)}`,
              old: previous[platformKey],
              new: current[platformKey],
            });
          }
        });
      });
      continue;
    }

    if (key === 'images' && Array.isArray(beforeObj[key]) && Array.isArray(afterObj[key])) {
      const oldPaths = beforeObj[key].map((img: any) => img.path).join(', ');
      const newPaths = afterObj[key].map((img: any) => img.path).join(', ');
      if (oldPaths !== newPaths) {
        diffs.push({ key, label: 'Görseller', isSpecialToken: 'image_update' });
      }
      continue;
    }

    diffs.push({ key, label: humanizeKey(key), old: beforeObj[key], new: afterObj[key] });
  }

  return diffs;
};

const getDetailSubject = (details: any) => {
  const source = details?.after || details?.before || details || {};
  const primary = source.name || source.title || source.username || details?.name || details?.title || details?.username;
  const secondary = source.sku || source.category || source.role || details?.sku || details?.category;
  return { primary, secondary };
};

const LogDetails = ({ detailsStr }: { detailsStr: string }) => {
  const [expanded, setExpanded] = useState(false);
  
  if (!detailsStr) return <span>-</span>;
  
  let details;
  try {
    details = JSON.parse(detailsStr);
  } catch(e) {
    return <span>{detailsStr}</span>;
  }
  
  if (!details || typeof details !== 'object') {
     return <span>{String(details)}</span>;
  }

  const diffs = getDiffs(details);
  const subject = getDetailSubject(details);

  const renderValueBox = (fieldKey: string, label: string, value: any, tone: 'old' | 'new') => (
    <div className={`relative flex-1 rounded-xl border px-4 py-3 ${tone === 'old' ? 'border-red-100 bg-red-50 text-red-800' : 'border-emerald-100 bg-emerald-50 text-emerald-800'}`}>
      <div className={`mb-1 text-[10px] font-black uppercase tracking-wider ${tone === 'old' ? 'text-red-500' : 'text-emerald-600'}`}>
        {label}
      </div>
      <div className="whitespace-pre-wrap break-words text-sm font-bold leading-relaxed">
        {formatLogValue(fieldKey, value)}
      </div>
    </div>
  );

  const renderKeyValueSection = (title: string, obj: any, tone: 'neutral' | 'old' | 'new', icon?: React.ReactNode) => {
    const entries = getDisplayEntries(obj);
    if (entries.length === 0) return null;

    const toneClass = tone === 'old'
      ? 'border-red-100 bg-red-50/40'
      : tone === 'new'
        ? 'border-emerald-100 bg-emerald-50/40'
        : 'border-slate-200 bg-slate-50';

    return (
      <div className={`rounded-2xl border p-4 ${toneClass}`}>
        <div className="mb-3 flex items-center gap-2 text-sm font-black text-slate-900">
          {icon}
          {title}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {entries.map(([key, value]) => (
            <div key={key} className="rounded-xl border border-white/70 bg-white px-3 py-2 shadow-sm">
              <div className="mb-1 text-[10px] font-black uppercase tracking-wider text-slate-400">{humanizeKey(key)}</div>
              <div className="whitespace-pre-wrap break-words text-sm font-bold text-slate-800">{formatLogValue(key, value)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const extraDetails = { ...details };
  delete extraDetails.before;
  delete extraDetails.after;
  const hasExtraDetails = getDisplayEntries(extraDetails).length > 0;

  const renderContent = () => (
    <div className="space-y-5 text-left">
      {(subject.primary || subject.secondary) && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4">
          <div className="text-xs font-black uppercase tracking-wider text-primary">Kayıt</div>
          {subject.primary && <div className="mt-1 text-lg font-black text-slate-900">{String(subject.primary)}</div>}
          {subject.secondary && <div className="mt-1 text-sm font-bold text-slate-500">{String(subject.secondary)}</div>}
        </div>
      )}

      {details.before && details.after && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-4">
            <div>
              <div className="text-sm font-black text-slate-900">Değişen Alanlar</div>
              <div className="text-xs font-semibold text-slate-500">Eski değer ve yeni değer karşılaştırması</div>
            </div>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-black text-primary">{diffs.length} değişiklik</span>
          </div>
          <div className="divide-y divide-slate-100">
            {diffs.length > 0 ? (
              diffs.map((diff, index) => (
                <div key={`${diff.key}-${index}`} className="p-5">
                  {diff.isSpecialToken === 'image_update' ? (
                    <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">
                      Görseller güncellendi
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[180px,1fr]">
                      <div className="text-sm font-black text-slate-700">{diff.label}</div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr,32px,1fr] md:items-stretch">
                        {renderValueBox(diff.key, 'Eski', diff.old, 'old')}
                        <div className="hidden items-center justify-center md:flex">
                          <ArrowRight className="h-4 w-4 text-slate-400" />
                        </div>
                        {renderValueBox(diff.key, 'Yeni', diff.new, 'new')}
                      </div>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="p-6 text-center text-sm font-semibold text-slate-500">
                Görünen alanlarda değişiklik bulunamadı. Sadece sistem alanları güncellenmiş olabilir.
              </div>
            )}
          </div>
        </div>
      )}

      {!details.before && details.after && renderKeyValueSection('Yeni Kayıt', details.after, 'new', <PlusCircle className="h-4 w-4 text-emerald-600" />)}
      {details.before && !details.after && renderKeyValueSection('Silinmeden Önce', details.before, 'old', <Trash2 className="h-4 w-4 text-red-600" />)}
      {!details.before && !details.after && renderKeyValueSection('Kayıt Bilgileri', details, 'neutral', <Info className="h-4 w-4 text-primary" />)}
      {hasExtraDetails && (details.before || details.after) && renderKeyValueSection('Ek Bilgiler', extraDetails, 'neutral', <Info className="h-4 w-4 text-primary" />)}
    </div>
  );

  return (
    <div>
      <button 
        onClick={() => setExpanded(true)} 
        className="flex items-center text-xs w-full text-left text-primary font-bold hover:bg-primary/10 px-3 py-1.5 rounded-lg transition-all"
      >
        <FileText className="w-4 h-4 mr-1.5 flex-shrink-0" />
        <span className="truncate">
          Detayları Göster
        </span>
      </button>
      
      {expanded && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setExpanded(false)}>
          <div className="bg-white rounded-3xl w-full max-w-5xl max-h-[88vh] flex flex-col shadow-2xl relative" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-border-color">
              <div>
                <h3 className="text-xl font-black text-text-main flex items-center">
                  <Activity className="w-5 h-5 text-primary mr-2" />
                  İşlem Detayları
                </h3>
                <p className="mt-1 text-sm font-semibold text-slate-500">Eski ve yeni değerler okunabilir şekilde karşılaştırılır.</p>
              </div>
              <button 
                onClick={() => setExpanded(false)}
                className="p-2 hover:bg-gray-100 rounded-full text-gray-500 transition-colors"
                title="Kapat"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
              {renderContent()}
            </div>
            
            <div className="px-6 py-4 border-t border-border-color flex justify-end">
               <button 
                 onClick={() => setExpanded(false)}
                 className="px-6 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold rounded-xl transition-colors"
               >
                 Kapat
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ActivityLogs() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLogs();
  }, []);

  const loadLogs = async () => {
    try {
      const data = await api.get('/activity-logs');
      setLogs(data);
    } catch (error) {
      console.error("Failed to load activity logs", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in">
      <div className="flex justify-between items-center bg-white p-6 rounded-3xl shadow-lg border border-border-color">
        <div className="flex items-center space-x-4">
          <div className="w-12 h-12 bg-primary/10 rounded-2xl flex items-center justify-center">
             <Activity className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-text-main flex items-center tracking-tight">Geçmiş Aktiviteler</h1>
            <p className="text-text-muted mt-1 font-medium">Sistemde yapılan son 100 işlem.</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-[32px] p-6 shadow-xl border border-border-color overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-text-muted font-bold animate-pulse">Yükleniyor...</div>
        ) : logs.length === 0 ? (
          <div className="text-center py-16 text-text-muted font-bold text-lg">Kayıt bulunamadı.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[950px]">
              <thead>
                <tr className="border-b-2 border-border-color">
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Tarih</th>
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Kullanıcı</th>
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">İşlem</th>
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Tür</th>
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Değişiklik</th>
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Detaylar</th>
                </tr>
              </thead>
              <tbody className="text-sm font-medium">
                {(() => {
                  let currentDate = '';
                  return logs.map((log: any) => {
                    let parsed = null;
                    try {
                      parsed = JSON.parse(log.details);
                    } catch(e) {}
                    const dCount = parsed ? getDiffs(parsed).length : 0;
                    
                    const logDate = new Date(log.created_at).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
                    const isNewDate = logDate !== currentDate;
                    if (isNewDate) {
                      currentDate = logDate;
                    }
                    
                    return (
                      <React.Fragment key={log.id}>
                        {isNewDate && (
                          <tr className="bg-gray-100/50">
                            <td colSpan={6} className="py-2 px-4 font-bold text-gray-600 text-xs text-center border-y border-gray-200">
                              {logDate}
                            </td>
                          </tr>
                        )}
                        <tr className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                          <td className="py-4 px-4 text-text-muted whitespace-nowrap">
                            <div className="flex items-center space-x-2">
                              <Clock className="w-3 h-3" />
                              <span>{new Date(log.created_at).toLocaleTimeString('tr-TR')}</span>
                            </div>
                          </td>
                          <td className="py-4 px-4 whitespace-nowrap">
                            <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-bg-main border border-border-color rounded-full text-xs font-black text-text-main">
                              <UserRound className="w-3 h-3 text-primary" />
                              <span>{log.username || 'Sistem'}</span>
                            </div>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${getActionColor(log.action)}`}>
                              {getActionText(log.action)}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-bold text-text-main uppercase text-xs">
                            {log.entity_type}
                          </td>
                          <td className="py-4 px-4 font-bold text-text-main uppercase text-xs">
                            {dCount > 0 ? (
                              <span className="bg-primary/10 text-primary px-2 py-1 rounded-md">{dCount}</span>
                            ) : '-'}
                          </td>
                          <td className="py-4 px-4 text-text-main align-top max-w-sm">
                            <LogDetails detailsStr={log.details} />
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

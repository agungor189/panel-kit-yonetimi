import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Activity, Clock, FileText, X, ArrowRight } from 'lucide-react';

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

const getDiffs = (details: any) => {
  let diffs: any[] = [];
  if (!details || typeof details !== 'object' || !details.before || !details.after) {
    // If it's a CREATE or DELETE with only before or after, count keys
    if (details && typeof details === 'object') {
      const targetObj = details.after || details.before;
      if (targetObj) {
         return Object.keys(targetObj).map(k => ({ key: k }));
      }
      // For fallback
      const extraDetails = { ...details };
      delete extraDetails.before;
      delete extraDetails.after;
      if (Object.keys(extraDetails).length > 0) {
        return Object.keys(extraDetails).map(k => ({ key: k }));
      }
    }
    return diffs;
  }
  
  if (details.after.imageChanged) {
    diffs.push({ key: 'Görseller', isSpecialToken: 'image_update' });
  }
  const beforeObj = details.before || {};
  const afterObj = details.after || {};
  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  
  for (const key of allKeys) {
    const bStr = JSON.stringify(beforeObj[key]);
    const aStr = JSON.stringify(afterObj[key]);
    if (bStr !== aStr && key !== 'updated_at' && key !== 'imageChanged') {
      if (key === 'central_stock') {
        diffs.push({ key: 'Merkez Depo Stoğu', old: beforeObj[key] || 0, new: afterObj[key] || 0 });
      } else if (key === 'platforms' && Array.isArray(beforeObj[key]) && Array.isArray(afterObj[key])) {
        const oldP = beforeObj[key];
        const newP = afterObj[key];
        
        const stockChangedAny = newP.some((nP: any) => {
           const oP = oldP.find((p: any) => p.platform_name === nP.platform_name);
           return !oP || oP.stock !== nP.stock;
        });
        
        if (stockChangedAny && newP.length > 0) {
           const oldStock = oldP.length > 0 ? oldP[0].stock : 0;
           diffs.push({ key: 'Stok', old: oldStock, new: newP[0].stock });
        }
        
        const isPriceSameOld = oldP.length > 0 && oldP.every((p: any) => p.price === oldP[0]?.price);
        const isPriceSameNew = newP.length > 0 && newP.every((p: any) => p.price === newP[0]?.price);
        const priceChangedAny = newP.some((nP: any) => {
           const oP = oldP.find((p: any) => p.platform_name === nP.platform_name);
           return !oP || oP.price !== nP.price;
        });
        
        if (isPriceSameNew && priceChangedAny) {
           diffs.push({ key: 'Tüm Platformlar Fiyat', old: isPriceSameOld ? oldP[0]?.price : '(Farklı Değerler)', new: newP[0]?.price });
        }
        
        const isListedSameOld = oldP.length > 0 && oldP.every((p: any) => p.is_listed === oldP[0]?.is_listed);
        const isListedSameNew = newP.length > 0 && newP.every((p: any) => p.is_listed === newP[0]?.is_listed);
        const listedChangedAny = newP.some((nP: any) => {
           const oP = oldP.find((p: any) => p.platform_name === nP.platform_name);
           return !oP || oP.is_listed !== nP.is_listed;
        });
        
        if (isListedSameNew && listedChangedAny) {
           diffs.push({ key: 'Tüm Platformlar Durumu', old: isListedSameOld ? (oldP[0]?.is_listed ? 'Yayında' : 'Yayında Değil') : '(Farklı Değerler)', new: newP[0]?.is_listed ? 'Yayında' : 'Yayında Değil' });
        }
        
        newP.forEach((nP: any) => {
          const oP = oldP.find((p: any) => p.platform_name === nP.platform_name);
          if (oP) {
            if (!(isPriceSameNew && priceChangedAny) && oP.price !== nP.price) {
              diffs.push({ key: `${nP.platform_name} Fiyat`, old: oP.price, new: nP.price });
            }
            if (!(isListedSameNew && listedChangedAny) && oP.is_listed !== nP.is_listed) {
              diffs.push({ key: `${nP.platform_name} Durum`, old: oP.is_listed ? 'Yayında' : 'Yayında Değil', new: nP.is_listed ? 'Yayında' : 'Yayında Değil' });
            }
          }
        });
      } else if (key === 'images' && Array.isArray(beforeObj[key]) && Array.isArray(afterObj[key])) {
        const oldPaths = beforeObj[key].map((img: any) => img.path).join(', ');
        const newPaths = afterObj[key].map((img: any) => img.path).join(', ');
        if (oldPaths !== newPaths) {
          diffs.push({ key: 'Görseller', isSpecialToken: 'image_update' });
        }
      } else {
        diffs.push({ key, old: beforeObj[key], new: afterObj[key] });
      }
    }
  }
  return diffs;
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

  // Calculate deep diff if before and after exist
  const diffs = getDiffs(details);

  const renderSection = (title: string, obj: any) => (
     <div className="mt-4 bg-gray-50 border border-gray-200 p-4 rounded-xl text-sm">
       <span className="font-bold text-gray-800 block mb-2">{title}:</span>
       <pre className="text-xs overflow-x-auto text-gray-700 whitespace-pre-wrap font-mono bg-white p-3 rounded-lg border border-gray-100">
         {JSON.stringify(obj, null, 2)}
       </pre>
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
          <div className="bg-white rounded-3xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl relative" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-5 border-b border-border-color">
              <h3 className="text-xl font-black text-text-main flex items-center">
                <Activity className="w-5 h-5 text-primary mr-2" />
                İşlem Detayları
              </h3>
              <button 
                onClick={() => setExpanded(false)}
                className="p-2 hover:bg-gray-100 rounded-full text-gray-500 transition-colors"
                title="Kapat"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 overflow-y-auto">
                <div className="text-left grid grid-cols-1 gap-4">
                  {(details.name || details.after?.name || details.before?.name) && (
                    <div className="bg-primary/5 border border-primary/20 p-4 rounded-xl flex flex-col sm:flex-row gap-4 mb-2">
                       <div>
                         <div className="text-xs text-primary font-bold uppercase mb-1">Ürün İsmi</div>
                         <div className="text-sm font-bold text-gray-800">{String(details.name || details.after?.name || details.before?.name)}</div>
                       </div>
                       {(details.sku || details.after?.sku || details.before?.sku) && (
                         <div>
                           <div className="text-xs text-primary font-bold uppercase mb-1">Stok Kodu (SKU)</div>
                           <div className="text-sm font-bold text-gray-800">{String(details.sku || details.after?.sku || details.before?.sku)}</div>
                         </div>
                       )}
                    </div>
                  )}

                  {details.before && details.after ? (
                     <div className="bg-white border text-sm border-gray-200 rounded-xl overflow-hidden mb-4">
                       <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 font-bold text-gray-800">Değişiklikler</div>
                       <div className="divide-y divide-gray-100">
                         {diffs.length > 0 ? (
                           diffs.map(diff => {
                             if (diff.isSpecialToken === 'image_update') {
                               return (
                                 <div key={diff.key} className="p-4 flex items-center justify-center bg-blue-50/50">
                                   <div className="text-blue-700 font-bold text-sm bg-blue-100 px-4 py-2 rounded-lg inline-block">
                                     🖼️ Görseller güncellendi
                                   </div>
                                 </div>
                               );
                             }
                             return (
                             <div key={diff.key} className="p-4 flex flex-col sm:flex-row sm:items-start gap-2">
                               <div className="font-mono text-xs font-bold text-gray-500 w-32 shrink-0 pt-1">{diff.key}</div>
                               <div className="flex-1 flex flex-col sm:flex-row sm:items-center gap-3">
                                 <div className="bg-red-50 text-red-700 px-3 py-2 rounded-lg text-xs font-mono break-all flex-1 border border-red-100 relative min-h-[36px]">
                                    <span className="text-[10px] uppercase font-bold text-red-500/80 absolute -top-2 left-2 bg-red-50 px-1">Önceki</span>
                                    <div className="mt-1 whitespace-pre-wrap">{diff.old === null || diff.old === undefined ? 'null' : (typeof diff.old === 'object' ? JSON.stringify(diff.old, null, 2) : String(diff.old))}</div>
                                 </div>
                                 <ArrowRight className="w-4 h-4 text-gray-400 hidden sm:block shrink-0" />
                                 <div className="bg-green-50 text-green-700 px-3 py-2 rounded-lg text-xs font-mono break-all flex-1 border border-green-100 relative min-h-[36px]">
                                    <span className="text-[10px] uppercase font-bold text-green-500/80 absolute -top-2 left-2 bg-green-50 px-1">Sonraki</span>
                                    <div className="mt-1 whitespace-pre-wrap">{diff.new === null || diff.new === undefined ? 'null' : (typeof diff.new === 'object' ? JSON.stringify(diff.new, null, 2) : String(diff.new))}</div>
                                 </div>
                               </div>
                             </div>
                             );
                           })
                         ) : (
                           <div className="p-4 text-center text-gray-500 text-sm">
                             Kayıtlı veride bir değişiklik bulunamadı (sadece güncellenme tarihi değişmiş olabilir).
                           </div>
                         )}
                       </div>
                     </div>
                  ) : (
                    <>
                      {details.before && renderSection("Düzenlenmeden Önce (Old)", details.before)}
                      {details.after && renderSection("Düzenlendikten Sonra (New)", details.after)}
                    </>
                  )}
                  
                  {(() => {
                    const extraDetails = { ...details };
                    delete extraDetails.before;
                    delete extraDetails.after;
                    if (Object.keys(extraDetails).length > 0) {
                      return renderSection("Ek Bilgiler", extraDetails);
                    }
                    return null;
                  })()}
                </div>
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
            <table className="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr className="border-b-2 border-border-color">
                  <th className="pb-4 pt-2 px-4 font-black text-xs text-text-muted uppercase tracking-wider">Tarih</th>
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
                            <td colSpan={5} className="py-2 px-4 font-bold text-gray-600 text-xs text-center border-y border-gray-200">
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

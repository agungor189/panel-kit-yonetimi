import { useState, useEffect } from 'react';
import { 
  Save, 
  Info, 
  Settings as SettingsIcon, 
  Percent, 
  Building2, 
  AlertCircle,
  CheckCircle2,
  Plus,
  Trash2,
  ListFilter,
  Users,
  UserPlus,
  RotateCcw,
  ShieldCheck,
  Power,
  Download,
  Archive,
  Clock3,
  HardDrive,
  RefreshCw,
  Cloud,
  Upload
} from 'lucide-react';
import { useCurrency } from '../CurrencyContext';
import { api, getToken } from '../lib/api';
import { useAuth } from '../App';
import { Settings, type BackupConfig, type BackupRun, type BackupStatus, type ManagedUser, type UserRole } from '../types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SettingsViewProps {
  onUpdate: () => void;
}

export default function SettingsView({ onUpdate }: SettingsViewProps) {
  const { role } = useAuth();
  const { refreshRate, activeRate } = useCurrency();
  const [exchangeRateInfo, setExchangeRateInfo] = useState<any>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  const [newCat, setNewCat] = useState({ product: '', income: '', expense: '' });
  const [newSalesChannel, setNewSalesChannel] = useState('');
  const [restoreProgress, setRestoreProgress] = useState<{ percentage: number; text: string } | null>(null);
  const [confirmRestoreFile, setConfirmRestoreFile] = useState<File | null>(null);
  const [confirmInputText, setConfirmInputText] = useState("");
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupConfig, setBackupConfig] = useState<BackupConfig | null>(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [newUser, setNewUser] = useState<{ username: string; password: string; role: UserRole }>({
    username: '',
    password: '',
    role: 'user',
  });
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});

  const isAdmin = role === 'admin';

  useEffect(() => {
    loadSettings();
    loadExchangeRate();
  }, []);

  useEffect(() => {
    if (isAdmin) {
      loadUsers();
      loadBackupStatus();
    }
  }, [isAdmin]);

  const loadExchangeRate = async () => {
    try {
      setExchangeRateInfo(await api.get('/exchange-rate'));
    } catch(e) {}
  };

  const handleRefreshRate = async () => {
    try {
      setLoading(true);
      const res = await api.post('/exchange-rate/refresh', {});
      setExchangeRateInfo(res);
      await refreshRate(); // Update global context too
    } catch(e) {
      alert("Kur güncellenemedi.");
    } finally {
      setLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const data = await api.get('/settings');
      setSettings(data);
    } catch (err) {
      console.error(err);
    }
  };

  const loadUsers = async () => {
    try {
      setUsersLoading(true);
      const data = await api.get('/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    } finally {
      setUsersLoading(false);
    }
  };

  const loadBackupStatus = async () => {
    if (!isAdmin) return;
    try {
      setBackupLoading(true);
      const res = await api.get('/backup/status');
      const data = res.data || res;
      setBackupStatus(data);
      setBackupConfig(data.config);
    } catch (err) {
      console.error(err);
    } finally {
      setBackupLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setLoading(true);
    try {
      await api.put('/settings', settings);
      setSaved(true);
      onUpdate();
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert("Ayarlar kaydedilemedi.");
    } finally {
      setLoading(false);
    }
  };

  const filenameFromDisposition = (disposition: string | null) => {
    if (!disposition) return `dsdst_backup_${new Date().toISOString().slice(0, 10)}.zip`;

    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (encodedMatch?.[1]) {
      try {
        return decodeURIComponent(encodedMatch[1].replace(/["']/g, ''));
      } catch (_) {}
    }

    const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
    return plainMatch?.[1] || `dsdst_backup_${new Date().toISOString().slice(0, 10)}.zip`;
  };

  const handleDownloadBackup = async () => {
    if (!isAdmin) {
      alert("Yedek indirme sadece admin kullanıcılar için açıktır.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/backup/download', {
        headers: {
          Authorization: `Bearer ${getToken() || ''}`,
        },
      });

      if (!res.ok) {
        let message = "Yedek indirilemedi.";
        try {
          const data = await res.json();
          message = data?.error?.message || data?.error || message;
        } catch (_) {}
        throw new Error(message);
      }

      const blob = await res.blob();
      if (!blob.size) throw new Error("Yedek dosyası boş geldi.");

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get('Content-Disposition'));
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      alert(err.message || "Yedek indirilemedi.");
    } finally {
      setLoading(false);
    }
  };

  const saveBackupConfig = async () => {
    if (!backupConfig) return;
    try {
      setBackupLoading(true);
      const res = await api.put('/backup/config', backupConfig);
      const data = res.data || res;
      setBackupConfig(data);
      await loadBackupStatus();
      alert("Yedekleme ayarları kaydedildi.");
    } catch (err: any) {
      alert(err.message || "Yedekleme ayarları kaydedilemedi.");
    } finally {
      setBackupLoading(false);
    }
  };

  const runManagedBackupNow = async (uploadsMode: BackupConfig['uploads_strategy'] = 'smart') => {
    try {
      setBackupLoading(true);
      await api.post('/backup/run', { uploads_mode: uploadsMode });
      await loadBackupStatus();
      alert("Yedek oluşturuldu.");
    } catch (err: any) {
      alert(err.message || "Yedek oluşturulamadı.");
    } finally {
      setBackupLoading(false);
    }
  };

  const downloadStoredBackup = async (run: BackupRun) => {
    try {
      const res = await fetch(`/api/backup/files/${run.id}/download`, {
        headers: { Authorization: `Bearer ${getToken() || ''}` },
      });
      if (!res.ok) {
        let message = "Yedek indirilemedi.";
        try {
          const data = await res.json();
          message = data?.error?.message || data?.error || message;
        } catch (_) {}
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = run.file_name || filenameFromDisposition(res.headers.get('Content-Disposition'));
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err: any) {
      alert(err.message || "Yedek indirilemedi.");
    }
  };

  const deleteStoredBackup = async (run: BackupRun) => {
    if (!window.confirm(`${run.file_name || 'Bu yedek'} silinsin mi?`)) return;
    try {
      setBackupLoading(true);
      await api.delete(`/backup/files/${run.id}`);
      await loadBackupStatus();
    } catch (err: any) {
      alert(err.message || "Yedek silinemedi.");
    } finally {
      setBackupLoading(false);
    }
  };

  const uploadStoredBackupToCloud = async (run: BackupRun) => {
    try {
      setBackupLoading(true);
      await api.post(`/backup/files/${run.id}/cloud-upload`, {});
      await loadBackupStatus();
      alert("Yedek buluta yüklendi.");
    } catch (err: any) {
      alert(err.message || "Bulut yükleme başarısız.");
      await loadBackupStatus();
    } finally {
      setBackupLoading(false);
    }
  };

  const formatBytes = (value?: number) => {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const cloudStatusLabel = (status?: BackupRun['cloud_status']) => {
    switch (status) {
      case 'success':
        return 'R2 OK';
      case 'uploading':
        return 'Yükleniyor';
      case 'failed':
        return 'Hata';
      case 'skipped':
        return 'Atlandı';
      default:
        return 'Kapalı';
    }
  };

  const cloudStatusClass = (status?: BackupRun['cloud_status']) => cn(
    "inline-flex rounded-xl border px-3 py-1 text-[10px] font-black uppercase tracking-widest",
    status === 'success'
      ? "border-sky-100 bg-sky-50 text-sky-700"
      : status === 'failed'
        ? "border-red-100 bg-red-50 text-red-700"
        : status === 'uploading'
          ? "border-blue-100 bg-blue-50 text-blue-700"
          : "border-gray-200 bg-gray-50 text-gray-500"
  );

  const formatBackupDate = (value?: string | null) => {
    if (!value) return '-';
    return new Date(value).toLocaleString('tr-TR');
  };

  const addCategory = (type: 'product' | 'income' | 'expense') => {
    if (!settings) return;
    const key = `${type}_categories` as keyof Settings;
    const value = newCat[type].trim();
    if (!value) return;
    
    const currentList = (settings[key] as string[]) || [];
    if (currentList.includes(value)) return;

    setSettings({
      ...settings,
      [key]: [...currentList, value]
    });
    setNewCat({ ...newCat, [type]: '' });
  };

  const removeCategory = (type: 'product' | 'income' | 'expense', value: string) => {
    if (!settings) return;
    const key = `${type}_categories` as keyof Settings;
    const currentList = (settings[key] as string[]) || [];
    
    setSettings({
      ...settings,
      [key]: currentList.filter(c => c !== value)
    });
  };

  const addSalesChannel = () => {
    if (!settings) return;
    const value = newSalesChannel.trim();
    if (!value) return;

    const channels = settings.sales_channels || [];
    if (channels.includes(value)) return;

    setSettings({
      ...settings,
      sales_channels: [...channels, value],
      commission_rates: {
        ...(settings.commission_rates || {}),
        [value]: settings.commission_rates?.[value] ?? 0,
      },
    });
    setNewSalesChannel('');
  };

  const removeSalesChannel = (channel: string) => {
    if (!settings || channel === 'Satış Sistemi') return;
    const nextRates = { ...(settings.commission_rates || {}) };
    delete nextRates[channel];
    setSettings({
      ...settings,
      sales_channels: (settings.sales_channels || []).filter((value) => value !== channel),
      commission_rates: nextRates,
    });
  };

  const handleCreateUser = async () => {
    const username = newUser.username.trim();
    if (username.length < 3 || newUser.password.length < 8) {
      alert("Kullanıcı adı en az 3, şifre en az 8 karakter olmalıdır.");
      return;
    }

    try {
      await api.post('/users', {
        username,
        password: newUser.password,
        role: newUser.role,
        is_active: 1,
        must_change_password: 1,
      });
      setNewUser({ username: '', password: '', role: 'user' });
      await loadUsers();
    } catch (err: any) {
      alert(err.message || "Kullanıcı oluşturulamadı.");
    }
  };

  const updateUser = async (user: ManagedUser, patch: Partial<ManagedUser>) => {
    try {
      await api.put(`/users/${user.id}`, {
        username: user.username,
        role: patch.role ?? user.role,
        is_active: patch.is_active ?? user.is_active,
        must_change_password: patch.must_change_password ?? user.must_change_password,
        notes: patch.notes ?? user.notes ?? '',
      });
      await loadUsers();
    } catch (err: any) {
      alert(err.message || "Kullanıcı güncellenemedi.");
      await loadUsers();
    }
  };

  const resetUserPassword = async (user: ManagedUser) => {
    const password = resetPasswords[user.id] || '';
    if (password.length < 8) {
      alert("Yeni şifre en az 8 karakter olmalıdır.");
      return;
    }

    try {
      await api.post(`/users/${user.id}/reset-password`, {
        password,
        must_change_password: 1,
      });
      setResetPasswords(prev => ({ ...prev, [user.id]: '' }));
      await loadUsers();
      alert(`${user.username} için şifre sıfırlandı.`);
    } catch (err: any) {
      alert(err.message || "Şifre sıfırlanamadı.");
    }
  };

  if (!settings) return null;

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in slide-in-from-bottom-4 duration-500 pb-20">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl lg:text-2xl font-bold text-text-main tracking-tight">Sistem Ayarları</h2>
          <p className="text-xs lg:text-sm text-text-muted">Panel yapılandırmasını buradan özelleştirin.</p>
        </div>
        <button 
          onClick={handleSave}
          disabled={loading}
          className="btn-primary h-11 px-8 flex items-center justify-center w-full sm:w-auto"
        >
          <span>{loading ? 'Kaydediliyor...' : saved ? 'Ayarlar Kaydedildi' : 'Değişiklikleri Kaydet'}</span>
          {saved ? <CheckCircle2 className="w-4 h-4 ml-2" /> : <Save className="w-4 h-4 ml-2" />}
        </button>
      </div>

      <div className="card overflow-hidden divide-y divide-border-color">
         {/* General Info */}
         <div className="p-6 lg:p-8 space-y-6">
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
               <Building2 className="w-4 h-4 mr-3 text-primary" />
               Genel Panel Bilgileri
            </h3>
            <div className="grid grid-cols-1 gap-6">
               <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Şirket / Panel Adı</label>
                  <input 
                    type="text" 
                    value={settings.company_name} 
                    onChange={e => setSettings({...settings, company_name: e.target.value})}
                    className="form-input font-bold"
                   />
               </div>
               <div className="grid grid-cols-2 gap-6">
                 <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Kritik Stok Sınırı</label>
                    <input 
                      type="number" 
                      value={settings.low_stock_threshold} 
                      onChange={e => setSettings({...settings, low_stock_threshold: parseInt(e.target.value)})}
                      className="form-input font-bold"
                    />
                 </div>
                 <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Para Birimi</label>
                    <input 
                      type="text" 
                      value={settings.currency_symbol} 
                      onChange={e => setSettings({...settings, currency_symbol: e.target.value})}
                      className="form-input font-bold text-center"
                    />
                 </div>
               </div>
               <div className="grid grid-cols-2 lg:grid-cols-3 gap-6">
                 <div className="space-y-1.5 col-span-2 lg:col-span-1">
                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Güncel USD/TRY Kuru (Oto)</label>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <div className="absolute left-4 top-3 text-text-muted font-bold text-sm">₺</div>
                        <input 
                          type="number" 
                          readOnly
                          value={exchangeRateInfo?.rate || activeRate || 0} 
                          className="form-input font-bold pl-10 bg-bg-muted text-text-muted cursor-not-allowed"
                        />
                      </div>
                      <button 
                        onClick={handleRefreshRate}
                        disabled={loading}
                        className="px-3 py-2.5 bg-primary/10 text-primary hover:bg-primary/20 font-bold rounded-xl whitespace-nowrap text-sm"
                      >Yenile
                      </button>
                    </div>
                    {exchangeRateInfo && (
                      <p className="text-[10px] text-text-muted mt-1 px-1">
                        K: {exchangeRateInfo.source} | Son: {new Date(exchangeRateInfo.fetched_at).toLocaleTimeString('tr-TR')}
                      </p>
                    )}
                 </div>
                 <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Varsayılan Buffer (%)</label>
                    <div className="relative">
                      <div className="absolute right-4 top-3 text-text-muted font-bold text-sm">%</div>
                      <input 
                        type="number" 
                        value={settings.default_buffer_percentage} 
                        onChange={e => setSettings({...settings, default_buffer_percentage: parseInt(e.target.value)})}
                        className="form-input font-bold pr-10"
                      />
                    </div>
                 </div>
                 <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Varsayılan Kar Marjı (%)</label>
                    <div className="relative">
                      <div className="absolute right-4 top-3 text-text-muted font-bold text-sm">%</div>
                      <input 
                        type="number" 
                        value={settings?.default_profit_percentage || 0} 
                        onChange={e => setSettings({...settings, default_profit_percentage: parseInt(e.target.value)})}
                        className="form-input font-bold pr-10"
                      />
                    </div>
                 </div>
               </div>
               
               <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Entegrasyon API Anahtarı (n8n)</label>
                  <input 
                    type="text" 
                    value={settings.api_key || ''} 
                    onChange={e => setSettings({...settings, api_key: e.target.value})}
                    placeholder="Boş bırakılırsa tüm dış API istekleri reddedilir"
                    className="form-input font-mono text-sm tracking-tight text-primary"
                  />
                  <p className="text-[10px] text-text-muted mt-1 px-1">Dış sistemlerden (Ön: n8n) API ile bağlanırken bu anahtarı <code className="bg-bg-main px-1 rounded">x-api-key</code> veya <code className="bg-bg-main px-1 rounded">Authorization: Bearer</code> olarak kullanın.</p>
               </div>
            </div>
         </div>

         {/* Category Management */}
         <div className="p-8 space-y-6">
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
               <ListFilter className="w-4 h-4 mr-3 text-primary" />
               Malzeme & Kategori Yönetimi
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
               {/* Product Categories */}
               <CategoryList 
                  title="Ürün Malzemeleri" 
                  categories={settings.product_categories || []} 
                  newValue={newCat.product} 
                  onNewValueChange={(v) => setNewCat({...newCat, product: v})}
                  onAdd={() => addCategory('product')}
                  onRemove={(c) => removeCategory('product', c)}
               />

               {/* Income Categories */}
               <CategoryList 
                  title="Gelirler" 
                  categories={settings.income_categories || []} 
                  newValue={newCat.income} 
                  onNewValueChange={(v) => setNewCat({...newCat, income: v})}
                  onAdd={() => addCategory('income')}
                  onRemove={(c) => removeCategory('income', c)}
               />

               {/* Expense Categories */}
               <CategoryList 
                  title="Giderler" 
                  categories={settings.expense_categories || []} 
                  newValue={newCat.expense} 
                  onNewValueChange={(v) => setNewCat({...newCat, expense: v})}
                  onAdd={() => addCategory('expense')}
                  onRemove={(c) => removeCategory('expense', c)}
               />
            </div>
         </div>

         {/* Sales Channels & Commission Rates */}
         <div className="p-8 space-y-6">
            <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
               <Percent className="w-4 h-4 mr-3 text-primary" />
               Satış Kanalları & Komisyon Oranları
            </h3>
            <div className="flex gap-2">
               <input
                  type="text"
                  value={newSalesChannel}
                  onChange={(e) => setNewSalesChannel(e.target.value)}
                  placeholder="Yeni kanal ekleyin..."
                  className="form-input text-sm font-bold"
                  onKeyDown={(e) => e.key === 'Enter' && addSalesChannel()}
               />
               <button
                  onClick={addSalesChannel}
                  className="p-3 bg-primary text-white rounded-xl hover:bg-primary/90 transition-colors"
                  title="Satış kanalı ekle"
               >
                  <Plus className="w-4 h-4" />
               </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
               {(settings.sales_channels || Object.keys(settings.commission_rates || {})).map((platform) => (
                  <div key={platform} className="flex items-center justify-between gap-4 p-4 bg-bg-main rounded-xl border border-border-color group focus-within:ring-2 focus-within:ring-primary/20 focus-within:border-primary transition-all">
                     <div>
                        <span className="text-[11px] font-bold text-text-main uppercase tracking-tight">{platform}</span>
                        <p className="text-[10px] text-text-muted mt-1 font-bold uppercase tracking-tight">
                          {['Trendyol', 'Hepsiburada', 'Amazon', 'N11'].includes(platform) ? 'Bekleyen platform hesabı kullanır' : 'Kasa hesabı seçilerek işlenir'}
                        </p>
                     </div>
                     <div className="flex items-center space-x-2">
                        <input
                           type="number"
                           step="0.1"
                           value={settings.commission_rates?.[platform] ?? 0}
                           onChange={e => {
                              const newRates = {...(settings.commission_rates || {}), [platform]: parseFloat(e.target.value) || 0};
                              setSettings({...settings, commission_rates: newRates});
                           }}
                           className="w-16 bg-white border border-border-color rounded-lg px-2 py-1.5 text-right outline-none font-bold text-text-main text-sm"
                        />
                        <span className="text-text-muted font-bold text-[10px]">%</span>
                        <button
                          onClick={() => removeSalesChannel(platform)}
                          disabled={platform === 'Satış Sistemi'}
                          className="p-2 text-text-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                          title={platform === 'Satış Sistemi' ? 'Varsayılan kanal kaldırılamaz' : 'Kanalı kaldır'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                     </div>
                  </div>
               ))}
            </div>
            <div className="flex items-start p-4 bg-blue-50/50 border border-blue-100 rounded-xl">
               <Info className="w-4 h-4 text-blue-600 mr-3 mt-0.5 flex-shrink-0" />
               <p className="text-[11px] text-blue-700 leading-relaxed font-bold uppercase tracking-tight opacity-80">Bu liste yeni satış formunda Platform / Satış Kanalı seçeneklerini belirler. Komisyon oranları net kâr ve platform analizlerinde kullanılır.</p>
            </div>
         </div>
      </div>

      {isAdmin && (
        <div className="card overflow-hidden mt-8">
          <div className="p-6 lg:p-8 border-b border-border-color">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div>
                <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
                  <Users className="w-4 h-4 mr-3 text-primary" />
                  Kullanıcı Yönetimi
                </h3>
                <p className="text-xs text-text-muted mt-2">Kullanıcı hesabı, rol, aktiflik ve zorunlu şifre değiştirme durumlarını yönetin.</p>
              </div>
              <button
                onClick={loadUsers}
                disabled={usersLoading}
                className="px-4 py-2 bg-bg-main border border-border-color text-text-main rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-primary/5 transition-all"
              >
                {usersLoading ? 'Yükleniyor...' : 'Listeyi Yenile'}
              </button>
            </div>
          </div>

          <div className="p-6 lg:p-8 border-b border-border-color bg-bg-main/50">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_160px_auto] gap-3">
              <input
                type="text"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                className="form-input text-sm font-bold"
                placeholder="Kullanıcı adı"
              />
              <input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                className="form-input text-sm font-bold"
                placeholder="Geçici şifre"
              />
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value as UserRole })}
                className="form-input text-sm font-bold"
              >
                <option value="user">user</option>
                <option value="readonly">readonly</option>
                <option value="admin">admin</option>
              </select>
              <button
                onClick={handleCreateUser}
                className="btn-primary h-11 px-5 flex items-center justify-center"
              >
                <UserPlus className="w-4 h-4 mr-2" />
                Ekle
              </button>
            </div>
            <p className="text-[10px] text-text-muted mt-3 font-bold uppercase tracking-tight">Yeni kullanıcı ilk girişte şifresini değiştirmek zorunda kalır.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left">
              <thead>
                <tr className="border-b border-border-color bg-white">
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Kullanıcı adı</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Rol</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Durum</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Şifre Zorunluluğu</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Oluşturulma</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Şifre Sıfırla</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-bg-main/60 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-black text-text-main">{user.username}</div>
                      <div className="text-[10px] text-text-muted font-bold uppercase tracking-tight">{user.id.slice(0, 8)}</div>
                    </td>
                    <td className="px-6 py-4">
                      <select
                        value={user.role}
                        onChange={(e) => updateUser(user, { role: e.target.value as UserRole })}
                        className="form-input text-xs font-bold py-2"
                      >
                        <option value="admin">admin</option>
                        <option value="user">user</option>
                        <option value="readonly">readonly</option>
                      </select>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => updateUser(user, { is_active: !user.is_active })}
                        className={cn(
                          "inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                          user.is_active
                            ? "bg-green-50 text-green-700 border-green-100 hover:bg-green-100"
                            : "bg-red-50 text-red-700 border-red-100 hover:bg-red-100"
                        )}
                      >
                        <Power className="w-3 h-3" />
                        {user.is_active ? 'Aktif' : 'Pasif'}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <button
                        onClick={() => updateUser(user, { must_change_password: !user.must_change_password })}
                        className={cn(
                          "inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                          user.must_change_password
                            ? "bg-amber-50 text-amber-700 border-amber-100 hover:bg-amber-100"
                            : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                        )}
                      >
                        <ShieldCheck className="w-3 h-3" />
                        {user.must_change_password ? 'Zorunlu' : 'Normal'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-xs font-bold text-text-muted whitespace-nowrap">
                      {user.created_at ? new Date(user.created_at).toLocaleDateString('tr-TR') : '-'}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <input
                          type="password"
                          value={resetPasswords[user.id] || ''}
                          onChange={(e) => setResetPasswords(prev => ({ ...prev, [user.id]: e.target.value }))}
                          className="form-input text-xs py-2 min-w-[150px]"
                          placeholder="Yeni şifre"
                        />
                        <button
                          onClick={() => resetUserPassword(user)}
                          className="p-2 bg-primary/10 text-primary hover:bg-primary/20 rounded-xl transition-colors"
                          title="Şifreyi sıfırla"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!usersLoading && users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-10 text-center text-sm font-bold text-text-muted">Kullanıcı bulunamadı.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isAdmin && backupConfig && (
        <div className="card overflow-hidden mt-8">
          <div className="p-6 lg:p-8 border-b border-border-color">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
              <div>
                <h3 className="text-xs font-bold text-text-muted uppercase tracking-widest flex items-center">
                  <Archive className="w-4 h-4 mr-3 text-primary" />
                  Gelişmiş Yedekleme Sistemi
                </h3>
                <p className="text-xs text-text-muted mt-2">
                  DB günlük tam yedeklenir; dosyalar akıllı modda haftalık tam, günlük değişen dosya olarak saklanır.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={loadBackupStatus}
                  disabled={backupLoading}
                  className="px-4 py-2 bg-bg-main border border-border-color text-text-main rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-primary/5 transition-all disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Yenile
                </button>
                <button
                  onClick={() => runManagedBackupNow('smart')}
                  disabled={backupLoading}
                  className="btn-primary h-10 px-5 text-[11px] uppercase tracking-widest disabled:opacity-50"
                >
                  Şimdi Yedek Al
                </button>
              </div>
            </div>
          </div>

          <div className="p-6 lg:p-8 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 border-b border-border-color bg-bg-main/40">
            <div className="rounded-2xl border border-border-color bg-white p-4">
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted">
                <Clock3 className="w-4 h-4 text-primary" />
                Sonraki Çalışma
              </div>
              <div className="mt-2 text-sm font-black text-text-main">
                {backupConfig.enabled ? formatBackupDate(backupStatus?.next_run_at) : 'Kapalı'}
              </div>
              <p className="mt-1 text-[10px] font-bold text-text-muted">Sunucu yerel saatine göre.</p>
            </div>
            <div className="rounded-2xl border border-border-color bg-white p-4">
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted">
                <HardDrive className="w-4 h-4 text-primary" />
                Backup Alanı
              </div>
              <div className="mt-2 text-sm font-black text-text-main">
                {formatBytes(backupStatus?.storage?.totalBytes)}
              </div>
              <p className="mt-1 text-[10px] font-bold text-text-muted">{backupStatus?.storage?.fileCount || 0} dosya</p>
            </div>
            <div className="rounded-2xl border border-border-color bg-white p-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-text-muted">Konum</div>
              <div className="mt-2 break-all font-mono text-[11px] font-bold text-text-main">{backupStatus?.backup_dir || '-'}</div>
              <p className="mt-1 text-[10px] font-bold text-text-muted">Docker için dış volume önerilir.</p>
            </div>
            <div className="rounded-2xl border border-border-color bg-white p-4">
              <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-text-muted">
                <Cloud className="w-4 h-4 text-sky-600" />
                Cloudflare R2
              </div>
              <div className={cn(
                "mt-2 text-sm font-black",
                backupStatus?.cloud?.configured ? "text-sky-700" : "text-text-muted"
              )}>
                {backupStatus?.cloud?.configured ? 'Aktif' : 'Kapalı / Eksik'}
              </div>
              <p className="mt-1 break-all text-[10px] font-bold text-text-muted">
                {backupStatus?.cloud?.configured
                  ? `${backupStatus.cloud.rclone_remote}/${backupStatus.cloud.prefix}`
                  : 'CLOUD_BACKUP_ENABLED + rclone remote gerekir.'}
              </p>
            </div>
          </div>

          <div className="p-6 lg:p-8 space-y-5 border-b border-border-color">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <label className="flex items-center justify-between gap-4 rounded-2xl border border-border-color bg-bg-main p-4">
                <div>
                  <div className="text-[11px] font-black uppercase tracking-widest text-text-main">Otomatik Backup</div>
                  <p className="text-[10px] font-bold text-text-muted mt-1">Her gün seçili saatte çalışır.</p>
                </div>
                <input
                  type="checkbox"
                  checked={backupConfig.enabled}
                  onChange={(e) => setBackupConfig({ ...backupConfig, enabled: e.target.checked })}
                  className="h-5 w-5 accent-primary"
                />
              </label>

              <div>
                <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Çalışma Saati</label>
                <input
                  type="time"
                  value={backupConfig.run_at}
                  onChange={(e) => setBackupConfig({ ...backupConfig, run_at: e.target.value })}
                  className="form-input mt-1 font-bold"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Saklama Süresi</label>
                <div className="relative mt-1">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={backupConfig.retention_days}
                    onChange={(e) => setBackupConfig({ ...backupConfig, retention_days: Number(e.target.value) || 7 })}
                    className="form-input font-bold pr-14"
                  />
                  <span className="absolute right-4 top-3 text-xs font-black text-text-muted">gün</span>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Dosya Stratejisi</label>
                <select
                  value={backupConfig.uploads_strategy}
                  onChange={(e) => setBackupConfig({ ...backupConfig, uploads_strategy: e.target.value as BackupConfig['uploads_strategy'] })}
                  className="form-input mt-1 font-bold text-sm"
                >
                  <option value="smart">Akıllı</option>
                  <option value="full">Her seferinde tam</option>
                  <option value="incremental">Sadece değişenler</option>
                  <option value="none">Dosya yedekleme kapalı</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="flex items-center justify-between gap-4 rounded-2xl border border-border-color bg-white p-4">
                <div>
                  <div className="text-[11px] font-black uppercase tracking-widest text-text-main">Uploads Dahil</div>
                  <p className="text-[10px] font-bold text-text-muted mt-1">Ürün görselleri ve gider ekleri.</p>
                </div>
                <input
                  type="checkbox"
                  checked={backupConfig.include_uploads}
                  onChange={(e) => setBackupConfig({ ...backupConfig, include_uploads: e.target.checked })}
                  className="h-5 w-5 accent-primary"
                />
              </label>

              <div>
                <label className="text-[11px] font-bold text-text-muted uppercase tracking-widest px-1">Haftalık Tam Dosya Günü</label>
                <select
                  value={backupConfig.weekly_full_day}
                  onChange={(e) => setBackupConfig({ ...backupConfig, weekly_full_day: Number(e.target.value) })}
                  className="form-input mt-1 font-bold text-sm"
                >
                  <option value={0}>Pazar</option>
                  <option value={1}>Pazartesi</option>
                  <option value={2}>Salı</option>
                  <option value={3}>Çarşamba</option>
                  <option value={4}>Perşembe</option>
                  <option value={5}>Cuma</option>
                  <option value={6}>Cumartesi</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={saveBackupConfig}
                disabled={backupLoading}
                className="btn-primary h-11 px-6 disabled:opacity-50"
              >
                Yedekleme Ayarlarını Kaydet
              </button>
              <button
                onClick={() => runManagedBackupNow('full')}
                disabled={backupLoading}
                className="px-5 py-2.5 bg-white border border-border-color text-text-main rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-primary/5 transition-all disabled:opacity-50"
              >
                Tam Dosya Yedeği Al
              </button>
              <button
                onClick={() => runManagedBackupNow('none')}
                disabled={backupLoading}
                className="px-5 py-2.5 bg-white border border-border-color text-text-main rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-primary/5 transition-all disabled:opacity-50"
              >
                Sadece DB Yedeği Al
              </button>
            </div>

            <div className="flex items-start p-4 bg-blue-50/70 border border-blue-100 rounded-xl">
              <Info className="w-4 h-4 text-blue-600 mr-3 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-blue-700 leading-relaxed font-bold uppercase tracking-tight opacity-80">
                Akıllı mod: DB her çalışmada tam alınır. Dosyalar haftada bir tam, diğer günler son tam yedekten sonra değişen dosyalar olarak alınır. Retention eski dosyaları siler ama en son tam dosya yedeğini korur.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left">
              <thead>
                <tr className="border-b border-border-color bg-white">
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Yedek</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Tür</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Boyut</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Durum</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Bulut</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">Tarih</th>
                  <th className="px-6 py-4 text-[10px] font-black text-text-muted uppercase tracking-widest">İşlem</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-color">
                {(backupStatus?.runs || []).map((run) => (
                  <tr key={run.id} className="hover:bg-bg-main/60 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-black text-text-main">{run.file_name || run.id.slice(0, 8)}</div>
                      <div className="text-[10px] text-text-muted font-bold uppercase tracking-tight">{run.created_by || run.trigger_type}</div>
                      {run.error_message && <div className="mt-1 text-[10px] font-bold text-danger">{run.error_message}</div>}
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex rounded-xl bg-primary/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-primary">
                        {run.backup_kind === 'database' ? 'DB' : `Uploads ${run.upload_mode || ''}`}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-xs font-bold text-text-muted">
                      {formatBytes(run.size_bytes)}
                      {run.backup_kind === 'uploads' && (
                        <div className="mt-1 text-[10px]">{run.upload_file_count || 0} dosya</div>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className={cn(
                        "inline-flex rounded-xl border px-3 py-1 text-[10px] font-black uppercase tracking-widest",
                        run.status === 'success'
                          ? "border-green-100 bg-green-50 text-green-700"
                          : run.status === 'failed'
                            ? "border-red-100 bg-red-50 text-red-700"
                            : "border-gray-200 bg-gray-50 text-gray-600"
                      )}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={cloudStatusClass(run.cloud_status)}>
                        {cloudStatusLabel(run.cloud_status)}
                      </span>
                      {run.cloud_uploaded_at && (
                        <div className="mt-1 text-[10px] font-bold text-text-muted whitespace-nowrap">
                          {formatBackupDate(run.cloud_uploaded_at)}
                        </div>
                      )}
                      {run.cloud_error && (
                        <div className="mt-1 max-w-[240px] truncate text-[10px] font-bold text-danger" title={run.cloud_error}>
                          {run.cloud_error}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-xs font-bold text-text-muted whitespace-nowrap">
                      {formatBackupDate(run.completed_at || run.started_at)}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => uploadStoredBackupToCloud(run)}
                          disabled={
                            backupLoading ||
                            run.status !== 'success' ||
                            !run.file_path ||
                            !backupStatus?.cloud?.configured ||
                            run.cloud_status === 'uploading'
                          }
                          className="p-2 bg-sky-50 text-sky-700 hover:bg-sky-100 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Buluta tekrar yükle"
                        >
                          <Upload className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => downloadStoredBackup(run)}
                          disabled={run.status !== 'success' || !run.file_path}
                          className="p-2 bg-primary/10 text-primary hover:bg-primary/20 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Yedeği indir"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deleteStoredBackup(run)}
                          disabled={!run.file_path || run.status !== 'success'}
                          className="p-2 bg-red-50 text-danger hover:bg-red-100 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          title="Yedeği sil"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!backupLoading && (!backupStatus?.runs || backupStatus.runs.length === 0) && (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-sm font-bold text-text-muted">Henüz otomatik yedek kaydı yok.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isAdmin && (
      <div className="card overflow-hidden divide-y divide-border-color mt-8 space-y-0">
          <div className="p-6 bg-red-50/50 border border-red-100 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
             <div className="flex items-start md:items-center">
               <AlertCircle className="w-5 h-5 text-danger mr-4 mt-1 md:mt-0" />
               <div>
                  <h4 className="text-sm font-bold text-danger uppercase tracking-tight">Veritabanı Bakımı & Yedekleme</h4>
                  <p className="text-xs text-text-muted mt-0.5">Olası çökme ve veri kayıplarına karşı yedek alabilirsiniz. Aldığınız yedeği "Geri Yükle" ile tekrar sisteme aktarabilirsiniz (Bu işlem mevcut verileri siler).</p>
               </div>
             </div>
             <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
               <button 
                 onClick={async () => {
                    if (window.confirm("Bu işlem eski formatta kalmış ürün fiyatlarını yeni fiyat yönetimine entegre edecektir. Onaylıyor musunuz?")) {
                       setLoading(true);
                       try {
                          const res = await api.post('/maintenance/fix-pricing', { confirm: 'FIX_PRICING' });
                          alert(res.message || "Fiyatlar onarıldı.");
                          onUpdate();
                       } catch(e: any) {
                          alert(e.message || "Hata oluştu");
                       } finally {
                          setLoading(false);
                       }
                    }
                 }}
                 className="px-5 py-2 bg-white border border-red-200 text-danger rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-danger/10 transition-all shadow-sm active:scale-95 text-center flex-1 md:flex-none"
               >
                 Fiyat Verilerini Onar
               </button>
               <label className="px-5 py-2 cursor-pointer bg-white border border-red-200 text-danger rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-danger/10 transition-all shadow-sm active:scale-95 text-center flex-1 md:flex-none">
                 Geri Yükle
                 <input type="file" accept=".zip" className="hidden" onClick={(e) => (e.target as HTMLInputElement).value = ''} onChange={(e) => {
                   const file = e.target.files?.[0];
                   if (!file) return;
                   
                   setConfirmRestoreFile(file);
                 }} />
               </label>
               <button 
                 onClick={handleDownloadBackup}
                 disabled={loading}
                 className="px-5 py-2 bg-danger border border-transparent text-white rounded-xl text-[11px] font-bold uppercase tracking-widest hover:bg-red-700 transition-all shadow-sm active:scale-95 text-center flex-1 md:flex-none disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
               >
                 <Download className="w-3.5 h-3.5" />
                 Yedek İndir
               </button>
             </div>
          </div>
      </div>
      )}

      {confirmRestoreFile && (
        <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
               <AlertCircle className="w-12 h-12 text-danger mx-auto mb-4" />
               <h3 className="text-xl font-black text-danger mb-2">DİKKAT</h3>
               <p className="text-sm font-medium text-text-muted mb-6">Mevcut sisteminizdeki tüm veriler (ürünler, satışlar, loglar) silinip yerine yüklediğiniz yedek dosyası geçecek. Bu işlem <span className="font-bold text-danger">Geri Alınamaz!</span></p>
               <p className="text-xs font-bold text-text-main mb-3">Onaylamak için büyük harflerle "ONAY" yazın:</p>
               <input 
                  type="text" 
                  autoFocus
                  className="form-input text-center font-black tracking-widest text-lg mb-6"
                  value={confirmInputText}
                  onChange={(e) => setConfirmInputText(e.target.value)}
                  placeholder="ONAY"
               />
               <div className="flex gap-3">
                 <button 
                   className="flex-1 bg-gray-100 text-text-main py-3 rounded-xl font-bold hover:bg-gray-200 transition-colors"
                   onClick={() => {
                     setConfirmRestoreFile(null);
                     setConfirmInputText("");
                   }}
                 >
                   İptal
                 </button>
                 <button 
                   className="flex-1 bg-danger text-white py-3 rounded-xl font-bold hover:bg-red-700 transition-colors disabled:opacity-50"
                   disabled={confirmInputText !== "ONAY"}
                   onClick={() => {
                     const file = confirmRestoreFile;
                     setConfirmRestoreFile(null);
                     setConfirmInputText("");
                     
                     if (!file) return;

                     const formData = new FormData();
                     formData.append("zipfile", file);
                     
                     setRestoreProgress({ percentage: 0, text: "Yükleniyor... %0" });
                     
                     const xhr = new XMLHttpRequest();
                     xhr.open("POST", "/api/backup/restore", true);
                     const token = getToken();
                     if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
                     
                     xhr.upload.onprogress = (event) => {
                       if (event.lengthComputable) {
                         const percent = Math.round((event.loaded / event.total) * 90);
                         setRestoreProgress({ percentage: percent, text: `Yükleniyor... %${percent}` });
                       }
                     };
                     
                     xhr.onload = () => {
                       if (xhr.status >= 200 && xhr.status < 300) {
                         setRestoreProgress({ percentage: 100, text: "Dosyalar çıkarılıyor ve geri yükleme tamamlanıyor..." });
                         setTimeout(() => {
                           alert("Sistem başarıyla yeni yedeğe geçirildi. Uygulama yeniden yüklenecek.");
                           window.location.reload();
                         }, 1000);
                       } else {
                         let errMsg = "Geri yükleme başarısız.";
                         try {
                           const err = JSON.parse(xhr.responseText);
                           if (err.error?.message) errMsg = err.error.message;
                           else if (err.error) errMsg = err.error;
                         } catch(e) {}
                         alert(errMsg);
                         setRestoreProgress(null);
                       }
                     };
                     
                     xhr.onerror = () => {
                       alert("Yükleme sırasında ağ hatası oluştu.");
                       setRestoreProgress(null);
                     };
                     
                     xhr.send(formData);
                   }}
                 >
                   Onaylıyorum
                 </button>
               </div>
           </div>
        </div>
      )}

      {restoreProgress && (
        <div className="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
               <AlertCircle className="w-12 h-12 text-primary mx-auto mb-4 animate-pulse" />
               <h3 className="text-xl font-black text-text-main mb-2">Sistem Geri Yükleniyor</h3>
               <p className="text-sm font-medium text-text-muted mb-6">{restoreProgress.text}</p>
               <div className="w-full bg-gray-100 rounded-full h-3 mb-2 overflow-hidden">
                   <div 
                     className="bg-primary h-3 rounded-full transition-all duration-300 ease-out"
                     style={{ width: `${restoreProgress.percentage}%` }}
                   ></div>
               </div>
               <p className="text-[10px] font-bold text-text-muted uppercase tracking-widest mt-4">
                 Lütfen sekmeyi kapatmayın...
               </p>
           </div>
        </div>
      )}
    </div>
  );
}

function CategoryList({ title, categories, newValue, onNewValueChange, onAdd, onRemove }: any) {
   return (
      <div className="space-y-4">
         <h4 className="text-[10px] font-bold text-text-muted uppercase tracking-[0.2em]">{title}</h4>
         <div className="space-y-2">
            <div className="flex space-x-2">
               <input 
                  type="text" 
                  value={newValue}
                  onChange={(e) => onNewValueChange(e.target.value)}
                  placeholder="Ekleyin..."
                  className="form-input text-xs py-1.5"
                  onKeyDown={(e) => e.key === 'Enter' && onAdd()}
               />
               <button 
                  onClick={onAdd}
                  className="p-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors"
               >
                  <Plus className="w-4 h-4" />
               </button>
            </div>
            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
               {categories.map((c: string) => (
                  <div key={c} className="flex items-center justify-between px-3 py-2 bg-bg-main rounded-lg border border-border-color group">
                     <span className="text-xs font-bold text-text-main">{c}</span>
                     <button 
                        onClick={() => onRemove(c)}
                        className="text-text-muted hover:text-danger p-1 rounded transition-colors opacity-0 group-hover:opacity-100"
                     >
                        <Trash2 className="w-3 h-3" />
                     </button>
                  </div>
               ))}
            </div>
         </div>
      </div>
   );
}

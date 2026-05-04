import { useState, useEffect, createContext, useContext } from 'react';
import {
  LayoutDashboard,
  Package,
  ArrowLeftRight,
  TrendingUp,
  TrendingDown,
  Settings as SettingsIcon,
  BarChart3,
  BarChart2,
  Repeat,
  Search,
  Bell,
  ChevronRight,
  Menu,
  X,
  LogOut,
  Activity,
  Briefcase,
  ShoppingCart,
  Key,
  TerminalSquare,
  Landmark,
  AlertTriangle,
  RefreshCw,
  Eye
} from 'lucide-react';
import Dashboard from './components/Dashboard';
import ProductList from './components/ProductList';
import ProductDetail from './components/ProductDetail';
import ProductWizard from './components/ProductWizard';
import Transactions from './components/Transactions';
import Expenses from './components/Expenses';
import Analytics from './components/Analytics';
import ProductAnalyticsPage from './pages/ProductAnalyticsPage';
import RecurringPayments from './components/RecurringPayments';
import SettingsView from './components/SettingsView';
import ActivityLogs from './components/ActivityLogs';
import LoginPage from './components/LoginPage';
import FinanceModule from './components/FinanceModule';
import { api } from './lib/api';
import { Settings, type UserRole } from './types';
import { clsx, type ClassValue } from 'clsx';
import { useCurrency } from './CurrencyContext';
import { twMerge } from 'tailwind-merge';

import B2BFirms from './components/b2b/B2BFirms';
import B2BFirmDetail from './components/b2b/B2BFirmDetail';
import B2BFirmForm from './components/b2b/B2BFirmForm';
import Sales from './components/sales/Sales';
import ApiKeys from './components/integrations/ApiKeys';
import PanelApiKeys from './components/integrations/PanelApiKeys';
import TrendyolIntegration from './components/integrations/TrendyolIntegration';

const APP_VERSION = 'v2.5.5';

export const AuthContext = createContext<{ role: UserRole, isReadOnly: boolean }>({ role: 'admin', isReadOnly: false });
export const useAuth = () => useContext(AuthContext);

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function normalizeRole(role: unknown): UserRole {
  return role === 'admin' || role === 'user' || role === 'readonly' ? role : 'admin';
}

type View = 'dashboard' | 'products' | 'product-detail' | 'product-wizard' | 'stock' | 'income' | 'expense' | 'recurring' | 'analytics' | 'product-analytics' | 'settings' | 'activity-logs' | 'b2b' | 'sales' | 'api-keys' | 'panel-api' | 'trendyol' | 'cash';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  const [userRole, setUserRole] = useState<UserRole>('admin');

  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [selectedFirmId, setSelectedFirmId] = useState<string | null>(null);
  const [analyticsTab, setAnalyticsTab] = useState<string | undefined>(undefined);
  const [showFirmAdd, setShowFirmAdd] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('isSidebarOpen');
      if (saved !== null) return saved === 'true';
    } catch {
      // ignore
    }
    return window.innerWidth > 768;
  });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem('isSidebarOpen', String(isSidebarOpen));
    } catch {
      // ignore
    }
  }, [isSidebarOpen]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth <= 768) {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const { fetchRate } = useCurrency();

  useEffect(() => {
    const verifyToken = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        setIsCheckingAuth(false);
        return;
      }
      try {
        const res = await api.get('/auth/me');
        if (res.success) {
          setIsAuthenticated(true);
          setUserRole(normalizeRole(res.user?.role));
          loadSettings();
          fetchRate();
        } else {
          localStorage.removeItem('token');
          localStorage.removeItem('userRole');
        }
      } catch (err) {
        console.error("Auth verification failed", err);
        localStorage.removeItem('token');
        localStorage.removeItem('userRole');
      } finally {
        setIsCheckingAuth(false);
      }
    };
    verifyToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.get('/settings');
      setSettings(data);
    } catch (err) {
      console.error("Settings load error:", err);
    }
  };

  const handleLogin = (role: UserRole) => {
    setIsAuthenticated(true);
    setUserRole(role);
    loadSettings();
    fetchRate();
  };

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const handleConfirmLogout = () => {
    try {
      localStorage.removeItem('token');
      localStorage.removeItem('userRole');
    } catch {
      // ignore
    }
    setIsAuthenticated(false);
    setShowLogoutConfirm(false);
  };

  const handleCancelLogout = () => {
    setShowLogoutConfirm(false);
  };

  const navigateToProduct = (id: string) => {
    setSelectedProductId(id);
    setCurrentView('product-detail');
  };

  const navigateToAnalytics = (tab: string) => {
    setAnalyticsTab(tab);
    setCurrentView('analytics');
  };

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'products', label: 'Ürünler', icon: Package },
    { id: 'sales', label: 'Satışlar', icon: ShoppingCart },
    { id: 'b2b', label: 'B2B', icon: Briefcase },
    { id: 'cash', label: 'Finans Merkezi', icon: Landmark },
    { id: 'income', label: 'Gelirler', icon: TrendingUp },
    { id: 'expense', label: 'Giderler', icon: TrendingDown },
    { id: 'recurring', label: 'Periyodikler', icon: Repeat },
    { id: 'analytics', label: 'Genel Analizler', icon: BarChart3 },
    { id: 'product-analytics', label: 'Ürün Analizi', icon: BarChart2 },
  ];
  const isReadOnly = userRole === 'readonly';
  const restrictedReadonlyViews: View[] = ['settings', 'api-keys', 'panel-api', 'trendyol', 'product-wizard', 'b2b'];
  const visibleNavItems = navItems.filter(item => !isReadOnly || item.id !== 'b2b');

  useEffect(() => {
    if (!isReadOnly) return;
    if (restrictedReadonlyViews.includes(currentView)) {
      setCurrentView('dashboard');
      setSelectedProductId(null);
    }
    if (showFirmAdd) setShowFirmAdd(false);
  }, [currentView, isReadOnly, showFirmAdd]);

  const { viewCurrency, setViewCurrency, activeRate, rateSource, rateFetchedAt, isRateLoading, isRateError, refreshRate } = useCurrency();

  const currentViewLabel =
    navItems.find(i => i.id === currentView)?.label ||
    (currentView === 'api-keys' ? 'API Anahtarları' :
      currentView === 'panel-api' ? 'Panel API' :
        currentView === 'trendyol' ? 'Trendyol' :
          currentView === 'settings' ? 'Ayarlar' :
            currentView === 'activity-logs' ? 'Aktivite Logları' :
              'Ürün Detayı');

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen bg-[#FDFDFD] flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <AuthContext.Provider value={{ role: userRole, isReadOnly }}>
      <div className="min-h-screen bg-bg-main text-text-main font-sans selection:bg-primary/10" data-role={userRole} data-readonly={isReadOnly ? 'true' : 'false'}>
      {/* Sidebar */}
      <aside className={cn(
        "fixed left-0 top-0 h-full border-r border-border-color bg-sidebar-bg text-white transition-all duration-300 z-50 flex flex-col",
        isSidebarOpen ? "w-64" : "w-20",
        "md:translate-x-0",
        isMobileMenuOpen ? "translate-x-0 w-64" : "-translate-x-full md:translate-x-0"
      )}>
        <div className="flex h-16 items-center px-4 border-b border-white/10 shrink-0">
          {(isSidebarOpen || isMobileMenuOpen) ? (
            <div className="flex items-center justify-between w-full">
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                <img src="/logo.svg" alt="DSDST Logo" className="w-8 h-8 shrink-0" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <h1 className="min-w-0 truncate whitespace-nowrap text-[18px] font-black leading-none tracking-tight text-white">
                    {settings?.company_name || 'DSDST Panel'}
                  </h1>
                  <span className="shrink-0 rounded-full border border-white/15 bg-white/10 px-2 py-0.5 text-[10px] font-black tracking-wide text-cyan-200">
                    {APP_VERSION}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setIsMobileMenuOpen(false)}
                className="md:hidden p-1 text-white/50 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          ) : (
             <div className="w-full flex justify-center">
               <img src="/logo.svg" alt="DSDST" className="w-8 h-8" />
             </div>
          )}
        </div>

        <nav className="mt-4 px-0 space-y-0.5 overflow-y-auto flex-1">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setCurrentView(item.id as View);
                if (item.id === 'b2b') {
                  setSelectedFirmId(null);
                }
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === item.id || (item.id === 'products' && (currentView === 'product-detail' || currentView === 'product-wizard'))
                  ? "bg-primary/10 text-white border-l-4 border-primary"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
            >
              <item.icon className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>{item.label}</span>}
            </button>
          ))}

          {!isReadOnly && (isSidebarOpen || isMobileMenuOpen) && (
            <div className="pt-4 pb-2 px-6">
              <p className="text-white/40 text-xs font-bold uppercase tracking-wider">Entegrasyonlar</p>
            </div>
          )}
          {!isReadOnly && <button
              onClick={() => {
                setCurrentView('api-keys');
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === 'api-keys'
                  ? "bg-primary/10 text-white border-l-4 border-primary"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
              title="API Anahtarları"
            >
              <Key className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>API Anahtarları</span>}
          </button>}

          {!isReadOnly && <button
              onClick={() => {
                setCurrentView('panel-api');
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === 'panel-api'
                  ? "bg-purple-500/10 text-white border-l-4 border-purple-500"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
              title="Panel API"
            >
              <TerminalSquare className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>Panel API</span>}
          </button>}

          {!isReadOnly && <button
              onClick={() => {
                setCurrentView('trendyol');
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === 'trendyol'
                  ? "bg-orange-500/10 text-white border-l-4 border-orange-500"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
              title="Trendyol"
            >
              <ShoppingCart className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>Trendyol</span>}
          </button>}
        </nav>

        <div className="mt-auto border-t border-white/10 pb-4 pt-2 shrink-0">
            <button
              onClick={() => {
                setCurrentView('activity-logs');
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === 'activity-logs'
                  ? "bg-primary/10 text-white border-l-4 border-primary"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
            >
              <Activity className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>Aktivite Logları</span>}
            </button>
            {!isReadOnly && <button
              onClick={() => {
                setCurrentView('settings');
                setIsMobileMenuOpen(false);
              }}
              className={cn(
                "w-full flex items-center px-6 py-3.5 transition-all text-sm font-medium group relative",
                currentView === 'settings'
                  ? "bg-primary/10 text-white border-l-4 border-primary"
                  : "text-[#94a3b8] hover:bg-white/5 hover:text-white"
              )}
            >
              <SettingsIcon className={cn("w-5 h-5", (isSidebarOpen || isMobileMenuOpen) ? "mr-3" : "mx-auto")} />
              {(isSidebarOpen || isMobileMenuOpen) && <span>Ayarlar</span>}
            </button>}

            {(isSidebarOpen || isMobileMenuOpen) ? (
              <div className="px-4 mt-2 pt-2 border-t border-white/10 text-center">
                <button
                  onClick={handleLogoutClick}
                  className="w-full flex items-center space-x-3 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all text-sm font-bold logout-override-ignore"
                >
                    <LogOut className="w-5 h-5" />
                    <span>Çıkış Yap</span>
                </button>
              </div>
            ) : (
              <div className="mt-2 pt-2 border-t border-white/10 flex justify-center">
                 <button
                  onClick={handleLogoutClick}
                  className="p-2.5 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all logout-override-ignore"
                  title="Çıkış Yap"
                >
                    <LogOut className="w-5 h-5" />
                </button>
              </div>
            )}
        </div>

        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="hidden md:flex absolute bottom-4 right-[-12px] w-6 h-6 bg-white border border-border-color text-sidebar-bg rounded-full items-center justify-center hover:bg-bg-main shadow-md cursor-pointer transition-transform"
        >
          <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", isSidebarOpen && "rotate-180")} />
        </button>
      </aside>

      {/* Overlay for mobile */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Main Content */}
      <main className={cn(
        "transition-all duration-300 min-h-screen flex flex-col w-full overflow-x-hidden",
        isSidebarOpen ? "md:pl-64" : "md:pl-20"
      )}>
        {/* Header */}
        <div className="sticky top-0 z-40 bg-white border-b border-border-color shadow-sm">
          <header className="h-16 flex items-center justify-between px-4 md:px-8">
            <div className="flex items-center space-x-4 md:space-x-6">
               <button
                 onClick={() => setIsMobileMenuOpen(true)}
                 className="md:hidden p-2 text-text-muted hover:text-primary transition-colors"
               >
                  <Menu className="w-6 h-6" />
               </button>
               <h2 className="text-base md:text-lg font-semibold text-text-main truncate">
                  {currentViewLabel}
               </h2>
            </div>

            <div className="flex items-center space-x-2 md:space-x-6">
               {/* Exchange Rate Indicator */}
               <div
                 className="hidden md:flex items-center gap-2 group relative bg-gray-50 border border-gray-200 px-3 py-1.5 rounded-xl transition-all hover:bg-gray-100"
                 title={`Kaynak: ${rateSource || 'Bilinmiyor'}`}
               >
                  {isRateError && (
                     <AlertTriangle className="w-4 h-4 text-red-500" />
                  )}
                  <span className="font-bold text-sm text-gray-700 whitespace-nowrap">USD/TRY: ₺{activeRate?.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  {rateFetchedAt && (
                     <span className="text-[10px] text-gray-500 font-medium whitespace-nowrap">· Son güncelleme: {new Date(rateFetchedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>
                  )}
                  <button onClick={refreshRate} disabled={isRateLoading} className="p-1 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50 ml-1">
                     <RefreshCw className={cn("w-3.5 h-3.5 text-gray-500", isRateLoading && "animate-spin")} />
                  </button>
               </div>

               {/* Global Currency Toggle */}
               <div className="hidden sm:flex bg-gray-100 p-1 rounded-xl items-center gap-1">
                 <button
                   onClick={() => setViewCurrency('TRY')}
                   className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${viewCurrency === 'TRY' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                 >TL</button>
                 <button
                   onClick={() => setViewCurrency('USD')}
                   className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${viewCurrency === 'USD' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                 >USD</button>
                 <button
                   onClick={() => setViewCurrency('TL+USD')}
                   className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${viewCurrency === 'TL+USD' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                 >TL+USD</button>
               </div>

               <div className="relative hidden md:block search-bar-container">
                 <input
                   type="text"
                   placeholder="Ürün Ara..."
                   className="pl-9 pr-4 py-1.5 bg-bg-main border border-border-color rounded-lg text-sm w-40 md:w-60 focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none"
                 />
                 <Search className="w-4 h-4 text-text-muted absolute left-3 top-2" />
               </div>
               <button className="p-2 text-text-muted hover:text-primary transition-colors">
                 <Bell className="w-5 h-5" />
               </button>
               <div className="flex items-center space-x-2 md:space-x-3 border-l border-border-color pl-2 md:pl-6">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                  {userRole === 'admin' ? 'AD' : userRole === 'readonly' ? 'RO' : 'US'}
                </div>
                <span className="text-sm font-semibold text-text-main hidden sm:inline capitalize">{userRole}</span>
              </div>
            </div>
          </header>

          {/* Mobile Subheader */}
          <div className="sm:hidden flex items-center justify-between px-4 py-2.5 bg-gray-50 border-t border-gray-100">
             <div className="flex items-center gap-2">
                <span className="font-bold text-xs text-gray-700 whitespace-nowrap">₺{activeRate?.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <button onClick={refreshRate} disabled={isRateLoading} className="p-1 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50">
                   <RefreshCw className={cn("w-3 h-3 text-gray-500", isRateLoading && "animate-spin")} />
                </button>
             </div>

             <div className="flex bg-gray-200/50 p-1 rounded-lg items-center gap-1">
               <button
                 onClick={() => setViewCurrency('TRY')}
                 className={`px-2 py-1 rounded-[5px] text-[10px] font-bold transition-all ${viewCurrency === 'TRY' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
               >TL</button>
               <button
                 onClick={() => setViewCurrency('USD')}
                 className={`px-2 py-1 rounded-[5px] text-[10px] font-bold transition-all ${viewCurrency === 'USD' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
               >USD</button>
               <button
                 onClick={() => setViewCurrency('TL+USD')}
                 className={`px-2 py-1 rounded-[5px] text-[10px] font-bold transition-all ${viewCurrency === 'TL+USD' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
               >TL+USD</button>
             </div>
          </div>
        </div>

        {isReadOnly && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 md:px-8 py-3">
            <div className="max-w-[1600px] mx-auto flex items-center gap-3 text-amber-900">
              <div className="w-8 h-8 rounded-xl bg-amber-100 border border-amber-200 flex items-center justify-center shrink-0">
                <Eye className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-black">Salt okunur moddasınız</p>
                <p className="text-xs font-medium text-amber-800">Verileri görüntüleyebilirsiniz; ekleme, düzenleme, silme, yedekleme ve API anahtarı yönetimi kapalıdır.</p>
              </div>
            </div>
          </div>
        )}

        {/* Readonly role constraints for legacy write buttons that do not yet consume AuthContext. */}
        {isReadOnly && (
          <style>{`
             [data-readonly="true"] button[data-write-action="true"],
             [data-readonly="true"] a[data-write-action="true"],
             [data-readonly="true"] label[data-write-action="true"],
             [data-readonly="true"] button.btn-primary,
             [data-readonly="true"] button:has(svg.lucide-plus),
             [data-readonly="true"] button:has(svg.lucide-save),
             [data-readonly="true"] button:has(svg.lucide-edit-3),
             [data-readonly="true"] button:has(svg.lucide-trash),
             [data-readonly="true"] button:has(svg.lucide-trash-2),
             [data-readonly="true"] button:has(svg.lucide-minus),
             [data-readonly="true"] button:has(svg.lucide-upload),
             [data-readonly="true"] button:has(svg.lucide-calculator),
             [data-readonly="true"] button.text-red-500:not(.logout-override-ignore),
             [data-readonly="true"] button.text-red-600,
             [data-readonly="true"] button.text-danger,
             [data-readonly="true"] button.border-red-200,
             [data-readonly="true"] label.text-danger,
             [data-readonly="true"] label.border-red-200 {
                display: none !important;
             }
          `}</style>
        )}

        {/* View Container */}
        <div className="p-4 md:p-6 flex-1 max-w-[1600px] w-full mx-auto">
          {currentView === 'dashboard' && <Dashboard onNavigate={setCurrentView} onNavigateAnalytics={navigateToAnalytics} onProductClick={navigateToProduct} />}
          {currentView === 'products' && (
            <ProductList
              onAddProduct={() => {
                if (isReadOnly) return;
                setSelectedProductId(null);
                setCurrentView('product-wizard');
              }}
              onProductClick={navigateToProduct}
            />
          )}
          {currentView === 'product-detail' && selectedProductId && (
             <ProductDetail
                productId={selectedProductId}
                onBack={() => setCurrentView('products')}
                onEdit={() => {
                  if (isReadOnly) return;
                  setCurrentView('product-wizard');
                }}
             />
          )}
          {!isReadOnly && currentView === 'product-wizard' && (
            <ProductWizard
              productId={selectedProductId}
              settings={settings}
              onClose={() => {
                setCurrentView('products');
                setSelectedProductId(null);
              }}
            />
          )}
          {!isReadOnly && currentView === 'b2b' && !selectedFirmId && (
            <B2BFirms
              onFirmClick={(id: string) => setSelectedFirmId(id)}
              onAddFirm={() => {
                if (isReadOnly) return;
                setShowFirmAdd(true);
              }}
            />
          )}
          {!isReadOnly && currentView === 'b2b' && selectedFirmId && (
            <B2BFirmDetail firmId={selectedFirmId} onBack={() => setSelectedFirmId(null)} />
          )}
          {!isReadOnly && showFirmAdd && (
            <B2BFirmForm onClose={() => setShowFirmAdd(false)} onSave={() => {
              setCurrentView('b2b');
              setSelectedFirmId(null);
            }} />
          )}
          {currentView === 'sales' && <Sales />}
          {currentView === 'cash' && <FinanceModule settings={settings} />}
          {currentView === 'income' && <Transactions initialType="Income" settings={settings} />}
          {currentView === 'expense' && <Expenses settings={settings} />}
          {currentView === 'recurring' && <RecurringPayments settings={settings} />}
          {currentView === 'analytics' && <Analytics settings={settings} initialTab={analyticsTab} />}
          {currentView === 'product-analytics' && <ProductAnalyticsPage />}
          {currentView === 'activity-logs' && <ActivityLogs />}
          {!isReadOnly && currentView === 'settings' && <SettingsView onUpdate={loadSettings} />}
          {!isReadOnly && currentView === 'api-keys' && <ApiKeys />}
          {!isReadOnly && currentView === 'panel-api' && <PanelApiKeys />}
          {!isReadOnly && currentView === 'trendyol' && <TrendyolIntegration />}
        </div>
        {showLogoutConfirm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200" onClick={handleCancelLogout}>
            <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="p-6 text-center">
                <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                  <LogOut className="w-8 h-8 text-red-500" />
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Çıkış Yap</h3>
                <p className="text-gray-500 text-sm mb-6">
                  Hesabınızdan çıkış yapmak istediğinize emin misiniz?
                </p>
                <div className="flex flex-col gap-3">
                  <button
                    onClick={handleConfirmLogout}
                    className="w-full py-3 bg-red-500 hover:bg-red-600 text-white rounded-xl font-bold transition-colors"
                  >
                    Evet, Çıkış Yap
                  </button>
                  <button
                    onClick={handleCancelLogout}
                    className="w-full py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-bold transition-colors"
                  >
                    İptal
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
    </AuthContext.Provider>
  );
}

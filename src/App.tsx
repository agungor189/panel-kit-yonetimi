import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import {
  LayoutDashboard,
  Package,
  TrendingUp,
  TrendingDown,
  Settings as SettingsIcon,
  BarChart3,
  BarChart2,
  Repeat,
  Activity,
  Briefcase,
  ShoppingCart,
  Key,
  TerminalSquare,
  Landmark,
  ShieldAlert,
} from 'lucide-react';
import Dashboard from './components/Dashboard';
import ProductList from './components/ProductList';
import ProductDetail from './components/ProductDetail';
import ProductWizard from './components/ProductWizard';
import Transactions from './components/Transactions';
import Expenses from './components/Expenses';
import Analytics from './components/Analytics';
import ProductAnalyticsPage from './pages/ProductAnalyticsPage';
import InsightsPage from './pages/InsightsPage';
import RecurringPayments from './components/RecurringPayments';
import SettingsView from './components/SettingsView';
import PushNotificationSettings from './components/PushNotificationSettings';
import ActivityLogs from './components/ActivityLogs';
import LoginPage from './components/LoginPage';
import FinanceModule from './components/FinanceModule';
import { api } from './lib/api';
import { Settings, type UserRole } from './types';
import { useCurrency } from './CurrencyContext';

import B2BFirms from './components/b2b/B2BFirms';
import B2BFirmDetail from './components/b2b/B2BFirmDetail';
import B2BFirmForm from './components/b2b/B2BFirmForm';
import Sales from './components/sales/Sales';
import ApiKeys from './components/integrations/ApiKeys';
import PanelApiKeys from './components/integrations/PanelApiKeys';
import TrendyolIntegration from './components/integrations/TrendyolIntegration';
import ChannelsIntegration from './components/integrations/ChannelsIntegration';
import ReconciliationCenter from './components/ReconciliationCenter';
import { AppShell, type NavItemDefinition } from './components/layout';
import {
  listenToBrowserNavigation,
  pathToNavigation,
  updateBrowserNavigation,
  type NavigationState,
  type View,
} from './lib/navigation';

const APP_VERSION = 'v2.5.5';

type AuthContextValue = {
  role: UserRole;
  isReadOnly: boolean;
  permissions: Record<string, unknown>;
};

export const AuthContext = createContext<AuthContextValue>({ role: 'admin', isReadOnly: false, permissions: {} });
export const useAuth = () => useContext(AuthContext);

function normalizeRole(role: unknown): UserRole {
  return role === 'admin' || role === 'user' || role === 'readonly' ? role : 'admin';
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  const [userRole, setUserRole] = useState<UserRole>('admin');
  const [userPermissions, setUserPermissions] = useState<Record<string, unknown>>({});

  const [navigation, setNavigation] = useState<NavigationState>(() => pathToNavigation(window.location.pathname));
  const currentView = navigation.view;
  const selectedProductId = navigation.productId || null;
  const selectedFirmId = navigation.firmId || null;
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

  const navigate = useCallback((nextNavigation: NavigationState, mode: 'push' | 'replace' = 'push') => {
    updateBrowserNavigation(window, nextNavigation, mode);
    setNavigation(nextNavigation);
    setIsMobileMenuOpen(false);
  }, []);

  const navigateToView = useCallback((view: View) => navigate({ view }), [navigate]);

  useEffect(() => {
    const initialNavigation = pathToNavigation(window.location.pathname);
    updateBrowserNavigation(window, initialNavigation, 'replace');
    setNavigation(initialNavigation);

    return listenToBrowserNavigation(window, (nextNavigation) => {
      setNavigation(nextNavigation);
      setIsMobileMenuOpen(false);
    });
  }, []);

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
      try {
        const res = await api.get('/auth/me');
        if (res.success) {
          setIsAuthenticated(true);
          setUserRole(normalizeRole(res.user?.role));
          setUserPermissions(res.user?.permissions || {});
          loadSettings();
          fetchRate();
        } else {
          setIsAuthenticated(false);
        }
      } catch (err) {
        console.error("Auth verification failed", err);
        setIsAuthenticated(false);
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

  const handleLogin = (role: UserRole, permissions: Record<string, unknown> = {}) => {
    setIsAuthenticated(true);
    setUserRole(role);
    setUserPermissions(permissions);
    loadSettings();
    fetchRate();
  };

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const handleConfirmLogout = async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      return;
    }
    setIsAuthenticated(false);
    setUserPermissions({});
    setShowLogoutConfirm(false);
  };

  const handleCancelLogout = () => {
    setShowLogoutConfirm(false);
  };

  const navigateToProduct = (id: string) => {
    navigate({ view: 'product-detail', productId: id });
  };

  const navigateToAnalytics = (tab: string) => {
    setAnalyticsTab(tab);
    navigate({ view: 'analytics' });
  };

  const mainNavItems: NavItemDefinition[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'products', label: 'Ürünler', icon: Package },
    { id: 'sales', label: 'Satışlar', icon: ShoppingCart },
    { id: 'b2b', label: 'B2B', icon: Briefcase },
    { id: 'cash', label: 'Finans Merkezi', icon: Landmark },
    { id: 'income', label: 'Gelirler', icon: TrendingUp },
    { id: 'expense', label: 'Giderler', icon: TrendingDown },
    { id: 'recurring', label: 'Periyodikler', icon: Repeat },
  ];
  const analyticsNavItems: NavItemDefinition[] = [
    { id: 'analytics', label: 'Genel Analizler', icon: BarChart3 },
    { id: 'product-analytics', label: 'Ürün Analizi', icon: BarChart2 },
    { id: 'insights', label: 'Stok & Sipariş Analizi', icon: BarChart3 },
  ];
  const navItems = [...mainNavItems, ...analyticsNavItems];
  const isReadOnly = userRole === 'readonly';
  const restrictedReadonlyViews: View[] = ['api-keys', 'panel-api', 'trendyol', 'channels', 'product-wizard', 'b2b'];
  const primaryNavItems = mainNavItems.filter(item => ['dashboard', 'products', 'sales', 'b2b', 'cash'].includes(item.id));
  const financeNavItems = mainNavItems.filter(item => ['income', 'expense', 'recurring'].includes(item.id));
  const integrationNavItems: NavItemDefinition[] = [
    { id: 'api-keys', label: 'API Anahtarları', icon: Key },
    { id: 'panel-api', label: 'Panel API', icon: TerminalSquare, tone: 'purple' },
    { id: 'trendyol', label: 'Trendyol', icon: ShoppingCart, tone: 'orange' },
    { id: 'channels', label: 'Kanallar', icon: ShoppingCart, tone: 'orange' },
  ];
  const systemNavItems: NavItemDefinition[] = [
    { id: 'reconciliation', label: 'Sistem Kontrolü', icon: ShieldAlert },
    { id: 'activity-logs', label: 'Aktivite Logları', icon: Activity },
    { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
  ];

  useEffect(() => {
    if (!isReadOnly) return;
    if (restrictedReadonlyViews.includes(currentView)) {
      navigate({ view: 'dashboard' }, 'replace');
    }
    if (showFirmAdd) setShowFirmAdd(false);
  }, [currentView, isReadOnly, navigate, showFirmAdd]);

  const { viewCurrency, setViewCurrency, activeRate, rateSource, rateFetchedAt, isRateLoading, isRateError, refreshRate } = useCurrency();

  const currentViewLabel =
    navItems.find(i => i.id === currentView)?.label ||
    (currentView === 'api-keys' ? 'API Anahtarları' :
      currentView === 'panel-api' ? 'Panel API' :
        currentView === 'trendyol' ? 'Trendyol' :
          currentView === 'channels' ? 'Kanallar' :
          currentView === 'settings' ? 'Ayarlar' :
          currentView === 'activity-logs' ? 'Aktivite Logları' :
          currentView === 'reconciliation' ? 'Reconciliation / Sistem Kontrolü' :
              'Ürün Detayı');

  const selectView = (id: View) => {
    navigateToView(id);
  };

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
    <AuthContext.Provider value={{ role: userRole, isReadOnly, permissions: userPermissions }}>
      <AppShell
        appVersion={APP_VERSION}
        currentView={currentView}
        currentViewLabel={currentViewLabel}
        userRole={userRole}
        isReadOnly={isReadOnly}
        isSidebarOpen={isSidebarOpen}
        isMobileMenuOpen={isMobileMenuOpen}
        showLogoutConfirm={showLogoutConfirm}
        primaryNavItems={primaryNavItems}
        financeNavItems={financeNavItems}
        analyticsNavItems={analyticsNavItems}
        integrationNavItems={integrationNavItems}
        systemNavItems={systemNavItems}
        viewCurrency={viewCurrency}
        activeRate={activeRate}
        rateSource={rateSource}
        rateFetchedAt={rateFetchedAt}
        isRateLoading={isRateLoading}
        isRateError={isRateError}
        onSelectView={selectView}
        onToggleSidebar={() => setIsSidebarOpen(open => !open)}
        onOpenMobileMenu={() => setIsMobileMenuOpen(true)}
        onCloseMobileMenu={() => setIsMobileMenuOpen(false)}
        onCurrencyChange={setViewCurrency}
        onRefreshRate={refreshRate}
        onLogout={handleLogoutClick}
        onConfirmLogout={handleConfirmLogout}
        onCancelLogout={handleCancelLogout}
      >
          {currentView === 'dashboard' && <Dashboard onNavigate={navigateToView} onNavigateAnalytics={navigateToAnalytics} onProductClick={navigateToProduct} />}
          {currentView === 'products' && (
            <ProductList
              onAddProduct={() => {
                if (isReadOnly) return;
                navigate({ view: 'product-wizard' });
              }}
              onProductClick={navigateToProduct}
            />
          )}
          {currentView === 'product-detail' && selectedProductId && (
             <ProductDetail
                productId={selectedProductId}
                onBack={() => navigate({ view: 'products' })}
                onEdit={() => {
                  if (isReadOnly) return;
                  navigate({ view: 'product-wizard', productId: selectedProductId });
                }}
             />
          )}
          {!isReadOnly && currentView === 'product-wizard' && (
            <ProductWizard
              productId={selectedProductId}
              settings={settings}
              onClose={() => {
                navigate({ view: 'products' });
              }}
            />
          )}
          {!isReadOnly && currentView === 'b2b' && !selectedFirmId && (
            <B2BFirms
              onFirmClick={(id: string) => navigate({ view: 'b2b', firmId: id })}
              onAddFirm={() => {
                if (isReadOnly) return;
                setShowFirmAdd(true);
              }}
            />
          )}
          {!isReadOnly && currentView === 'b2b' && selectedFirmId && (
            <B2BFirmDetail firmId={selectedFirmId} onBack={() => navigate({ view: 'b2b' })} />
          )}
          {!isReadOnly && showFirmAdd && (
            <B2BFirmForm onClose={() => setShowFirmAdd(false)} onSave={() => {
              navigate({ view: 'b2b' });
            }} />
          )}
          {currentView === 'sales' && <Sales />}
          {currentView === 'cash' && <FinanceModule settings={settings} />}
          {currentView === 'income' && <Transactions initialType="Income" settings={settings} />}
          {currentView === 'expense' && <Expenses settings={settings} />}
          {currentView === 'recurring' && <RecurringPayments settings={settings} />}
          {currentView === 'analytics' && <Analytics settings={settings} initialTab={analyticsTab} />}
          {currentView === 'product-analytics' && <ProductAnalyticsPage />}
          {currentView === 'insights' && <InsightsPage />}
          {currentView === 'activity-logs' && <ActivityLogs />}
          {currentView === 'reconciliation' && <ReconciliationCenter />}
          {currentView === 'settings' && (isReadOnly ? (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-text-main lg:text-2xl">Ayarlar</h2>
                <p className="mt-1 text-sm text-text-muted">Kendi cihaz bildirimlerinizi yönetin.</p>
              </div>
              <PushNotificationSettings />
            </div>
          ) : <SettingsView onUpdate={loadSettings} />)}
          {!isReadOnly && currentView === 'api-keys' && <ApiKeys />}
          {!isReadOnly && currentView === 'panel-api' && <PanelApiKeys />}
          {!isReadOnly && currentView === 'trendyol' && <TrendyolIntegration />}
          {!isReadOnly && currentView === 'channels' && <ChannelsIntegration />}
      </AppShell>
    </AuthContext.Provider>
  );
}

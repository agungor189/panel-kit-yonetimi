export type View =
  | 'dashboard'
  | 'products'
  | 'product-detail'
  | 'product-wizard'
  | 'income'
  | 'expense'
  | 'recurring'
  | 'analytics'
  | 'product-analytics'
  | 'insights'
  | 'settings'
  | 'activity-logs'
  | 'reconciliation'
  | 'b2b'
  | 'sales'
  | 'api-keys'
  | 'panel-api'
  | 'trendyol'
  | 'channels'
  | 'cash';

export type NavigationState = {
  view: View;
  productId?: string;
  firmId?: string;
};

const VIEW_PATHS: Partial<Record<View, string>> = {
  dashboard: '/',
  products: '/products',
  sales: '/sales',
  b2b: '/b2b',
  cash: '/cash',
  income: '/income',
  expense: '/expenses',
  recurring: '/recurring',
  analytics: '/analytics',
  'product-analytics': '/product-analytics',
  insights: '/insights',
  'activity-logs': '/activity-logs',
  reconciliation: '/reconciliation',
  settings: '/settings',
  'api-keys': '/api-keys',
  'panel-api': '/panel-api',
  trendyol: '/trendyol',
  channels: '/channels',
};

const PATH_VIEWS = new Map(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]),
);

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function pathToNavigation(pathname: string): NavigationState {
  const segments = pathname.split('/').filter(Boolean);
  const normalizedPath = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  const staticView = PATH_VIEWS.get(normalizedPath);
  if (staticView) return { view: staticView };

  if (segments[0] === 'products') {
    if (segments.length === 2 && segments[1] === 'new') {
      return { view: 'product-wizard' };
    }

    const productId = segments[1] ? decodePathSegment(segments[1]) : null;
    if (!productId) return { view: 'dashboard' };

    if (segments.length === 2) {
      return { view: 'product-detail', productId };
    }
    if (segments.length === 3 && segments[2] === 'edit') {
      return { view: 'product-wizard', productId };
    }
  }

  if (segments[0] === 'b2b' && segments.length === 2) {
    const firmId = decodePathSegment(segments[1]);
    if (firmId) return { view: 'b2b', firmId };
  }

  return { view: 'dashboard' };
}

export function navigationToPath(navigation: NavigationState): string {
  if (navigation.view === 'product-detail') {
    return navigation.productId ? `/products/${encodeURIComponent(navigation.productId)}` : '/products';
  }
  if (navigation.view === 'product-wizard') {
    return navigation.productId ? `/products/${encodeURIComponent(navigation.productId)}/edit` : '/products/new';
  }
  if (navigation.view === 'b2b' && navigation.firmId) {
    return `/b2b/${encodeURIComponent(navigation.firmId)}`;
  }
  return VIEW_PATHS[navigation.view] || '/';
}

type HistoryState = {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

export type BrowserNavigationTarget = {
  location: { readonly pathname: string };
  history: HistoryState;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
};

export function updateBrowserNavigation(
  target: BrowserNavigationTarget,
  navigation: NavigationState,
  mode: 'push' | 'replace' = 'push',
) {
  const path = navigationToPath(navigation);
  if (target.location.pathname === path) return;
  target.history[mode === 'replace' ? 'replaceState' : 'pushState'](null, '', path);
}

export function listenToBrowserNavigation(
  target: BrowserNavigationTarget,
  onNavigation: (navigation: NavigationState) => void,
) {
  const handlePopState = () => {
    const navigation = pathToNavigation(target.location.pathname);
    updateBrowserNavigation(target, navigation, 'replace');
    onNavigation(navigation);
  };

  target.addEventListener('popstate', handlePopState);
  return () => target.removeEventListener('popstate', handlePopState);
}

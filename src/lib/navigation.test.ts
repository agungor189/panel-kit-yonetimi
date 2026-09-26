import assert from 'node:assert/strict';
import test from 'node:test';
import {
  listenToBrowserNavigation,
  navigationToPath,
  pathToNavigation,
  type BrowserNavigationTarget,
} from './navigation.js';

test('maps top-level paths to views', () => {
  const routes = [
    ['/', 'dashboard'],
    ['/products', 'products'],
    ['/sales', 'sales'],
    ['/b2b', 'b2b'],
    ['/cash', 'cash'],
    ['/income', 'income'],
    ['/expenses', 'expense'],
    ['/recurring', 'recurring'],
    ['/analytics', 'analytics'],
    ['/product-analytics', 'product-analytics'],
    ['/insights', 'insights'],
    ['/activity-logs', 'activity-logs'],
    ['/reconciliation', 'reconciliation'],
    ['/settings', 'settings'],
    ['/api-keys', 'api-keys'],
    ['/panel-api', 'panel-api'],
    ['/trendyol', 'trendyol'],
    ['/channels', 'channels'],
  ] as const;

  for (const [path, view] of routes) {
    assert.deepEqual(pathToNavigation(path), { view });
  }
});

test('maps views to top-level paths', () => {
  const routes = [
    ['dashboard', '/'],
    ['products', '/products'],
    ['sales', '/sales'],
    ['b2b', '/b2b'],
    ['cash', '/cash'],
    ['income', '/income'],
    ['expense', '/expenses'],
    ['recurring', '/recurring'],
    ['analytics', '/analytics'],
    ['product-analytics', '/product-analytics'],
    ['insights', '/insights'],
    ['activity-logs', '/activity-logs'],
    ['reconciliation', '/reconciliation'],
    ['settings', '/settings'],
    ['api-keys', '/api-keys'],
    ['panel-api', '/panel-api'],
    ['trendyol', '/trendyol'],
    ['channels', '/channels'],
  ] as const;

  for (const [view, path] of routes) {
    assert.equal(navigationToPath({ view }), path);
  }
});

test('falls back to dashboard for unknown or malformed paths', () => {
  assert.deepEqual(pathToNavigation('/not-a-panel-page'), { view: 'dashboard' });
  assert.deepEqual(pathToNavigation('/products/%E0%A4%A'), { view: 'dashboard' });
});

test('parses and builds dynamic product and B2B paths', () => {
  assert.deepEqual(pathToNavigation('/products/product%201'), {
    view: 'product-detail',
    productId: 'product 1',
  });
  assert.deepEqual(pathToNavigation('/products/new'), { view: 'product-wizard' });
  assert.deepEqual(pathToNavigation('/products/product%201/edit'), {
    view: 'product-wizard',
    productId: 'product 1',
  });
  assert.deepEqual(pathToNavigation('/b2b/firm%201'), { view: 'b2b', firmId: 'firm 1' });
  assert.equal(navigationToPath({ view: 'product-detail', productId: 'product 1' }), '/products/product%201');
  assert.equal(navigationToPath({ view: 'product-wizard' }), '/products/new');
  assert.equal(navigationToPath({ view: 'product-wizard', productId: 'product 1' }), '/products/product%201/edit');
  assert.equal(navigationToPath({ view: 'b2b', firmId: 'firm 1' }), '/b2b/firm%201');
});

test('popstate reads the current path and normalizes unknown paths', () => {
  let pathname = '/expenses';
  let listener: (() => void) | undefined;
  const replacements: string[] = [];
  const navigations: ReturnType<typeof pathToNavigation>[] = [];
  const target: BrowserNavigationTarget = {
    location: { get pathname() { return pathname; } },
    history: {
      pushState: () => undefined,
      replaceState: (_data, _unused, url) => {
        pathname = String(url);
        replacements.push(pathname);
      },
    },
    addEventListener: (_type, nextListener) => { listener = nextListener; },
    removeEventListener: () => undefined,
  };

  listenToBrowserNavigation(target, (navigation) => navigations.push(navigation));

  listener?.();
  pathname = '/recurring';
  listener?.();
  pathname = '/unknown';
  listener?.();

  assert.deepEqual(navigations, [
    { view: 'expense' },
    { view: 'recurring' },
    { view: 'dashboard' },
  ]);
  assert.deepEqual(replacements, ['/']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Briefcase, LayoutDashboard, Settings } from 'lucide-react';
import { AppShell } from './AppShell';
import { isNavItemActive, type NavItemDefinition } from './NavItem';
import { getVisibleSidebarItems, isSidebarExpanded } from './Sidebar';

const primaryItems: NavItemDefinition[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'b2b', label: 'B2B', icon: Briefcase },
];

test('sidebar keeps product detail and wizard under the active Products item', () => {
  assert.equal(isNavItemActive('products', 'products'), true);
  assert.equal(isNavItemActive('product-detail', 'products'), true);
  assert.equal(isNavItemActive('product-wizard', 'products'), true);
  assert.equal(isNavItemActive('sales', 'products'), false);
});

test('sidebar expansion follows desktop and mobile open state', () => {
  assert.equal(isSidebarExpanded(false, false), false);
  assert.equal(isSidebarExpanded(true, false), true);
  assert.equal(isSidebarExpanded(false, true), true);
});

test('readonly navigation excludes B2B while regular users retain it', () => {
  assert.deepEqual(getVisibleSidebarItems(primaryItems, true).map(item => item.id), ['dashboard']);
  assert.deepEqual(getVisibleSidebarItems(primaryItems, false).map(item => item.id), ['dashboard', 'b2b']);
});

test('application shell renders content and readonly visibility without integration links', () => {
  const markup = renderToStaticMarkup(
    <AppShell
      appVersion="test"
      currentView="dashboard"
      currentViewLabel="Dashboard"
      userRole="readonly"
      isReadOnly
      isSidebarOpen
      isMobileMenuOpen={false}
      showLogoutConfirm={false}
      primaryNavItems={primaryItems}
      financeNavItems={[]}
      analyticsNavItems={[]}
      integrationNavItems={[{ id: 'api-keys', label: 'API Anahtarları', icon: Settings }]}
      systemNavItems={[{ id: 'settings', label: 'Ayarlar', icon: Settings }]}
      viewCurrency="TRY"
      activeRate={42}
      rateSource="test"
      rateFetchedAt={null}
      isRateLoading={false}
      isRateError={false}
      onSelectView={() => undefined}
      onToggleSidebar={() => undefined}
      onOpenMobileMenu={() => undefined}
      onCloseMobileMenu={() => undefined}
      onCurrencyChange={() => undefined}
      onRefreshRate={() => undefined}
      onLogout={() => undefined}
      onConfirmLogout={() => undefined}
      onCancelLogout={() => undefined}
    >
      <div>Shell content</div>
    </AppShell>,
  );

  assert.match(markup, /Shell content/);
  assert.match(markup, /Salt okunur moddasınız/);
  assert.doesNotMatch(markup, />B2B</);
  assert.doesNotMatch(markup, /API Anahtarları/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthContext } from '../App';
import Expenses from './Expenses';
import FinanceModule from './FinanceModule';
import Transactions from './Transactions';

function renderWithRole(component: React.ReactNode, role: 'admin' | 'readonly' = 'admin') {
  return renderToStaticMarkup(
    <AuthContext.Provider value={{ role, isReadOnly: role === 'readonly', permissions: {} }}>
      {component}
    </AuthContext.Provider>,
  );
}

test('finance screens render their shared page shells', () => {
  assert.match(renderWithRole(<Expenses />), /Gider Yönetimi/);
  assert.match(renderWithRole(<Transactions />), /Gelir Raporu/);
  assert.match(renderWithRole(<FinanceModule />), /Finans Merkezi/);
});

test('finance write actions remain hidden for readonly users', () => {
  const expenses = renderWithRole(<Expenses />, 'readonly');
  const finance = renderWithRole(<FinanceModule />, 'readonly');

  assert.doesNotMatch(expenses, /Yeni Gider Ekle/);
  assert.doesNotMatch(finance, /Gelişmiş Gider Ekle/);
  assert.doesNotMatch(finance, /Transfer \/ Ödeme/);
});

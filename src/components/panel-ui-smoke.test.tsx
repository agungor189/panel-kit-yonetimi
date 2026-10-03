import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthContext } from '../App';
import ProductList from './ProductList';
import Sales from './sales/Sales';
import { ConfirmDialog, Modal } from './ui';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

function renderWithRole(component: React.ReactNode, role: 'admin' | 'readonly' = 'admin') {
  return renderToStaticMarkup(
    <AuthContext.Provider value={{ role, isReadOnly: role === 'readonly', permissions: {} }}>
      {component}
    </AuthContext.Provider>,
  );
}

test('product and sales screens render through their shared shells', () => {
  const productMarkup = renderWithRole(<ProductList onAddProduct={() => undefined} onProductClick={() => undefined} />);
  const salesMarkup = renderWithRole(<Sales />);

  assert.match(productMarkup, /Ürün Yönetimi/);
  assert.doesNotMatch(productMarkup, /Yeni Ürün Ekle|Gelişmiş İçe Aktar|Tümünü Sil/);
  assert.match(salesMarkup, /Sipariş Yönetimi/);
  assert.match(salesMarkup, /Yeni Satış Ekle/);
});

test('product and sales write actions remain hidden for readonly users', () => {
  const productMarkup = renderWithRole(<ProductList onAddProduct={() => undefined} onProductClick={() => undefined} />, 'readonly');
  const salesMarkup = renderWithRole(<Sales />, 'readonly');

  assert.doesNotMatch(productMarkup, /Yeni Ürün Ekle/);
  assert.doesNotMatch(salesMarkup, /Yeni Satış Ekle/);
});

test('shared modal and confirmation dialog render only while open', () => {
  const closedModal = renderToStaticMarkup(<Modal open={false} onClose={() => undefined}>İçerik</Modal>);
  const openModal = renderToStaticMarkup(<Modal open onClose={() => undefined} title="Düzenle">İçerik</Modal>);
  const closedConfirm = renderToStaticMarkup(<ConfirmDialog open={false} onClose={() => undefined} onConfirm={() => undefined} title="Sil" />);
  const openConfirm = renderToStaticMarkup(<ConfirmDialog open onClose={() => undefined} onConfirm={() => undefined} title="Sil" destructive />);

  assert.equal(closedModal, '');
  assert.match(openModal, /role="dialog"/);
  assert.match(openModal, /Düzenle/);
  assert.equal(closedConfirm, '');
  assert.match(openConfirm, /Sil/);
  assert.match(openConfirm, /Onayla/);
});

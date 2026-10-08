import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProcurementImport } from './ProcurementImport.js';

test('CSV import asks for no tax, costing or prior-stock decision', () => {
  const html = renderToStaticMarkup(createElement(ProcurementImport, { csv: 'fixture', supplierId: 'supplier', onCreated: () => {} }));
  assert.match(html, /CSV Önizle/);
  for (const field of ['Fatura vergisi', 'Vergi oranı', 'Stok maliyetinde vergi politikası', 'Bu partinin daha önce kabul edilmediğine ilişkin kanıt']) {
    assert.doesNotMatch(html, new RegExp(field));
  }
});

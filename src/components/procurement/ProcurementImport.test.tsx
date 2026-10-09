import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftCostsPanel, parseVatRate } from './DraftCostsPanel.js';
import { ProcurementImport } from './ProcurementImport.js';

test('CSV import asks for no tax, costing or prior-stock decision', () => {
  const html = renderToStaticMarkup(createElement(ProcurementImport, { csv: 'fixture', supplierId: 'supplier', onCreated: () => {} }));
  assert.match(html, /CSV Önizle/);
  for (const field of ['Fatura vergisi', 'Vergi oranı', 'Stok maliyetinde vergi politikası', 'Bu partinin daha önce kabul edilmediğine ilişkin kanıt']) {
    assert.doesNotMatch(html, new RegExp(field));
  }
});


test('VAT purchase cost UI defaults to an editable percent input and separates net tax and gross',()=>{
  const html=renderToStaticMarkup(createElement(DraftCostsPanel,{onChanged:()=>{},draft:{id:'draft',draftCosts:[{id:'cost',title:'Navlun',amountMinor:120000,netMinor:100000,vatMode:'INCLUDED',currency:'TRY',
      description:null,version:1,vatRateBps:2000,vatMinor:20000,grossMinor:120000,estimateUsdMinor:3000}]}}));
  assert.match(html,/<input[^>]*type="number"[^>]*aria-label="Maliyet KDV oranı"[^>]*value="20"|<input[^>]*aria-label="Maliyet KDV oranı"[^>]*type="number"[^>]*value="20"/);
  assert.match(html,/KDV dahil toplam tutar/);assert.doesNotMatch(html,/KDV hariç tutar/);
  assert.match(html,/Ana tutar/);assert.match(html,/KDV %20/);assert.match(html,/Genel toplam/);
  assert.doesNotMatch(html,/<select[^>]*aria-label="Maliyet KDV oranı"/);
  assert.equal(parseVatRate('17.35'),1735);assert.equal(parseVatRate('17,35'),1735);assert.equal(parseVatRate('0'),0);
  assert.throws(()=>parseVatRate('17.351'),/ondalık/);assert.throws(()=>parseVatRate('101'),/%0–100/);
});

test('draft cost entry has no technical finalization form, calculate button or separate price table',()=>{
  const html=renderToStaticMarkup(createElement(DraftCostsPanel,{onChanged:()=>{},draft:{id:'draft',draftCosts:[]}}));
  assert.match(html,/Maliyet Ekle/);
  assert.match(html,/Landed Cost Önizle/);
  assert.match(html,/aria-label="USD olarak gir"/);
  assert.match(html,/aria-label="TRY olarak gir"/);
  for (const field of ['Kime ödenecek','Maliyet muhatabı','Tedarikçi','Üçüncü taraf','Kesinleştirme','FINAL Kontrollerini Aç','Fatura vergisi','Vergi oranı','Stok maliyeti vergi politikası','Fiyata dahil içerik','Önceki stok kontrolü kanıtı','FINAL LC Önizlemesini Hesapla','Salt Okunur FINAL LC Önizlemesi','<table'])
    assert.doesNotMatch(html,new RegExp(field));
});

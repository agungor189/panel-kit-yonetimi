type Any = any;
const n = (value: unknown) => Math.max(0, Number(value) || 0);
const int = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0));

const normalized = (value: unknown) => String(value || '').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9çğıöşü]/g, '');
const dimension = (value: unknown) => {
  const match = String(value || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
  return match ? `${Number(match[1])}x${Number(match[2])}` : '';
};
const roundDiameterMm = (value: unknown) => {
  const raw = String(value || '').toLocaleLowerCase('tr-TR').replace(',', '.');
  const inch = raw.match(/(3\/4|1\.5|1,5|1|2)\s*(?:inç|inch|in|″|")/);
  if (inch) {
    const key = inch[1].replace(',', '.');
    return ({ '3/4': 26.9, '1': 33.7, '1.5': 48.3, '2': 60.3 } as Record<string, number>)[key] || 0;
  }
  const mm = raw.match(/(\d+(?:\.\d+)?)\s*mm/);
  return mm ? Number(mm[1]) : 0;
};
const shape = (value: unknown) => {
  const text = normalized(value);
  if (text.includes('kare') || text.includes('square')) return 'kare';
  if (text.includes('yuvarlak') || text.includes('round') || text.includes('boru')) return 'yuvarlak';
  if (text.includes('dikdortgen') || text.includes('rect')) return 'dikdortgen';
  return '';
};

export function compatibilityFor(profile: Any, item: Any) {
  if (!profile || !item) return { status: 'şüpheli', label: 'Profil seçilmedi', reason: 'Profil seçilmeden uyumluluk doğrulanamaz.' };
  const profileDimension = dimension(profile.dimension);
  const itemDimension = dimension(item.size || item.normalized_size || item.pipe_size || item.title || item.name);
  const profileDiameter = roundDiameterMm(profile.dimension || profile.name);
  const itemDiameter = roundDiameterMm(item.size || item.normalized_size || item.pipe_size || item.title || item.name);
  const profileShape = shape(`${profile.shape} ${profile.name}`);
  const itemShape = shape(`${item.form_code} ${item.normalized_tube_type} ${item.tube_type_code} ${item.title} ${item.name}`);
  if (profileDimension && itemDimension && profileDimension !== itemDimension) return { status: 'uyumsuz', label: 'Uyumsuz', reason: `Ölçü uyuşmuyor: profil ${profile.dimension}, bağlantı elemanı ${item.size || item.normalized_size || itemDimension}.` };
  if (profileDiameter && itemDiameter && Math.abs(profileDiameter - itemDiameter) > 0.6) return { status: 'uyumsuz', label: 'Uyumsuz', reason: `Yuvarlak dış çap uyuşmuyor: profil ${profileDiameter} mm, bağlantı elemanı ${itemDiameter} mm.` };
  if (profileShape && itemShape && profileShape !== itemShape) return { status: 'uyumsuz', label: 'Uyumsuz', reason: `Form uyuşmuyor: profil ${profile.shape || profileShape}, bağlantı elemanı ${item.form_code || item.normalized_tube_type || itemShape}.` };
  if (profileDimension && itemDimension || profileDiameter && itemDiameter || profileShape && itemShape) return { status: 'uyumlu', label: 'Uyumlu', reason: 'Profil ve bağlantı elemanının ölçü/form bilgisi eşleşiyor.' };
  return { status: 'şüpheli', label: 'Şüpheli', reason: 'Ürün kartında ölçü veya form bilgisi eksik; manuel doğrulama gerekli.' };
}

function optimizeCuts(lines: Any[], stockLength: number, kerf: number) {
  const pieces = (lines || []).flatMap((cut: Any) => Array.from({ length: int(cut.quantity) }, () => n(cut.length_mm))).filter(Boolean).sort((a: number, b: number) => b - a);
  const invalid = pieces.filter(piece => piece > stockLength);
  const makePlan = (source: number[]) => {
    const bars: { remaining: number; cuts: number[] }[] = [];
    for (const piece of source) {
      let target = bars.find(bar => bar.remaining >= piece + (bar.cuts.length ? kerf : 0));
      if (!target) { target = { remaining: stockLength, cuts: [] }; bars.push(target); }
      const needed = piece + (target.cuts.length ? kerf : 0);
      target.remaining -= needed;
      target.cuts.push(piece);
    }
    return bars;
  };
  const bars = invalid.length ? [] : makePlan(pieces);
  const usedMm = pieces.reduce((sum: number, piece: number) => sum + piece, 0);
  const purchasedMm = bars.length * stockLength;
  const kerfLossMm = bars.reduce((sum, bar) => sum + Math.max(0, bar.cuts.length - 1) * kerf, 0);
  return { bars, usedMm, purchasedMm, kerfLossMm, remnantMm: Math.max(0, purchasedMm - usedMm - kerfLossMm), invalid };
}

export function draftKitAnalysis(data: Any, profile: Any, products: Any[], complementary: Any[]) {
  const components = (data.items || []).map((line: Any) => ({ ...products.find(product => product.id === line.product_id), ...line }));
  const extraItems = (data.complementary_items || []).map((line: Any) => ({ ...complementary.find(product => product.id === line.complementary_product_id), ...line }));
  const offer = profile?.offers?.find((item: Any) => item.id === data.profile_offer_id) || profile?.offers?.find((item: Any) => item.is_preferred);
  const profileMeterCost = n(offer?.price_per_meter ?? profile?.price_per_meter);
  const partsCost = components.reduce((sum: number, item: Any) => sum + n(item.quantity) * n(item.purchase_cost), 0);
  const partsSale = components.reduce((sum: number, item: Any) => sum + n(item.quantity) * n(item.sale_price), 0);
  const complementaryCost = extraItems.reduce((sum: number, item: Any) => sum + n(item.quantity) * n(item.purchase_price_snapshot ?? item.purchase_price), 0);
  const cutPlan = optimizeCuts(data.cuts || [], n(profile?.stock_length_mm) || 6000, 3);
  const profileMeters = cutPlan.usedMm / 1000;
  const purchasedProfileMeters = cutPlan.purchasedMm / 1000;
  const profileCost = purchasedProfileMeters * profileMeterCost;
  const productionCost = profileCost + n(data.cutting_cost) + n(data.labour_cost) + n(data.packaging_cost) + n(data.other_cost);
  const commercialFixed = n(data.payment_cost) + n(data.shipping_cost);
  const target = n(data.target_margin);
  const commissionRate = Math.min(0.99, n(data.commission_rate) / 100);
  const fixedCustomerSale = partsSale + complementaryCost;
  const suggestedProfileSale = (productionCost * (1 + target / 100) + commercialFixed + fixedCustomerSale * commissionRate) / Math.max(.01, 1 - commissionRate);
  const profileSale = n(data.sale_price) || suggestedProfileSale;
  const salePrice = partsSale + complementaryCost + profileSale;
  const commission = salePrice * commissionRate;
  const materialCost = partsCost + profileCost + complementaryCost;
  const totalCost = materialCost + n(data.cutting_cost) + n(data.labour_cost) + n(data.packaging_cost) + n(data.other_cost) + commission + commercialFixed;
  const profit = salePrice - totalCost;
  const suggestion = (margin: number) => partsSale + complementaryCost + ((productionCost * (1 + margin / 100) + commercialFixed + fixedCustomerSale * commissionRate) / Math.max(.01, 1 - commissionRate));
  return { partsCost, partsSale, complementaryCost, profileMeters, purchasedProfileMeters, profileBars: cutPlan.bars.length, profileCost, materialCost, productionCost, commission, commercialFixed, totalCost, salePrice, profit, netMargin: salePrice ? profit / salePrice * 100 : 0, markup: totalCost ? profit / totalCost * 100 : 0, cuttingPlan: cutPlan, suggestions: [20, 30, 50].map(margin => ({ margin, salePrice: suggestion(margin) })), compatibility: components.map(item => ({ product_id: item.product_id, ...compatibilityFor(profile, item) })) };
}

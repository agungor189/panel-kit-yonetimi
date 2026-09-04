import express from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

const num = (v: unknown) => Math.max(0, Number(v) || 0);
const optionalNum = (v: unknown, fallback: number) => (v === undefined || v === null || v === '') ? fallback : num(v);
const isPositiveInteger = (v: unknown) => Number.isInteger(Number(v)) && Number(v) > 0;

function optimizeCutPlan(cuts: number[], stockLength: number, kerf: number) {
  const invalid = cuts.filter(piece => piece <= 0 || piece > stockLength);
  if (invalid.length) throw new Error(`Ham boydan uzun veya geçersiz kesim var: ${invalid.join(', ')} mm`);
  const pieces = [...cuts].sort((a, b) => b - a);
  const makePlan = (source: number[]) => {
    const bars: { remaining: number; cuts: number[] }[] = [];
    for (const piece of source) {
      let target = bars.find(b => b.remaining >= piece + (b.cuts.length ? kerf : 0));
      if (!target) { target = { remaining: stockLength, cuts: [] }; bars.push(target); }
      const needed = piece + (target.cuts.length ? kerf : 0);
      target.remaining -= needed;
      target.cuts.push(piece);
    }
    return bars;
  };
  let best = makePlan(pieces);
  if (pieces.length <= 18) {
    const limit = best.length;
    for (let target = 1; target < limit; target++) {
      const trial = Array.from({ length: target }, () => ({ remaining: stockLength, cuts: [] as number[] }));
      const pack = (index: number): boolean => {
        if (index === pieces.length) { best = trial.map(b => ({ remaining: b.remaining, cuts: [...b.cuts] })); return true; }
        const piece = pieces[index];
        const tried = new Set<number>();
        for (const bar of trial) {
          if (tried.has(Math.round(bar.remaining))) continue;
          tried.add(Math.round(bar.remaining));
          const needed = piece + (bar.cuts.length ? kerf : 0);
          if (bar.remaining < needed) continue;
          bar.remaining -= needed; bar.cuts.push(piece);
          if (pack(index + 1)) return true;
          bar.cuts.pop(); bar.remaining += needed;
        }
        return false;
      };
      if (pack(0)) break;
    }
  }
  const usedMm = pieces.reduce((s, p) => s + p, 0);
  const kerfLossMm = best.reduce((s, b) => s + Math.max(0, b.cuts.length - 1) * kerf, 0);
  const totalMm = best.length * stockLength;
  return { bars: best, usedMm, kerfLossMm, remnantMm: Math.max(0, totalMm - usedMm - kerfLossMm), purchasedMm: totalMm };
}

function cutPlan(cuts: number[], stockLength: number, kerf: number) {
  return optimizeCutPlan(cuts, stockLength, kerf).bars;
}

function expandCuts(cuts: any[]) {
  const pieces: number[] = [];
  for (const cut of cuts || []) for (let i = 0; i < num(cut.quantity); i++) pieces.push(num(cut.length_mm));
  return pieces;
}

export function createKitRouter(db: Database.Database) {
  const router = express.Router();
  const profile = (id: string) => db.prepare('SELECT * FROM kit_profiles WHERE id=?').get(id) as any;
  // Mirrors the essential BOM availability rule without making kits part of product_bom.
  // A kit can consume either a stocked component or an existing assembled product.
  const productAvailability = (productId: string, seen = new Set<string>()): number => {
    if (seen.has(productId)) return 0;
    seen.add(productId);
    const row = db.prepare('SELECT central_stock FROM products WHERE id=?').get(productId) as any;
    if (!row) return 0;
    const bom = db.prepare('SELECT component_product_id, quantity_per_unit FROM product_bom WHERE parent_product_id=?').all(productId) as any[];
    if (!bom.length) return num(row.central_stock);
    const buildable = Math.min(...bom.map(part => Math.floor(productAvailability(part.component_product_id, new Set(seen)) / Math.max(0.0001, num(part.quantity_per_unit)))));
    return num(row.central_stock) + buildable;
  };
  const kitDetail = (id: string) => {
    const kit = db.prepare(`SELECT k.*, p.name profile_name, p.shape, p.dimension, p.material profile_material, p.thickness, p.color profile_color, p.finish profile_finish, p.grade profile_grade, p.supplier, p.price_per_meter,
      COALESCE(o.price_per_meter, p.price_per_meter) effective_price_per_meter, o.supplier offer_supplier, o.currency offer_currency, p.stock_length_mm
      FROM kits k JOIN kit_profiles p ON p.id=k.profile_id LEFT JOIN kit_profile_offers o ON o.id=k.profile_offer_id WHERE k.id=?`).get(id) as any;
    if (!kit) return null;
    kit.items = db.prepare(`SELECT ki.*, p.title, p.name, p.sku, p.purchase_cost, p.central_stock, p.weight,
      p.sale_price, CAST(CASE WHEN ki.quantity > 0 THEN FLOOR(COALESCE(p.central_stock,0)/ki.quantity) ELSE 0 END AS INTEGER) available_units
      FROM kit_items ki JOIN products p ON p.id=ki.product_id WHERE ki.kit_id=? ORDER BY p.title`).all(id);
    kit.cuts = db.prepare('SELECT * FROM kit_cuts WHERE kit_id=? ORDER BY length_mm DESC').all(id);
    kit.complementary_items = db.prepare(`SELECT * FROM kit_complementary_items WHERE kit_id=? ORDER BY product_name_snapshot`).all(id) as any[];
    kit.items = kit.items.map((item: any) => ({ ...item, available_units: Math.floor(productAvailability(item.product_id) / Math.max(0.0001, num(item.quantity))) }));
    const availability = (kit.items as any[]).length ? Math.min(...kit.items.map((i: any) => num(i.available_units))) : 0;
    // Connection pieces always use the live product card prices. Kit pricing never
    // marks these up; the configurable margin belongs only to the profile work.
    const partsCost = kit.items.reduce((s: number, i: any) => s + num(i.quantity) * num(i.purchase_cost), 0);
    const partsSale = kit.items.reduce((s: number, i: any) => s + num(i.quantity) * num(i.sale_price), 0);
    const stockLengthMm = num(kit.stock_length_mm) || 6000;
    const cutting = optimizeCutPlan(expandCuts(kit.cuts), stockLengthMm, 3);
    const profileMeters = cutting.usedMm / 1000;
    const purchasedProfileMeters = cutting.purchasedMm / 1000;
    const profileCost = purchasedProfileMeters * num(kit.effective_price_per_meter);
    const complementaryCost = kit.complementary_items.reduce((sum: number, item: any) => sum + num(item.quantity) * num(item.purchase_price_snapshot), 0);
    const complementaryWeightKg = kit.complementary_items.reduce((sum: number, item: any) => sum + num(item.quantity) * num(item.unit_weight_kg_snapshot), 0);
    const connectionWeightKg = kit.items.reduce((sum: number, item: any) => sum + num(item.quantity) * num(item.weight) / 1000, 0);
    const profileWeightKg = profileMeters * num(kit.weight_per_meter);
    const profileBaseCost = profileCost + num(kit.cutting_cost) + num(kit.labour_cost) + num(kit.packaging_cost) + num(kit.other_cost);
    const commercialFixed = num(kit.payment_cost) + num(kit.shipping_cost);
    // “Hedef kâr” is a markup on the profile work cost, not a gross-margin
    // denominator. At 100% the profile sale becomes 2× its profile cost;
    // commission is then grossed up separately when applicable.
    const commissionRate = num(kit.commission_rate) / 100;
    const fixedCustomerSale = partsSale + complementaryCost;
    const suggestedProfileSale = (profileBaseCost * (1 + num(kit.target_margin) / 100) + commercialFixed + fixedCustomerSale * commissionRate) /
      Math.max(0.01, 1 - commissionRate);
    const profileSale = num(kit.sale_price) || suggestedProfileSale;
    // Complements have no customer-facing price card. Their current procurement
    // cost is carried into the kit offer at cost; only the profile work receives
    // the configurable target-profit uplift. Connection products keep their
    // own live sales prices from the main product catalog.
    const complementarySale = complementaryCost;
    const salePrice = partsSale + complementarySale + profileSale;
    const commission = salePrice * commissionRate;
    const baseCost = partsCost + complementaryCost + profileBaseCost + commission + commercialFixed;
    const vatRate = num(kit.vat_rate) / 100;
    const vat = vatRate ? salePrice - (salePrice / (1 + vatRate)) : 0;
    const netProfit = salePrice - baseCost;
    kit.analysis = { availability, partsCost, partsSale, profileMeters, purchasedProfileMeters, profileBars: cutting.bars.length, profileCost, profileBaseCost, profileSale, baseCost, suggestedPrice: suggestedProfileSale, suggestedProfileSale, salePrice, commission, vat, netProfit, margin: salePrice ? (netProfit / salePrice) * 100 : 0,
      complementaryCost, weightBreakdown: { connectionWeightKg, profileWeightKg, complementaryWeightKg, totalWeightKg: connectionWeightKg + profileWeightKg + complementaryWeightKg },
      cuttingPlan: { stockLengthMm, bars: cutting.bars.map((bar, index) => ({ number: index + 1, cuts: bar.cuts, remaining_mm: bar.remaining })), usedMm: cutting.usedMm, purchasedMm: cutting.purchasedMm, kerfLossMm: cutting.kerfLossMm, remnantMm: cutting.remnantMm, efficiency: cutting.purchasedMm ? (cutting.usedMm / cutting.purchasedMm) * 100 : 0 },
      markup: baseCost ? (netProfit / baseCost) * 100 : 0,
      breakdown: { partsCost, partsSale, profileMaterial: profileCost, profileUsedMeters: profileMeters, profilePurchasedMeters: purchasedProfileMeters, profileBars: cutting.bars.length, kerfLoss: cutting.kerfLossMm, remnant: cutting.remnantMm, complementaryCost, complementarySale, cutting: num(kit.cutting_cost), labour: num(kit.labour_cost), packaging: num(kit.packaging_cost), other: num(kit.other_cost), commission, payment: num(kit.payment_cost), shipping: num(kit.shipping_cost), commercialFixed, vat, profileBaseCost, profileSale, baseCost, salePrice, netProfit } };
    return kit;
  };

  router.get('/profiles', (_req, res) => {
    const profiles = db.prepare('SELECT * FROM kit_profiles ORDER BY is_active DESC, name').all() as any[];
    const offers = db.prepare('SELECT * FROM kit_profile_offers ORDER BY is_preferred DESC, price_per_meter').all() as any[];
    res.json(profiles.map(p => ({ ...p, offers: offers.filter(o => o.profile_id === p.id) })));
  });
  router.post('/profiles', (req, res) => {
    const body = req.body || {}; const id = uuidv4();
    db.prepare(`INSERT INTO kit_profiles (id,name,shape,dimension,material,thickness,supplier,price_per_meter,color,finish,grade,weight_per_meter,stock_length_mm,is_active,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.name, body.shape, body.dimension, body.material, body.thickness, body.supplier, num(body.price_per_meter), body.color, body.finish, body.grade, num(body.weight_per_meter), num(body.stock_length_mm) || 6000, body.is_active === false ? 0 : 1, body.notes);
    res.json(profile(id));
  });
  router.put('/profiles/:id', (req, res) => {
    const b = req.body || {};
    db.prepare(`UPDATE kit_profiles SET name=?,shape=?,dimension=?,material=?,thickness=?,supplier=?,price_per_meter=?,color=?,finish=?,grade=?,weight_per_meter=?,stock_length_mm=?,is_active=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.name,b.shape,b.dimension,b.material,b.thickness,b.supplier,num(b.price_per_meter),b.color,b.finish,b.grade,num(b.weight_per_meter),num(b.stock_length_mm)||6000,b.is_active === false ? 0 : 1,b.notes,req.params.id);
    res.json(profile(req.params.id));
  });
  router.post('/profiles/:id/offers', (req, res) => {
    const b=req.body||{}; const id=uuidv4();
    if (b.is_preferred) db.prepare('UPDATE kit_profile_offers SET is_preferred=0 WHERE profile_id=?').run(req.params.id);
    db.prepare(`INSERT INTO kit_profile_offers (id,profile_id,supplier,price_per_meter,currency,lead_time_days,supplier_sku,notes,is_preferred) VALUES (?,?,?,?,?,?,?,?,?)`).run(id,req.params.id,b.supplier,num(b.price_per_meter),b.currency||'TRY',num(b.lead_time_days),b.supplier_sku,b.notes,b.is_preferred?1:0);
    res.json({id});
  });
  router.delete('/profiles/:profileId/offers/:offerId', (req,res) => { db.prepare('DELETE FROM kit_profile_offers WHERE id=? AND profile_id=?').run(req.params.offerId,req.params.profileId); res.json({success:true}); });

  router.get('/complementary-products', (_req, res) => {
    const rows = db.prepare('SELECT * FROM complementary_products ORDER BY is_active DESC, name').all() as any[];
    const images = db.prepare('SELECT * FROM complementary_product_images ORDER BY sort_order ASC, created_at ASC').all() as any[];
    const byProduct = new Map<string, any[]>();
    for (const image of images) {
      const list = byProduct.get(image.complementary_product_id) || [];
      list.push(image);
      byProduct.set(image.complementary_product_id, list);
    }
    res.json(rows.map(row => ({ ...row, images: byProduct.get(row.id) || (row.cover_image ? [{ id: 'cover', path: row.cover_image, sort_order: 0 }] : []) })));
  });
  router.post('/complementary-products', (req, res) => {
    const b=req.body||{}; const id=uuidv4();
    db.prepare(`INSERT INTO complementary_products (id,name,category,description,supplier,supplier_reference,brand,size,notes,unit,purchase_price,unit_weight_kg,is_active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,b.name,b.category,b.description,b.supplier,b.supplier_reference,b.brand,b.size,b.notes,b.unit||'adet',num(b.purchase_price),num(b.unit_weight_kg),b.is_active===false?0:1);
    res.json({ ...(db.prepare('SELECT * FROM complementary_products WHERE id=?').get(id) as any), images: [] });
  });
  router.put('/complementary-products/:id', (req,res) => { const b=req.body||{}; db.prepare(`UPDATE complementary_products SET name=?,category=?,description=?,supplier=?,supplier_reference=?,brand=?,size=?,notes=?,unit=?,purchase_price=?,unit_weight_kg=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(b.name,b.category,b.description,b.supplier,b.supplier_reference,b.brand,b.size,b.notes,b.unit||'adet',num(b.purchase_price),num(b.unit_weight_kg),b.is_active===false?0:1,req.params.id); const row = db.prepare('SELECT * FROM complementary_products WHERE id=?').get(req.params.id) as any; const images = db.prepare('SELECT * FROM complementary_product_images WHERE complementary_product_id=? ORDER BY sort_order ASC, created_at ASC').all(req.params.id); res.json({ ...row, images }); });
  router.delete('/complementary-products/:id', (req,res) => { try { db.prepare('DELETE FROM complementary_products WHERE id=?').run(req.params.id); res.json({success:true}); } catch { res.status(409).json({error:'Bu tamamlayıcı ürün mevcut bir kitte kullanıldığı için silinemez.'}); } });

  router.get('/', (_req, res) => {
    const kits = (db.prepare('SELECT id FROM kits ORDER BY updated_at DESC').all() as any[]).map(row => kitDetail(row.id));
    res.json(kits);
  });
  router.get('/:id', (req, res) => { const kit = kitDetail(req.params.id); kit ? res.json(kit) : res.status(404).json({ error: 'Kit bulunamadı' }); });
  const saveKit = (id: string, b: any, update = false) => db.transaction(() => {
    const selectedProfile = profile(b.profile_id);
    if (!selectedProfile) throw new Error('Geçerli bir profil seçin.');
    if (num(b.commission_rate) >= 100) throw new Error('Komisyon oranı %100 veya üzeri olamaz.');
    if (b.profile_offer_id) {
      const offer = db.prepare('SELECT profile_id, currency FROM kit_profile_offers WHERE id=?').get(b.profile_offer_id) as any;
      if (!offer || offer.profile_id !== b.profile_id) throw new Error('Seçilen tedarikçi teklifi bu profile ait değil.');
      if (String(offer.currency || 'TRY').toUpperCase() !== 'TRY') throw new Error('Profil tekliflerinde şimdilik yalnız TRY desteklenir.');
    }
    const stockLength = num(selectedProfile.stock_length_mm) || 6000;
    for (const item of Array.isArray(b.items) ? b.items : []) {
      if (item.product_id && !isPositiveInteger(item.quantity)) throw new Error('Bağlantı elemanı adedi pozitif tam sayı olmalı.');
    }
    for (const cut of Array.isArray(b.cuts) ? b.cuts : []) {
      if (!isPositiveInteger(cut.quantity)) throw new Error('Kesim adedi pozitif tam sayı olmalı.');
      if (num(cut.length_mm) > stockLength) throw new Error(`Kesim boyu ham profilden uzun olamaz: ${num(cut.length_mm)} mm > ${stockLength} mm`);
    }
    optimizeCutPlan(expandCuts(b.cuts || []), stockLength, 3);
    const complementary = db.prepare('SELECT * FROM complementary_products WHERE id=?');
    for (const line of Array.isArray(b.complementary_items) ? b.complementary_items : []) {
      const product = complementary.get(line.complementary_product_id) as any;
      if (product?.unit === 'adet' && !isPositiveInteger(line.quantity)) throw new Error('Adet bazlı tamamlayıcı ürün miktarı pozitif tam sayı olmalı.');
    }
    if (update) db.prepare(`UPDATE kits SET name=?,code=?,description=?,profile_id=?,profile_offer_id=?,status=?,cover_image=?,notes=?,target_margin=?,sale_price=?,cutting_cost=?,labour_cost=?,packaging_cost=?,other_cost=?,commission_rate=?,payment_cost=?,shipping_cost=?,vat_rate=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.name,b.code||null,b.description,b.profile_id,b.profile_offer_id||null,b.status||'active',b.cover_image,b.notes,num(b.target_margin),num(b.sale_price),num(b.cutting_cost),num(b.labour_cost),num(b.packaging_cost),num(b.other_cost),num(b.commission_rate),num(b.payment_cost),num(b.shipping_cost),optionalNum(b.vat_rate,20),id);
    else db.prepare(`INSERT INTO kits (id,name,code,description,profile_id,profile_offer_id,status,cover_image,notes,target_margin,sale_price,cutting_cost,labour_cost,packaging_cost,other_cost,commission_rate,payment_cost,shipping_cost,vat_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,b.name,b.code||null,b.description,b.profile_id,b.profile_offer_id||null,b.status||'active',b.cover_image,b.notes,num(b.target_margin),num(b.sale_price),num(b.cutting_cost),num(b.labour_cost),num(b.packaging_cost),num(b.other_cost),num(b.commission_rate),num(b.payment_cost),num(b.shipping_cost),optionalNum(b.vat_rate,20));
    db.prepare('DELETE FROM kit_items WHERE kit_id=?').run(id); db.prepare('DELETE FROM kit_cuts WHERE kit_id=?').run(id);
    db.prepare('DELETE FROM kit_complementary_items WHERE kit_id=?').run(id);
    const itemStmt = db.prepare('INSERT INTO kit_items (id,kit_id,product_id,quantity,unit_cost) VALUES (?,?,?,?,?)');
    for (const item of Array.isArray(b.items) ? b.items : []) if (item.product_id && num(item.quantity)) itemStmt.run(uuidv4(),id,item.product_id,num(item.quantity),num(item.unit_cost));
    const cutStmt = db.prepare('INSERT INTO kit_cuts (id,kit_id,quantity,length_mm,label,notes) VALUES (?,?,?,?,?,?)');
    for (const cut of Array.isArray(b.cuts) ? b.cuts : []) if (num(cut.length_mm) && num(cut.quantity)) cutStmt.run(uuidv4(),id,num(cut.quantity),num(cut.length_mm),cut.label,cut.notes);
    const complementaryStmt = db.prepare(`INSERT INTO kit_complementary_items (id,kit_id,complementary_product_id,quantity,product_name_snapshot,unit_snapshot,purchase_price_snapshot,unit_weight_kg_snapshot,supplier_snapshot) VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const line of Array.isArray(b.complementary_items) ? b.complementary_items : []) {
      const product = complementary.get(line.complementary_product_id) as any;
      if (product && num(line.quantity)) complementaryStmt.run(uuidv4(),id,product.id,num(line.quantity),product.name,product.unit,num(product.purchase_price),num(product.unit_weight_kg),product.supplier);
    }
  });
  router.post('/', (req, res) => { const id=uuidv4(); try { saveKit(id,req.body)(); res.json(kitDetail(id)); } catch(e:any) { res.status(400).json({error:e.message}); } });
  router.put('/:id', (req, res) => { try { saveKit(req.params.id,req.body,true)(); res.json(kitDetail(req.params.id)); } catch(e:any) { res.status(400).json({error:e.message}); } });
  router.delete('/:id', (req,res) => { db.prepare('DELETE FROM kits WHERE id=?').run(req.params.id); res.json({success:true}); });

  router.post('/bulk/analyze', (req, res) => {
    const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
    const kerf = req.body?.use_kerf === false ? 0 : num(req.body?.kerf_mm || 3);
    const selected = selections.map((s:any) => ({ kit: kitDetail(s.kit_id), quantity: Math.max(1, Math.floor(num(s.quantity))) })).filter((s:any) => s.kit);
    const productNeed = new Map<string, { title:string; needed:number; stock:number }>(); const profiles = new Map<string, any>();
    for (const {kit,quantity} of selected) {
      for (const item of kit.items) { const r=productNeed.get(item.product_id)||{title:item.title||item.name,needed:0,stock:productAvailability(item.product_id)}; r.needed += num(item.quantity)*quantity; productNeed.set(item.product_id,r); }
      const r=profiles.get(kit.profile_id)||{ profile:kit, cuts:[] as number[] }; for (const cut of kit.cuts) for(let i=0;i<num(cut.quantity)*quantity;i++) r.cuts.push(num(cut.length_mm)); profiles.set(kit.profile_id,r);
    }
    const stock = [...productNeed.entries()].map(([product_id,r])=>({...r,product_id,shortage:Math.max(0,r.needed-r.stock),sufficient:r.stock>=r.needed}));
    const profilePlans = [...profiles.values()].map(({profile:kit,cuts})=>{ const length=num(kit.stock_length_mm)||6000; const plan=optimizeCutPlan(cuts,length,kerf); return { profile_id:kit.profile_id, profile_name:kit.profile_name, stock_length_mm:length, bars:plan.bars.map((b:any,i:number)=>({number:i+1,cuts:b.cuts,remaining_mm:b.remaining})), bar_count:plan.bars.length, used_mm:plan.usedMm, purchased_mm:plan.purchasedMm, kerf_loss_mm:plan.kerfLossMm, remnant_mm:plan.remnantMm, waste_mm:plan.kerfLossMm, efficiency:plan.purchasedMm?plan.usedMm/plan.purchasedMm*100:0 }; });
    res.json({stock, profilePlans, feasible:stock.every(x=>x.sufficient)});
  });
  return router;
}

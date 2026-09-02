import express from 'express';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

const num = (v: unknown) => Math.max(0, Number(v) || 0);

function cutPlan(cuts: number[], stockLength: number, kerf: number) {
  const pieces = [...cuts].sort((a, b) => b - a);
  const bars: { remaining: number; cuts: number[] }[] = [];
  for (const piece of pieces) {
    let target = bars.find(b => b.remaining >= piece + (b.cuts.length ? kerf : 0));
    if (!target) { target = { remaining: stockLength, cuts: [] }; bars.push(target); }
    const needed = piece + (target.cuts.length ? kerf : 0);
    if (needed > stockLength) continue; // invalid pieces are surfaced separately
    target.remaining -= needed;
    target.cuts.push(piece);
  }
  return bars;
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
    return Math.min(...bom.map(part => Math.floor(productAvailability(part.component_product_id, new Set(seen)) / Math.max(0.0001, num(part.quantity_per_unit)))));
  };
  const kitDetail = (id: string) => {
    const kit = db.prepare(`SELECT k.*, p.name profile_name, p.shape, p.dimension, p.material profile_material, p.thickness, p.color profile_color, p.finish profile_finish, p.grade profile_grade, p.supplier, p.price_per_meter,
      COALESCE(o.price_per_meter, p.price_per_meter) effective_price_per_meter, o.supplier offer_supplier, o.currency offer_currency, p.stock_length_mm
      FROM kits k JOIN kit_profiles p ON p.id=k.profile_id LEFT JOIN kit_profile_offers o ON o.id=k.profile_offer_id WHERE k.id=?`).get(id) as any;
    if (!kit) return null;
    kit.items = db.prepare(`SELECT ki.*, p.title, p.name, p.sku, p.purchase_cost, p.central_stock,
      p.sale_price, CAST(CASE WHEN ki.quantity > 0 THEN FLOOR(COALESCE(p.central_stock,0)/ki.quantity) ELSE 0 END AS INTEGER) available_units
      FROM kit_items ki JOIN products p ON p.id=ki.product_id WHERE ki.kit_id=? ORDER BY p.title`).all(id);
    kit.cuts = db.prepare('SELECT * FROM kit_cuts WHERE kit_id=? ORDER BY length_mm DESC').all(id);
    kit.items = kit.items.map((item: any) => ({ ...item, available_units: Math.floor(productAvailability(item.product_id) / Math.max(0.0001, num(item.quantity))) }));
    const availability = (kit.items as any[]).length ? Math.min(...kit.items.map((i: any) => num(i.available_units))) : 0;
    // Connection pieces always use the live product card prices. Kit pricing never
    // marks these up; the configurable margin belongs only to the profile work.
    const partsCost = kit.items.reduce((s: number, i: any) => s + num(i.quantity) * num(i.purchase_cost), 0);
    const partsSale = kit.items.reduce((s: number, i: any) => s + num(i.quantity) * num(i.sale_price), 0);
    const profileMeters = kit.cuts.reduce((s: number, c: any) => s + num(c.quantity) * num(c.length_mm), 0) / 1000;
    const profileCost = profileMeters * num(kit.effective_price_per_meter);
    const profileBaseCost = profileCost + num(kit.labour_cost) + num(kit.packaging_cost) + num(kit.other_cost);
    const suggestedProfileSale = profileBaseCost / Math.max(0.01, 1 - num(kit.target_margin) / 100 - num(kit.commission_rate) / 100);
    const profileSale = num(kit.sale_price) || suggestedProfileSale;
    const commission = profileSale * num(kit.commission_rate) / 100;
    const salePrice = partsSale + profileSale;
    const baseCost = partsCost + profileBaseCost;
    const vat = salePrice * num(kit.vat_rate) / 100;
    const netProfit = (partsSale - partsCost) + profileSale - profileBaseCost - commission;
    kit.analysis = { availability, partsCost, partsSale, profileMeters, profileCost, profileBaseCost, profileSale, baseCost, suggestedPrice: suggestedProfileSale, suggestedProfileSale, salePrice, commission, vat, netProfit, margin: salePrice ? (netProfit / salePrice) * 100 : 0 };
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

  router.get('/', (_req, res) => {
    const kits = (db.prepare('SELECT id FROM kits ORDER BY updated_at DESC').all() as any[]).map(row => kitDetail(row.id));
    res.json(kits);
  });
  router.get('/:id', (req, res) => { const kit = kitDetail(req.params.id); kit ? res.json(kit) : res.status(404).json({ error: 'Kit bulunamadı' }); });
  const saveKit = (id: string, b: any, update = false) => db.transaction(() => {
    if (update) db.prepare(`UPDATE kits SET name=?,code=?,description=?,profile_id=?,profile_offer_id=?,status=?,cover_image=?,notes=?,target_margin=?,sale_price=?,labour_cost=?,packaging_cost=?,other_cost=?,commission_rate=?,vat_rate=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.name,b.code||null,b.description,b.profile_id,b.profile_offer_id||null,b.status||'active',b.cover_image,b.notes,num(b.target_margin),num(b.sale_price),num(b.labour_cost),num(b.packaging_cost),num(b.other_cost),num(b.commission_rate),num(b.vat_rate)||20,id);
    else db.prepare(`INSERT INTO kits (id,name,code,description,profile_id,profile_offer_id,status,cover_image,notes,target_margin,sale_price,labour_cost,packaging_cost,other_cost,commission_rate,vat_rate) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,b.name,b.code||null,b.description,b.profile_id,b.profile_offer_id||null,b.status||'active',b.cover_image,b.notes,num(b.target_margin),num(b.sale_price),num(b.labour_cost),num(b.packaging_cost),num(b.other_cost),num(b.commission_rate),num(b.vat_rate)||20);
    db.prepare('DELETE FROM kit_items WHERE kit_id=?').run(id); db.prepare('DELETE FROM kit_cuts WHERE kit_id=?').run(id);
    const itemStmt = db.prepare('INSERT INTO kit_items (id,kit_id,product_id,quantity,unit_cost) VALUES (?,?,?,?,?)');
    for (const item of Array.isArray(b.items) ? b.items : []) if (item.product_id && num(item.quantity)) itemStmt.run(uuidv4(),id,item.product_id,num(item.quantity),num(item.unit_cost));
    const cutStmt = db.prepare('INSERT INTO kit_cuts (id,kit_id,quantity,length_mm,label) VALUES (?,?,?,?,?)');
    for (const cut of Array.isArray(b.cuts) ? b.cuts : []) if (num(cut.length_mm) && num(cut.quantity)) cutStmt.run(uuidv4(),id,num(cut.quantity),num(cut.length_mm),cut.label);
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
      for (const item of kit.items) { const r=productNeed.get(item.product_id)||{title:item.title||item.name,needed:0,stock:num(item.central_stock)}; r.needed += num(item.quantity)*quantity; productNeed.set(item.product_id,r); }
      const r=profiles.get(kit.profile_id)||{ profile:kit, cuts:[] as number[] }; for (const cut of kit.cuts) for(let i=0;i<num(cut.quantity)*quantity;i++) r.cuts.push(num(cut.length_mm)); profiles.set(kit.profile_id,r);
    }
    const stock = [...productNeed.entries()].map(([product_id,r])=>({...r,product_id,shortage:Math.max(0,r.needed-r.stock),sufficient:r.stock>=r.needed}));
    const profilePlans = [...profiles.values()].map(({profile:kit,cuts})=>{ const length=num(kit.stock_length_mm)||6000; const bars=cutPlan(cuts,length,kerf); const used=cuts.reduce((a,b)=>a+b,0); const total=bars.length*length; return { profile_id:kit.profile_id, profile_name:kit.profile_name, stock_length_mm:length, bars:bars.map((b:any,i:number)=>({number:i+1,cuts:b.cuts,remaining_mm:b.remaining})), bar_count:bars.length, used_mm:used, waste_mm:Math.max(0,total-used), efficiency:total?used/total*100:0 }; });
    res.json({stock, profilePlans, feasible:stock.every(x=>x.sufficient)});
  });
  return router;
}

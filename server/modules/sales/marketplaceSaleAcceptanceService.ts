import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { InventoryService } from "../inventory/inventoryService.js";
import { ReturnsService } from "../returns/returnsService.js";
import { SalesFinancialService } from "./salesFinancialService.js";

export type MarketplaceAcceptedLine = {
  externalLineId: string;
  productId: string;
  quantityBaseInt: number;
  actualUnitGrossMinor: number;
  vatRateBps: number;
};

export class MarketplaceSaleAcceptanceService {
  private readonly inventory: InventoryService;
  private readonly financials: SalesFinancialService;

  constructor(private readonly db: Database.Database) {
    this.inventory = new InventoryService(db);
    this.financials = new SalesFinancialService(db);
  }

  accept(input: {
    channel: string;
    merchantAccountId: string;
    externalOrderId: string;
    currency: string;
    discountMinor: number;
    lines: MarketplaceAcceptedLine[];
    commission: { amountMinor: number; effectiveNumerator: number; effectiveDenominator: number; terms: unknown };
    operationId: string;
    actor: { id: string; name?: string | null };
    acceptedAt: string;
  }) {
    return this.db.transaction(() => {
      const saleId = randomUUID();
      const reservationId = `channel-reservation:${saleId}`;
      const orderCode = `${input.channel.slice(0, 3)}-${input.externalOrderId}`.slice(0, 80);
      const externalIdentity = `${input.channel}:${input.merchantAccountId}:${input.externalOrderId}`;
      const grossMinor = input.lines.reduce((sum, line) => sum + line.actualUnitGrossMinor * line.quantityBaseInt, 0);
      if (!Number.isSafeInteger(grossMinor)) throw new Error("MARKETPLACE_MONEY_OVERFLOW");
      this.db.prepare(`INSERT INTO sales (
        id,order_code,external_order_id,customer_name,total_quantity,total_amount,platform,commission_rate,
        discount,net_total,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?, 'Marketplace Received',?,?)`).run(
        saleId, orderCode, externalIdentity, `${input.channel} ${input.externalOrderId}`,
        input.lines.reduce((sum, line) => sum + line.quantityBaseInt, 0), grossMinor / 100,
        input.channel, Number(input.commission.effectiveNumerator) * 100 / Number(input.commission.effectiveDenominator),
        input.discountMinor / 100, (grossMinor - input.discountMinor) / 100, input.acceptedAt, input.acceptedAt,
      );
      const insertLine = this.db.prepare(`INSERT INTO sale_items
        (id,sale_id,product_id,product_name,quantity,unit_price,purchase_cost,net_profit)
        SELECT ?,?,?,COALESCE(title,name,sku),?,?,NULL,NULL FROM products WHERE id=?`);
      const financialLines: Array<{ saleLineId: string; productId: string; quantity: number; unitGrossMinor: number; vatRateBps: number }> = [];
      for (const line of input.lines) {
        const saleLineId = randomUUID();
        const inserted = insertLine.run(saleLineId, saleId, line.productId, line.quantityBaseInt, line.actualUnitGrossMinor / 100, line.productId);
        if (inserted.changes !== 1) throw new Error(`PRODUCT_NOT_FOUND:${line.productId}`);
        financialLines.push({ saleLineId, productId: line.productId, quantity: line.quantityBaseInt,
          unitGrossMinor: line.actualUnitGrossMinor, vatRateBps: line.vatRateBps });
      }
      const financial = this.financials.createOrderSnapshot({
        saleId, currency: input.currency, sourceChannel: input.channel, discountMinor: input.discountMinor,
        commissionRatePercent: "0", commissionRateRational: {
          numerator: input.commission.effectiveNumerator, denominator: input.commission.effectiveDenominator,
        }, commissionAmountMinorOverride: input.commission.amountMinor,
        commissionCalculationBasis: "GROSS_BEFORE_DISCOUNT", commissionTerms: input.commission.terms,
        expenses: {
          shipping: { state: "UNKNOWN", provenance: { source: "MARKETPLACE_SETTLEMENT_PENDING" } },
          packaging: { state: "UNKNOWN", provenance: { source: "MARKETPLACE_SETTLEMENT_PENDING" } },
          other: { state: "UNKNOWN", provenance: { source: "MARKETPLACE_SETTLEMENT_PENDING" } },
        },
        lines: financialLines, operationId: input.operationId, actor: input.actor, createdAt: input.acceptedAt,
      });

      const componentRows = this.db.prepare(`SELECT c.component_product_id AS product_id,SUM(c.quantity_base_int) AS quantity
        FROM sale_financial_line_components c JOIN sale_financial_lines l ON l.id=c.financial_line_id
        WHERE l.financial_snapshot_id=? GROUP BY c.component_product_id ORDER BY c.component_product_id`).all(financial.snapshot.id) as any[];
      const kitRows = this.db.prepare(`SELECT s.published_kit_version_id,s.snapshot_json,l.quantity_base_int
        FROM sale_kit_version_snapshots s JOIN sale_financial_lines l ON l.id=s.financial_line_id
        WHERE l.financial_snapshot_id=? ORDER BY l.line_sequence`).all(financial.snapshot.id) as any[];
      const profileCutPlans: Array<{ publishedKitVersionId: string; productId: string; kerfMm: number; cuts: Array<{ lengthMm: number }> }> = [];
      for (const kit of kitRows) {
        const snapshot = JSON.parse(kit.snapshot_json);
        const grouped = new Map<string, { kerfMm: number; cuts: Array<{ lengthMm: number }> }>();
        for (const cut of snapshot.cuts || []) {
          const entry = grouped.get(cut.profile_product_id) || { kerfMm: Number(cut.kerf_mm), cuts: [] };
          for (let sold = 0; sold < Number(kit.quantity_base_int); sold += 1) {
            for (let quantity = 0; quantity < Number(cut.quantity); quantity += 1) entry.cuts.push({ lengthMm: Number(cut.length_mm) });
          }
          grouped.set(cut.profile_product_id, entry);
        }
        for (const [productId, plan] of grouped) profileCutPlans.push({ publishedKitVersionId: kit.published_kit_version_id, productId, ...plan });
      }
      this.inventory.reserveOrder({ reservationId, orderId: saleId,
        lines: componentRows.map((row) => ({ productId: row.product_id, quantityBaseInt: Number(row.quantity) })),
        profileCutPlans, operationId: input.operationId, createdAt: input.acceptedAt });
      return { saleId, reservationId, financialSnapshotId: financial.snapshot.id, financialState: financial.state };
    }).immediate();
  }

  applyCancellationOrReturn(input: {
    saleId: string;
    operationId: string;
    actor: { id: string; name?: string | null };
    occurredAt: string;
  }) {
    return this.db.transaction(() => {
      const reservation = this.db.prepare("SELECT id,status FROM inventory_reservations WHERE order_id=?").get(input.saleId) as any;
      if (!reservation) throw new Error("CHANNEL_RESERVATION_NOT_FOUND");
      if (reservation.status !== "DISPATCHED") {
        if (reservation.status !== "RELEASED") this.inventory.releaseReservation({ reservationId: reservation.id,
          reason: "CHANNEL_PRE_DISPATCH_CANCELLATION", operationId: input.operationId, releasedAt: input.occurredAt });
        this.db.prepare("UPDATE sales SET status='İptal Edildi',updated_at=? WHERE id=?").run(input.occurredAt, input.saleId);
        return { state: "CANCELLED" as const, reservationId: reservation.id };
      }
      const lines = this.db.prepare(`SELECT id,quantity_base_int FROM sale_financial_lines
        WHERE financial_snapshot_id=(SELECT id FROM sale_financial_snapshots WHERE sale_id=?) ORDER BY line_sequence`).all(input.saleId) as any[];
      const result = new ReturnsService(this.db).createReturnRequest({ saleId: input.saleId,
        lines: lines.map((line) => ({ financialLineId: line.id, quantityBaseInt: Number(line.quantity_base_int),
          reasonCode: "OTHER" as const, explanation: "Marketplace post-dispatch cancellation/return event" })),
        customerShippingRefund: { selected: false, amountMinor: 0 }, operationId: input.operationId,
        actor: input.actor, requestedAt: input.occurredAt });
      return { state: "RETURN_REQUESTED" as const, returnId: result.id, reservationId: reservation.id };
    }).immediate();
  }
}


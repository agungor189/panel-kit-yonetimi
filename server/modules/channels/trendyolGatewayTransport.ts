import { createHash } from "node:crypto";
import { trendyolBaseUrl, type TrendyolEnvironment } from "../marketplaces/trendyol.js";
import { ChannelGatewayError, type ChannelGatewayService } from "./channelGateway.js";

type RequestJson = (url: string, headers: Record<string, string>, options?: RequestInit) => Promise<any>;

const identifier = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
};

const decimalMinor = (value: unknown, field: string) => {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) throw new ChannelGatewayError("TRENDYOL_MONEY_INVALID", `${field} must be a non-negative decimal with at most two fraction digits.`);
  const [whole, fraction = ""] = source.split(".");
  const result = Number(BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2)));
  if (!Number.isSafeInteger(result)) throw new ChannelGatewayError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return result;
};

const vatBasisPoints = (value: unknown) => {
  const source = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) throw new ChannelGatewayError("TRENDYOL_VAT_RATE_REQUIRED", "Trendyol order line vatRate is required for the V2-09 snapshot.");
  const [whole, fraction = ""] = source.split(".");
  const result = Number(BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2)));
  if (!Number.isSafeInteger(result) || result > 10_000) throw new ChannelGatewayError("TRENDYOL_VAT_RATE_INVALID", "Trendyol order line vatRate is invalid.");
  return result;
};

const packageLines = (pkg: any) => Array.isArray(pkg?.lines) ? pkg.lines
  : Array.isArray(pkg?.items) ? pkg.items
    : Array.isArray(pkg?.orderLines) ? pkg.orderLines : [];

const eventType = (status: unknown) => {
  const value = String(status || "").trim();
  if (["Cancelled", "UnSupplied"].includes(value)) return "ORDER_CANCELLED" as const;
  if (["Returned", "UnDelivered"].includes(value)) return "ORDER_RETURNED" as const;
  return "ORDER_UPSERT" as const;
};

const occurredAt = (value: unknown, fallback: string) => {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
};

export class TrendyolGatewayTransport {
  constructor(private readonly gateway: ChannelGatewayService, private readonly requestJson: RequestJson) {}

  async poll(input: {
    accountId: string;
    sellerId: string;
    environment: TrendyolEnvironment;
    headers: Record<string, string>;
    windowStartMs: number;
    windowEndMs: number;
    serviceActorId: string;
    operationIdPrefix: string;
    receivedAt: string;
    initialCursor?: string;
  }) {
    const summary = { fetched: 0, accepted: 0, duplicate: 0, exception: 0, pages: 0 };
    let nextCursor = input.initialCursor || "";
    do {
      const params = new URLSearchParams({ size: "200", lastModifiedStartDate: String(input.windowStartMs), lastModifiedEndDate: String(input.windowEndMs) });
      if (nextCursor) params.set("nextCursor", nextCursor);
      const response = await this.requestJson(`${trendyolBaseUrl(input.environment)}/integration/order/sellers/${encodeURIComponent(input.sellerId)}/orders/stream?${params}`, input.headers);
      const content = Array.isArray(response?.content) ? response.content : Array.isArray(response) ? response : [];
      for (const pkg of content) {
        const externalOrderId = identifier(pkg.orderNumber, pkg.orderNumberText, pkg.orderId, pkg.shipmentPackageId, pkg.packageId, pkg.id);
        if (!externalOrderId) continue;
        const status = identifier(pkg.status, pkg.packageStatus, pkg.packageItemStatus, pkg.lines?.[0]?.status);
        const modified = identifier(pkg.lastModifiedDate, pkg.packageLastModifiedDate, pkg.modifiedDate);
        const rawHash = createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
        const version = modified || rawHash;
        const lines = eventType(status) === "ORDER_UPSERT" ? packageLines(pkg).map((line: any, index: number) => {
          const listingId = identifier(line.barcode, line.productBarcode, line.stockCode, line.sellerStockCode, line.merchantSku, line.sku);
          if (!listingId) throw new ChannelGatewayError("TRENDYOL_LISTING_ID_REQUIRED", "Trendyol order line requires a barcode or stock code.");
          const quantity = Number(line.quantity ?? line.amount ?? line.productQuantity ?? 1);
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ChannelGatewayError("TRENDYOL_QUANTITY_INVALID", "Trendyol order line quantity must be a positive integer.");
          return {
            externalLineId: identifier(line.lineId, line.id, line.orderLineItemId, line.orderLineId,
              `${externalOrderId}:${index}:${listingId}`),
            externalListingId: listingId,
            externalSku: identifier(line.merchantSku, line.sku, line.stockCode, line.sellerStockCode) || null,
            quantityBaseInt: quantity,
            actualUnitGrossMinor: decimalMinor(line.discountedPrice ?? line.lineItemPrice ?? line.price ?? line.unitPrice ?? line.salePrice, "line.actualPrice"),
            vatRateBps: vatBasisPoints(line.vatRate),
          };
        }) : [];
        const outcome = this.gateway.ingest({ accountId: input.accountId,
          externalEventId: `trendyol-order:${externalOrderId}`, externalEventVersion: version, externalOrderId,
          eventType: eventType(status), ingestionPath: "POLL", currency: String(pkg.currencyCode || pkg.currency || "TRY").toUpperCase(),
          discountMinor: decimalMinor(pkg.totalDiscount ?? pkg.discount ?? 0, "order.discount"), lines, rawPayload: pkg,
          providerOccurredAt: occurredAt(pkg.lastModifiedDate ?? pkg.packageLastModifiedDate, input.receivedAt), receivedAt: input.receivedAt,
        }, `${input.operationIdPrefix}:event:${externalOrderId}:${version}`, input.serviceActorId);
        const state = String((outcome.result.body as any).state);
        summary.fetched += 1;
        if (state === "ACCEPTED") summary.accepted += 1;
        else if (state === "DUPLICATE") summary.duplicate += 1;
        else summary.exception += 1;
      }
      summary.pages += 1;
      nextCursor = response?.hasMore ? String(response.nextCursor || "") : "";
      this.gateway.updatePollingCursor({ accountId: input.accountId, cursorName: "trendyol-orders-stream",
        checkpointValue: JSON.stringify({ nextCursor, windowStartMs: input.windowStartMs, windowEndMs: input.windowEndMs }),
        operationId: `${input.operationIdPrefix}:cursor:${summary.pages}`, serviceActorId: input.serviceActorId, updatedAt: input.receivedAt });
    } while (nextCursor);
    return summary;
  }

  async publish(job: { kind: string; externalListingId: string; payload: any }, input: {
    sellerId: string;
    environment: TrendyolEnvironment;
    headers: Record<string, string>;
  }) {
    if (!job.externalListingId) throw new ChannelGatewayError("TRENDYOL_BARCODE_REQUIRED", "Trendyol publication requires the mapped barcode.", 409);
    let item: any;
    if (job.kind === "STOCK") item = { barcode: job.externalListingId, quantity: Number(job.payload.quantityBaseInt) };
    else if (job.kind === "PRICE") {
      const amountMinor = Number(job.payload.channelPriceMinor);
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) throw new ChannelGatewayError("TRENDYOL_PRICE_INVALID", "Channel price must be integer minor units.");
      item = { barcode: job.externalListingId, salePrice: amountMinor / 100, listPrice: amountMinor / 100 };
    } else {
      throw new ChannelGatewayError("TRENDYOL_VISIBILITY_TRANSPORT_UNVERIFIED", "Trendyol visibility publication is not enabled without a verified status contract.", 409);
    }
    return this.requestJson(`${trendyolBaseUrl(input.environment)}/integration/inventory/sellers/${encodeURIComponent(input.sellerId)}/products/price-and-inventory`,
      input.headers, { method: "POST", body: JSON.stringify({ items: [item] }) });
  }
}

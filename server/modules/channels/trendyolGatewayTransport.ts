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

const safeAdd = (values: number[], field: string) => {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result)) throw new ChannelGatewayError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return result;
};

const safeMultiply = (left: number, right: number, field: string) => {
  const result = Number(BigInt(left) * BigInt(right));
  if (!Number.isSafeInteger(result)) throw new ChannelGatewayError("MONEY_OVERFLOW", `${field} exceeds safe integer precision.`);
  return result;
};

function reconcile(condition: boolean, detail: string): asserts condition {
  if (!condition) throw new ChannelGatewayError("TRENDYOL_FINANCIAL_RECONCILIATION_FAILED", detail, 409);
}

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

const packageState = (status: unknown) => {
  const type = eventType(status);
  return type === "ORDER_CANCELLED" ? "CANCELLED" as const : type === "ORDER_RETURNED" ? "RETURNED" as const : "ACTIVE" as const;
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
    const summary = {
      fetched: 0,
      accepted: 0,
      duplicate: 0,
      exception: 0,
      pages: 0,
      errors: [] as Array<{ orderNumber: string; code: string; message: string }>,
    };
    let nextCursor = input.initialCursor || "";
    const fetchedPackages: any[] = [];
    do {
      const params = new URLSearchParams({ size: "200", lastModifiedStartDate: String(input.windowStartMs), lastModifiedEndDate: String(input.windowEndMs) });
      if (nextCursor) params.set("nextCursor", nextCursor);
      const response = await this.requestJson(`${trendyolBaseUrl(input.environment)}/integration/order/sellers/${encodeURIComponent(input.sellerId)}/orders/stream?${params}`, input.headers);
      const content = Array.isArray(response?.content) ? response.content : Array.isArray(response) ? response : [];
      fetchedPackages.push(...content);
      summary.fetched += content.length;
      summary.pages += 1;
      nextCursor = response?.hasMore ? String(response.nextCursor || "") : "";
    } while (nextCursor);

    const byOrder = new Map<string, any[]>();
    for (const pkg of fetchedPackages) {
      const orderNumber = identifier(pkg.orderNumber, pkg.orderNumberText, pkg.orderId);
      if (!orderNumber) throw new ChannelGatewayError("TRENDYOL_ORDER_NUMBER_REQUIRED", "Trendyol shipment package requires orderNumber.");
      const packageId = identifier(pkg.shipmentPackageId, pkg.packageId, pkg.id);
      if (!packageId) throw new ChannelGatewayError("TRENDYOL_PACKAGE_ID_REQUIRED", "Trendyol shipment package requires shipmentPackageId.");
      const entries = byOrder.get(orderNumber) || [];
      entries.push({ raw: pkg, orderNumber, packageId });
      byOrder.set(orderNumber, entries);
    }

    for (const [orderNumber, entries] of [...byOrder].sort(([left], [right]) => left.localeCompare(right))) {
      try {
      const packages = entries.map(({ raw: pkg, packageId }) => {
        const status = identifier(pkg.status, pkg.shipmentPackageStatus, pkg.packageStatus, pkg.packageItemStatus, pkg.lines?.[0]?.status);
        const state = packageState(status);
        const modified = identifier(pkg.lastModifiedDate, pkg.packageLastModifiedDate, pkg.modifiedDate);
        const rawHash = createHash("sha256").update(JSON.stringify(pkg)).digest("hex");
        const version = modified ? `${modified}:${rawHash}` : rawHash;
        const currency = String(pkg.currencyCode || pkg.currency || "").trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) throw new ChannelGatewayError("TRENDYOL_CURRENCY_REQUIRED", "Trendyol shipment package requires a three-letter currency.");
        const normalizedLines = packageLines(pkg).map((line: any, index: number) => {
          const listingId = identifier(line.barcode, line.productBarcode, line.stockCode, line.sellerStockCode, line.merchantSku, line.sku);
          if (!listingId) throw new ChannelGatewayError("TRENDYOL_LISTING_ID_REQUIRED", "Trendyol order line requires a barcode or stock code.");
          const quantity = Number(line.quantity ?? line.amount ?? line.productQuantity);
          if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new ChannelGatewayError("TRENDYOL_QUANTITY_INVALID", "Trendyol order line quantity must be a positive integer.");
          const unitGrossMinor = decimalMinor(line.lineGrossAmount, `packages.${packageId}.lines[${index}].lineGrossAmount`);
          const unitSellerDiscountMinor = decimalMinor(line.lineSellerDiscount, `packages.${packageId}.lines[${index}].lineSellerDiscount`);
          const unitTyDiscountMinor = decimalMinor(line.lineTyDiscount, `packages.${packageId}.lines[${index}].lineTyDiscount`);
          const unitTotalDiscountMinor = decimalMinor(line.lineTotalDiscount, `packages.${packageId}.lines[${index}].lineTotalDiscount`);
          const unitCustomerPriceMinor = decimalMinor(line.lineUnitPrice, `packages.${packageId}.lines[${index}].lineUnitPrice`);
          reconcile(unitTotalDiscountMinor === unitSellerDiscountMinor + unitTyDiscountMinor,
            `Package ${packageId} line ${index} total discount does not equal seller plus Trendyol discounts.`);
          reconcile(unitGrossMinor === unitTotalDiscountMinor + unitCustomerPriceMinor,
            `Package ${packageId} line ${index} gross does not equal total discount plus customer price.`);
          const details = line.discountDetails;
          let sellerDiscountMinor = safeMultiply(unitSellerDiscountMinor, quantity, "line seller discount");
          let trendyolDiscountMinor = safeMultiply(unitTyDiscountMinor, quantity, "line Trendyol discount");
          let customerTotalMinor = safeMultiply(unitCustomerPriceMinor, quantity, "line customer total");
          if (details !== undefined) {
            reconcile(Array.isArray(details) && details.length === quantity,
              `Package ${packageId} line ${index} discountDetails must contain one entry per item.`);
            const normalizedDetails = details.map((detail: any, detailIndex: number) => {
              const itemSeller = decimalMinor(detail.lineItemSellerDiscount, `discountDetails[${detailIndex}].lineItemSellerDiscount`);
              const itemTy = decimalMinor(detail.lineItemTyDiscount, `discountDetails[${detailIndex}].lineItemTyDiscount`);
              const itemPrice = decimalMinor(detail.lineItemPrice, `discountDetails[${detailIndex}].lineItemPrice`);
              reconcile(unitGrossMinor === itemSeller + itemTy + itemPrice,
                `Package ${packageId} line ${index} item ${detailIndex} does not conserve gross.`);
              return { lineItemId: identifier(detail.lineItemId, `${packageId}:${index}:${detailIndex}`),
                lineItemPriceMinor: itemPrice, sellerDiscountMinor: itemSeller, trendyolDiscountMinor: itemTy };
            });
            sellerDiscountMinor = safeAdd(normalizedDetails.map((detail: any) => detail.sellerDiscountMinor), "line item seller discounts");
            trendyolDiscountMinor = safeAdd(normalizedDetails.map((detail: any) => detail.trendyolDiscountMinor), "line item Trendyol discounts");
            customerTotalMinor = safeAdd(normalizedDetails.map((detail: any) => detail.lineItemPriceMinor), "line item customer prices");
            reconcile(sellerDiscountMinor === safeMultiply(unitSellerDiscountMinor, quantity, "line seller discount average"),
              `Package ${packageId} line ${index} seller discount average does not match discountDetails.`);
            reconcile(trendyolDiscountMinor === safeMultiply(unitTyDiscountMinor, quantity, "line Trendyol discount average"),
              `Package ${packageId} line ${index} Trendyol discount average does not match discountDetails.`);
            reconcile(customerTotalMinor === safeMultiply(unitCustomerPriceMinor, quantity, "line customer price average"),
              `Package ${packageId} line ${index} customer price average does not match discountDetails.`);
          }
          const grossMinor = safeMultiply(unitGrossMinor, quantity, "line gross");
          reconcile(grossMinor === sellerDiscountMinor + trendyolDiscountMinor + customerTotalMinor,
            `Package ${packageId} line ${index} does not conserve gross, discounts, and customer total.`);
          const provenance = { contract: "dsdst.trendyol-line-financial.v1", externalPackageId: packageId,
            unitGrossMinor, unitSellerDiscountMinor, unitTrendyolDiscountMinor: unitTyDiscountMinor,
            unitCustomerPriceMinor, grossMinor, sellerDiscountMinor, trendyolDiscountMinor, customerTotalMinor,
            discountDetails: Array.isArray(details) ? details : [] };
          return {
            externalLineId: identifier(line.lineId, line.id, line.orderLineItemId, line.orderLineId,
              `${packageId}:${index}:${listingId}`), externalPackageId: packageId, externalListingId: listingId,
            externalSku: identifier(line.merchantSku, line.sku, line.stockCode, line.sellerStockCode) || null,
            quantityBaseInt: quantity, actualUnitGrossMinor: unitGrossMinor, vatRateBps: vatBasisPoints(line.vatRate),
            providerGrossMinor: grossMinor, providerSellerDiscountMinor: sellerDiscountMinor,
            providerTyDiscountMinor: trendyolDiscountMinor, providerCustomerTotalMinor: customerTotalMinor,
            providerFinancialProvenance: provenance,
          };
        });
        const grossMinor = decimalMinor(pkg.packageGrossAmount, `packages.${packageId}.packageGrossAmount`);
        const sellerDiscountMinor = decimalMinor(pkg.packageSellerDiscount, `packages.${packageId}.packageSellerDiscount`);
        const trendyolDiscountMinor = decimalMinor(pkg.packageTyDiscount, `packages.${packageId}.packageTyDiscount`);
        const totalDiscountMinor = decimalMinor(pkg.packageTotalDiscount, `packages.${packageId}.packageTotalDiscount`);
        const customerTotalMinor = decimalMinor(pkg.packageTotalPrice, `packages.${packageId}.packageTotalPrice`);
        reconcile(totalDiscountMinor === sellerDiscountMinor + trendyolDiscountMinor,
          `Package ${packageId} total discount does not equal seller plus Trendyol discounts.`);
        reconcile(grossMinor === totalDiscountMinor + customerTotalMinor,
          `Package ${packageId} gross does not equal discount plus customer total.`);
        reconcile(grossMinor === safeAdd(normalizedLines.map((line: any) => line.providerGrossMinor), "package line gross"),
          `Package ${packageId} gross does not reconcile to its lines.`);
        reconcile(sellerDiscountMinor === safeAdd(normalizedLines.map((line: any) => line.providerSellerDiscountMinor), "package seller discounts"),
          `Package ${packageId} seller discount does not reconcile to its lines.`);
        reconcile(trendyolDiscountMinor === safeAdd(normalizedLines.map((line: any) => line.providerTyDiscountMinor), "package Trendyol discounts"),
          `Package ${packageId} Trendyol discount does not reconcile to its lines.`);
        reconcile(customerTotalMinor === safeAdd(normalizedLines.map((line: any) => line.providerCustomerTotalMinor), "package customer total"),
          `Package ${packageId} customer total does not reconcile to its lines.`);
        return { externalPackageId: packageId, externalPackageVersion: version, state, currency, grossMinor,
          sellerDiscountMinor, trendyolDiscountMinor, totalDiscountMinor, customerTotalMinor,
          providerOccurredAt: occurredAt(pkg.lastModifiedDate ?? pkg.packageLastModifiedDate, input.receivedAt),
          financialProvenance: { contract: "dsdst.trendyol-package-financial.v1", shipmentPackageId: packageId,
            orderNumber, grossMinor, sellerDiscountMinor, trendyolDiscountMinor, totalDiscountMinor, customerTotalMinor },
          lines: normalizedLines, rawPayload: pkg };
      }).sort((left, right) => left.externalPackageId.localeCompare(right.externalPackageId));
      const currencies = new Set(packages.map((pkg) => pkg.currency));
      reconcile(currencies.size === 1, `Order ${orderNumber} shipment packages use different currencies.`);
      const activePackages = packages.filter((pkg) => pkg.state === "ACTIVE");
      const lines = activePackages.flatMap((pkg) => pkg.lines).sort((left, right) =>
        left.externalPackageId.localeCompare(right.externalPackageId) || left.externalLineId.localeCompare(right.externalLineId));
      const aggregateVersion = createHash("sha256").update(JSON.stringify(packages.map((pkg) =>
        ({ externalPackageId: pkg.externalPackageId, externalPackageVersion: pkg.externalPackageVersion })))).digest("hex");
      const aggregateType = packages.every((pkg) => pkg.state === "CANCELLED") ? "ORDER_CANCELLED" as const
        : packages.every((pkg) => pkg.state === "RETURNED") ? "ORDER_RETURNED" as const : "ORDER_UPSERT" as const;
      const providerFinancial = {
        contract: "dsdst.trendyol-order-financial.v1",
        grossMinor: safeAdd(activePackages.map((pkg) => pkg.grossMinor), "order gross"),
        sellerDiscountMinor: safeAdd(activePackages.map((pkg) => pkg.sellerDiscountMinor), "order seller discount"),
        trendyolDiscountMinor: safeAdd(activePackages.map((pkg) => pkg.trendyolDiscountMinor), "order Trendyol discount"),
        customerTotalMinor: safeAdd(activePackages.map((pkg) => pkg.customerTotalMinor), "order customer total"),
        packages: activePackages.map((pkg) => pkg.financialProvenance),
      };
      reconcile(providerFinancial.grossMinor === providerFinancial.sellerDiscountMinor
        + providerFinancial.trendyolDiscountMinor + providerFinancial.customerTotalMinor,
      `Order ${orderNumber} does not conserve gross, discounts, and customer total.`);
      const outcome = this.gateway.ingest({ accountId: input.accountId,
        externalEventId: `trendyol-order:${orderNumber}`, externalEventVersion: aggregateVersion, externalOrderId: orderNumber,
        eventType: aggregateType, ingestionPath: "POLL", currency: packages[0].currency,
        discountMinor: providerFinancial.sellerDiscountMinor, lines,
        packages: packages.map(({ rawPayload: _rawPayload, ...pkg }) => pkg), providerFinancial,
        rawPayload: { orderNumber, shipmentPackages: packages.map((pkg) => pkg.rawPayload) },
        providerOccurredAt: packages.map((pkg) => pkg.providerOccurredAt).sort().at(-1), receivedAt: input.receivedAt,
      }, `${input.operationIdPrefix}:event:${orderNumber}:${aggregateVersion}`, input.serviceActorId);
      const state = String((outcome.result.body as any).state);
      if (state === "ACCEPTED") summary.accepted += 1;
      else if (state === "DUPLICATE") summary.duplicate += 1;
      else summary.exception += 1;
      } catch (error: any) {
        summary.exception += 1;
        summary.errors.push({
          orderNumber,
          code: String(error?.code || "TRENDYOL_ORDER_NORMALIZATION_FAILED"),
          message: String(error?.message || "Trendyol order normalization failed."),
        });
      }
    }
    this.gateway.updatePollingCursor({ accountId: input.accountId, cursorName: "trendyol-orders-stream",
      checkpointValue: JSON.stringify({ nextCursor: "", windowStartMs: input.windowStartMs, windowEndMs: input.windowEndMs }),
      operationId: `${input.operationIdPrefix}:cursor:${summary.pages}`, serviceActorId: input.serviceActorId, updatedAt: input.receivedAt });
    return summary;
  }

  async publish(job: { kind: string; externalListingId?: string; externalPackageId?: string; payload: any }, input: {
    sellerId: string;
    environment: TrendyolEnvironment;
    headers: Record<string, string>;
  }) {
    if (job.kind === "TRACKING_STATUS") {
      const packageId = identifier(job.externalPackageId);
      const trackingUrl = identifier(job.payload?.packages?.[0]?.trackingUrl);
      if (!packageId) throw new ChannelGatewayError("TRENDYOL_PACKAGE_ID_REQUIRED", "Trendyol shipment publication requires a package id.", 409);
      if (!trackingUrl) throw new ChannelGatewayError("CHANNEL_TRACKING_PENDING", "Tracking is not available yet.", 409);
      return this.requestJson(`${trendyolBaseUrl(input.environment)}/integration/order/sellers/${encodeURIComponent(input.sellerId)}`
        + `/shipment-packages/${encodeURIComponent(packageId)}/alternative-delivery`, input.headers,
      { method: "PUT", body: JSON.stringify({ isPhoneNumber: false, trackingInfo: trackingUrl, params: { boxQuantity: 1 } }) });
    }
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

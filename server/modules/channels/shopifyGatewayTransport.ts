import { createHash } from "node:crypto";
import { ChannelGatewayError, type ChannelGatewayService } from "./channelGateway.js";

type FetchLike = typeof fetch;

export type ShopifyGatewayConfig = {
  shop: string;
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
  locationId?: string | null;
};

type ShopifyTokenResponse = {
  access_token?: string;
  expires_in?: number;
  scope?: string;
};

type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
};


const decimalMinor = (value: unknown, field: string) => {
  const source = String(value ?? "").trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(source)) {
    throw new ChannelGatewayError(
      "SHOPIFY_MONEY_INVALID",
      `${field} must be a non-negative decimal with at most two fraction digits.`,
      409,
    );
  }

  const [whole, fraction = ""] = source.split(".");
  const result = Number(
    BigInt(whole) * 100n
    + BigInt((fraction + "00").slice(0, 2)),
  );

  if (!Number.isSafeInteger(result)) {
    throw new ChannelGatewayError(
      "MONEY_OVERFLOW",
      `${field} exceeds safe integer precision.`,
      409,
    );
  }

  return result;
};

const safeMultiply = (
  left: number,
  right: number,
  field: string,
) => {
  const value = Number(BigInt(left) * BigInt(right));

  if (!Number.isSafeInteger(value)) {
    throw new ChannelGatewayError(
      "MONEY_OVERFLOW",
      `${field} exceeds safe integer precision.`,
      409,
    );
  }

  return value;
};

const safeAdd = (values: number[], field: string) => {
  const value = values.reduce((sum, item) => sum + item, 0);

  if (!Number.isSafeInteger(value)) {
    throw new ChannelGatewayError(
      "MONEY_OVERFLOW",
      `${field} exceeds safe integer precision.`,
      409,
    );
  }

  return value;
};

const vatBasisPoints = (taxLines: any[]) => {
  const rates = Array.isArray(taxLines)
    ? taxLines.map((line) => Number(line?.rate || 0))
    : [];

  if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
    throw new ChannelGatewayError(
      "SHOPIFY_VAT_INVALID",
      "Shopify tax rate is invalid.",
      409,
    );
  }

  const result = rates.reduce(
    (sum, rate) => sum + Math.round(rate * 10_000),
    0,
  );

  if (
    !Number.isSafeInteger(result)
    || result < 0
    || result > 10_000
  ) {
    throw new ChannelGatewayError(
      "SHOPIFY_VAT_INVALID",
      "Shopify combined tax rate is invalid.",
      409,
    );
  }

  return result;
};

const clean = (value: unknown) =>
  String(value ?? "").trim();

const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");

const required = (value: unknown, field: string, max = 500) => {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) {
    throw new ChannelGatewayError(
      "SHOPIFY_CONFIG_INVALID",
      `${field} is required.`,
      500,
    );
  }
  return text;
};

const normalizeShop = (value: unknown) => {
  const shop = required(value, "SHOPIFY_SHOP", 255).toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new ChannelGatewayError(
      "SHOPIFY_SHOP_INVALID",
      "SHOPIFY_SHOP must be a valid *.myshopify.com domain.",
      500,
    );
  }

  return shop;
};

export class ShopifyGatewayTransport {
  private readonly shop: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly apiVersion: string;
  private readonly locationId: string | null;
  private readonly fetchImpl: FetchLike;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: ShopifyGatewayConfig, fetchImpl: FetchLike = fetch) {
    this.shop = normalizeShop(config.shop);
    this.clientId = required(config.clientId, "SHOPIFY_CLIENT_ID");
    this.clientSecret = required(config.clientSecret, "SHOPIFY_CLIENT_SECRET");
    this.apiVersion = String(config.apiVersion || "2026-07").trim();
    this.locationId = String(config.locationId || "").trim() || null;
    this.fetchImpl = fetchImpl;
  }

  static fromEnvironment(fetchImpl: FetchLike = fetch) {
    return new ShopifyGatewayTransport(
      {
        shop: process.env.SHOPIFY_SHOP || "",
        clientId: process.env.SHOPIFY_CLIENT_ID || "",
        clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
        apiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
        locationId: process.env.SHOPIFY_LOCATION_ID || null,
      },
      fetchImpl,
    );
  }

  private async accessToken() {
    const now = Date.now();

    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const response = await this.fetchImpl(
      `https://${this.shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
    );

    let payload: ShopifyTokenResponse = {};

    try {
      payload = await response.json() as ShopifyTokenResponse;
    } catch {
      throw new ChannelGatewayError(
        "SHOPIFY_TOKEN_RESPONSE_INVALID",
        "Shopify token endpoint returned invalid JSON.",
        502,
      );
    }

    if (!response.ok || !payload.access_token) {
      throw new ChannelGatewayError(
        "SHOPIFY_AUTH_FAILED",
        `Shopify client credentials authentication failed with HTTP ${response.status}.`,
        502,
      );
    }

    const expiresIn = Number(payload.expires_in || 0);

    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ChannelGatewayError(
        "SHOPIFY_TOKEN_EXPIRY_INVALID",
        "Shopify token expiry is invalid.",
        502,
      );
    }

    this.token = payload.access_token;
    this.tokenExpiresAt = now + expiresIn * 1000;

    return this.token;
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const token = await this.accessToken();

    const response = await this.fetchImpl(
      `https://${this.shop}/admin/api/${encodeURIComponent(this.apiVersion)}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    let payload: GraphqlEnvelope<T>;

    try {
      payload = await response.json() as GraphqlEnvelope<T>;
    } catch {
      throw new ChannelGatewayError(
        "SHOPIFY_GRAPHQL_RESPONSE_INVALID",
        "Shopify GraphQL endpoint returned invalid JSON.",
        502,
      );
    }

    if (!response.ok) {
      throw new ChannelGatewayError(
        "SHOPIFY_GRAPHQL_HTTP_ERROR",
        `Shopify GraphQL request failed with HTTP ${response.status}.`,
        502,
      );
    }

    if (payload.errors?.length) {
      throw new ChannelGatewayError(
        "SHOPIFY_GRAPHQL_ERROR",
        payload.errors.map((error) => error.message || "Unknown Shopify GraphQL error").join("; "),
        502,
      );
    }

    if (!payload.data) {
      throw new ChannelGatewayError(
        "SHOPIFY_GRAPHQL_DATA_MISSING",
        "Shopify GraphQL response did not contain data.",
        502,
      );
    }

    return payload.data;
  }

  async verifyConnection() {
    const data = await this.graphql<{
      shop: {
        name: string;
        myshopifyDomain: string;
        currencyCode: string;
      };
      locations: {
        nodes: Array<{
          id: string;
          name: string;
          isActive: boolean;
        }>;
      };
      currentAppInstallation: {
        accessScopes: Array<{ handle: string }>;
      };
    }>(`
      query ShopifyConnectionCheck {
        shop {
          name
          myshopifyDomain
          currencyCode
        }
        locations(first: 100) {
          nodes {
            id
            name
            isActive
          }
        }
        currentAppInstallation {
          accessScopes {
            handle
          }
        }
      }
    `);

    if (data.shop.myshopifyDomain.toLowerCase() !== this.shop) {
      throw new ChannelGatewayError(
        "SHOPIFY_SHOP_MISMATCH",
        "Authenticated Shopify shop does not match SHOPIFY_SHOP.",
        409,
      );
    }

    if (this.locationId) {
      const location = data.locations.nodes.find(
        (candidate) => candidate.id === this.locationId,
      );

      if (!location) {
        throw new ChannelGatewayError(
          "SHOPIFY_LOCATION_NOT_FOUND",
          "Configured Shopify location was not found.",
          409,
        );
      }

      if (!location.isActive) {
        throw new ChannelGatewayError(
          "SHOPIFY_LOCATION_INACTIVE",
          "Configured Shopify location is inactive.",
          409,
        );
      }
    }

    return {
      shop: data.shop,
      locations: data.locations.nodes,
      scopes: data.currentAppInstallation.accessScopes
        .map((scope) => scope.handle)
        .sort(),
      configuredLocationId: this.locationId,
    };
  }

  async listOrders(input: {
    first?: number;
    after?: string | null;
    query?: string | null;
  } = {}) {
    const first = Math.min(100, Math.max(1, Math.trunc(input.first || 50)));

    return this.graphql<{
      orders: {
        nodes: Array<{
          id: string;
          name: string;
          createdAt: string;
          updatedAt: string;
          displayFinancialStatus: string | null;
          displayFulfillmentStatus: string | null;
          email: string | null;
          totalPriceSet: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
          subtotalPriceSet: {
            shopMoney: {
              amount: string;
              currencyCode: string;
            };
          };
          shippingAddress: {
            address1: string | null;
            city: string | null;
            provinceCode: string | null;
            zip: string | null;
          } | null;
          lineItems: {
            nodes: Array<{
              id: string;
              name: string;
              quantity: number;
              sku: string | null;
              variant: {
                id: string;
                title: string;
              } | null;
            }>;
          };
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(
      `
        query ShopifyOrders(
          $first: Int!
          $after: String
          $query: String
        ) {
          orders(
            first: $first
            after: $after
            sortKey: UPDATED_AT
            query: $query
          ) {
            nodes {
              id
              name
              createdAt
              updatedAt
              displayFinancialStatus
              displayFulfillmentStatus
              email
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              shippingAddress {
                address1
                city
                provinceCode
                zip
              }
              lineItems(first: 100) {
                nodes {
                  id
                  name
                  quantity
                  sku
                  variant {
                    id
                    title
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        first,
        after: input.after || null,
        query: input.query || null,
      },
    );
  }


  async poll(input: {
    gateway: ChannelGatewayService;
    accountId: string;
    query?: string | null;
    serviceActorId: string;
    operationIdPrefix: string;
    receivedAt: string;
    maxPages?: number;
  }) {
    const summary = {
      fetched: 0,
      accepted: 0,
      duplicate: 0,
      cancelled: 0,
      exception: 0,
      skipped: 0,
      pages: 0,
      errors: [] as Array<{
        orderId: string;
        code: string;
        message: string;
      }>,
    };

    const maxPages = Math.min(
      100,
      Math.max(1, Math.trunc(input.maxPages || 20)),
    );

    let after: string | null = null;

    do {
      const data = await this.graphql<any>(
        `
          query ShopifyOrderPoll(
            $first: Int!
            $after: String
            $query: String
          ) {
            orders(
              first: $first
              after: $after
              sortKey: UPDATED_AT
              reverse: true
              query: $query
            ) {
              nodes {
                id
                legacyResourceId
                name
                email
                createdAt
                updatedAt
                cancelledAt
                displayFinancialStatus
                displayFulfillmentStatus
                taxesIncluded

                currentTotalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                currentTotalDiscountsSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                currentTotalTaxSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }

                shippingAddress {
                  name
                  phone
                  address1
                  address2
                  city
                  province
                  provinceCode
                  zip
                  countryCodeV2
                }

                billingAddress {
                  name
                  phone
                  address1
                  address2
                  city
                  province
                  provinceCode
                  zip
                  countryCodeV2
                }

                lineItems(first: 100) {
                  nodes {
                    id
                    name
                    sku
                    quantity
                    currentQuantity
                    taxable

                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }

                    discountedUnitPriceAfterAllDiscountsSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }

                    totalDiscountSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }

                    taxLines {
                      rate
                      priceSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                    }

                    variant {
                      id
                      title
                      inventoryItem {
                        id
                      }
                    }
                  }
                }
              }

              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        {
          first: 100,
          after,
          query: input.query || "status:any",
        },
      );

      const orders = Array.isArray(data.orders?.nodes)
        ? data.orders.nodes
        : [];

      summary.fetched += orders.length;
      summary.pages += 1;

      for (const order of orders) {
        const externalOrderId = clean(
          order.legacyResourceId || order.id,
        );

        try {
          if (!externalOrderId) {
            throw new ChannelGatewayError(
              "SHOPIFY_ORDER_ID_REQUIRED",
              "Shopify order does not contain a stable order id.",
              409,
            );
          }

          const cancelled = Boolean(order.cancelledAt);

          // V19 ilk aşama:
          // Yeni siparişlerde sadece gerçekten PAID olanları kabul et.
          // Daha önce kabul edilmiş bir sipariş iptal edilirse cancellation
          // event'i yine işlenir.
          if (
            !cancelled
            && clean(order.displayFinancialStatus).toUpperCase() !== "PAID"
          ) {
            summary.skipped += 1;
            continue;
          }

          const eventType = cancelled
            ? "ORDER_CANCELLED" as const
            : "ORDER_UPSERT" as const;

          const normalizedLines: any[] = [];

          if (!cancelled) {
            for (
              const [index, line]
              of (order.lineItems?.nodes || []).entries()
            ) {
              const quantity = Number(
                line.currentQuantity ?? line.quantity,
              );

              if (quantity === 0) continue;

              if (
                !Number.isSafeInteger(quantity)
                || quantity < 0
              ) {
                throw new ChannelGatewayError(
                  "SHOPIFY_QUANTITY_INVALID",
                  `Shopify line ${index} quantity is invalid.`,
                  409,
                );
              }

              const variantId = clean(line.variant?.id);

              if (!variantId) {
                throw new ChannelGatewayError(
                  "SHOPIFY_VARIANT_REQUIRED",
                  `Shopify line ${index} has no variant id.`,
                  409,
                );
              }

              const unitGrossMinor = decimalMinor(
                line.originalUnitPriceSet?.shopMoney?.amount,
                `lines[${index}].originalUnitPrice`,
              );

              const discountedUnitMinor = decimalMinor(
                line.discountedUnitPriceAfterAllDiscountsSet
                  ?.shopMoney?.amount,
                `lines[${index}].discountedUnitPrice`,
              );

              if (discountedUnitMinor > unitGrossMinor) {
                throw new ChannelGatewayError(
                  "SHOPIFY_FINANCIAL_RECONCILIATION_FAILED",
                  `Shopify line ${index} discounted price exceeds original price.`,
                  409,
                );
              }

              const grossMinor = safeMultiply(
                unitGrossMinor,
                quantity,
                `lines[${index}].gross`,
              );

              const customerTotalMinor = safeMultiply(
                discountedUnitMinor,
                quantity,
                `lines[${index}].customerTotal`,
              );

              const sellerDiscountMinor =
                grossMinor - customerTotalMinor;

              const reportedDiscountMinor = decimalMinor(
                line.totalDiscountSet?.shopMoney?.amount,
                `lines[${index}].totalDiscount`,
              );

              if (
                sellerDiscountMinor
                !== reportedDiscountMinor
              ) {
                throw new ChannelGatewayError(
                  "SHOPIFY_FINANCIAL_RECONCILIATION_FAILED",
                  `Shopify line ${index} discount does not reconcile.`,
                  409,
                );
              }

              normalizedLines.push({
                externalLineId: clean(line.id),
                externalListingId: variantId,
                externalSku: clean(line.sku) || null,
                quantityBaseInt: quantity,
                actualUnitGrossMinor: unitGrossMinor,
                vatRateBps: vatBasisPoints(line.taxLines),

                providerGrossMinor: grossMinor,
                providerSellerDiscountMinor:
                  sellerDiscountMinor,

                // ChannelGateway alan adı Trendyol döneminden kalma.
                // Shopify'da provider-funded discount bu aşamada 0.
                providerTyDiscountMinor: 0,

                providerCustomerTotalMinor:
                  customerTotalMinor,

                providerFinancialProvenance: {
                  contract:
                    "dsdst.shopify-line-financial.v1",
                  inventoryItemId:
                    clean(line.variant?.inventoryItem?.id)
                    || null,
                  taxable: Boolean(line.taxable),
                  grossMinor,
                  sellerDiscountMinor,
                  customerTotalMinor,
                },
              });
            }

            if (normalizedLines.length === 0) {
              throw new ChannelGatewayError(
                "SHOPIFY_LINES_REQUIRED",
                "Paid Shopify order has no active order lines.",
                409,
              );
            }
          }

          const lineDiscountMinor = safeAdd(
            normalizedLines.map(
              (line) =>
                Number(
                  line.providerSellerDiscountMinor || 0,
                ),
            ),
            "Shopify line discounts",
          );

          const orderDiscountMinor = decimalMinor(
            order.currentTotalDiscountsSet?.shopMoney?.amount
              || "0",
            "order.currentTotalDiscounts",
          );

          if (
            !cancelled
            && lineDiscountMinor !== orderDiscountMinor
          ) {
            throw new ChannelGatewayError(
              "SHOPIFY_FINANCIAL_RECONCILIATION_FAILED",
              "Shopify order discount does not reconcile to line discounts.",
              409,
            );
          }

          const currency = clean(
            order.currentTotalPriceSet
              ?.shopMoney?.currencyCode,
          ).toUpperCase();

          if (!/^[A-Z]{3}$/.test(currency)) {
            throw new ChannelGatewayError(
              "SHOPIFY_CURRENCY_INVALID",
              "Shopify order currency is invalid.",
              409,
            );
          }

          const address =
            order.shippingAddress
            || order.billingAddress
            || {};

          const recipient = {
            name: clean(address.name),
            email: clean(order.email),
            phone: clean(address.phone),
            address1: clean(address.address1),
            address2: clean(address.address2) || null,
            countryCode:
              clean(address.countryCodeV2).toUpperCase()
              || "TR",
            cityName: clean(address.city),
            districtName: "",
            province: clean(address.province),
            provinceCode: clean(address.provinceCode),
            zip: clean(address.zip) || null,
          };

          // Fulfillment status raw digest'e dahil edilmiyor.
          // Böylece bizim Shopify'a göndereceğimiz fulfillment değişikliği
          // gereksiz ORDER_VERSION_EXCEPTION üretmez.
          const rawPayload = {
            provider: "SHOPIFY",
            shopifyOrderId: clean(order.id),
            orderName: clean(order.name),
            recipient,
            lines: normalizedLines.map((line) => ({
              externalLineId: line.externalLineId,
              externalListingId:
                line.externalListingId,
              externalSku: line.externalSku,
              quantityBaseInt:
                line.quantityBaseInt,
              actualUnitGrossMinor:
                line.actualUnitGrossMinor,
              providerSellerDiscountMinor:
                line.providerSellerDiscountMinor,
            })),
            cancelledAt:
              order.cancelledAt || null,
          };

          const versionHash = hash({
            updatedAt: order.updatedAt,
            cancelledAt: order.cancelledAt || null,
            lines: rawPayload.lines,
          });

          const eventVersion =
            `${clean(order.updatedAt)}:${versionHash}`;

          const grossMinor = safeAdd(
            normalizedLines.map(
              (line) =>
                Number(line.providerGrossMinor || 0),
            ),
            "Shopify order gross",
          );

          const customerMerchandiseMinor = safeAdd(
            normalizedLines.map(
              (line) =>
                Number(
                  line.providerCustomerTotalMinor || 0,
                ),
            ),
            "Shopify merchandise customer total",
          );

          const outcome = input.gateway.ingest(
            {
              accountId: input.accountId,

              externalEventId:
                `shopify-order:${externalOrderId}`,

              externalEventVersion:
                eventVersion,

              externalOrderId,

              eventType,
              ingestionPath: "POLL",

              currency,

              discountMinor:
                cancelled
                  ? 0
                  : lineDiscountMinor,

              lines: normalizedLines,

              providerFinancial: {
                contract:
                  "dsdst.shopify-order-financial.v1",

                grossMinor,

                sellerDiscountMinor:
                  lineDiscountMinor,

                customerMerchandiseMinor,

                orderTotalMinor:
                  decimalMinor(
                    order.currentTotalPriceSet
                      ?.shopMoney?.amount || "0",
                    "order.currentTotalPrice",
                  ),

                taxMinor:
                  decimalMinor(
                    order.currentTotalTaxSet
                      ?.shopMoney?.amount || "0",
                    "order.currentTotalTax",
                  ),

                taxesIncluded:
                  Boolean(order.taxesIncluded),
              },

              rawPayload,

              providerOccurredAt:
                clean(order.updatedAt),

              receivedAt:
                input.receivedAt,
            },

            `${input.operationIdPrefix}:event:${externalOrderId}:${versionHash}`,

            input.serviceActorId,
          );

          const state = String(
            (outcome.result.body as any).state,
          );

          if (state === "ACCEPTED") {
            summary.accepted += 1;
          } else if (state === "DUPLICATE") {
            summary.duplicate += 1;
          } else if (state === "CANCELLED") {
            summary.cancelled += 1;
          } else {
            summary.exception += 1;
          }
        } catch (error: any) {
          summary.exception += 1;

          summary.errors.push({
            orderId: externalOrderId || "UNKNOWN",
            code:
              clean(error?.code)
              || "SHOPIFY_POLL_ORDER_FAILED",
            message:
              clean(error?.message)
              || "Shopify order processing failed.",
          });
        }
      }

      after =
        data.orders?.pageInfo?.hasNextPage
          ? clean(data.orders.pageInfo.endCursor)
            || null
          : null;

    } while (
      after
      && summary.pages < maxPages
    );

    return summary;
  }

}

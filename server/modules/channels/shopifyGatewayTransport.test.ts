import assert from "node:assert/strict";
import test from "node:test";
import { ShopifyGatewayTransport } from "./shopifyGatewayTransport.js";

const config = {
  shop: "2b6rcy-br.myshopify.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  apiVersion: "2026-07",
  locationId: "gid://shopify/Location/75228315715",
};

test("Shopify transport authenticates, verifies shop/location/scopes and reuses token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fakeFetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
        scope: "read_orders,read_products",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = JSON.parse(String(init?.body || "{}"));

    if (String(body.query).includes("ShopifyConnectionCheck")) {
      return new Response(JSON.stringify({
        data: {
          shop: {
            name: "DSDST",
            myshopifyDomain: "2b6rcy-br.myshopify.com",
            currencyCode: "TRY",
          },
          locations: {
            nodes: [{
              id: "gid://shopify/Location/75228315715",
              name: "Istanbul",
              isActive: true,
            }],
          },
          currentAppInstallation: {
            accessScopes: [
              { handle: "read_orders" },
              { handle: "write_inventory" },
            ],
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      data: {
        orders: {
          nodes: [],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const transport = new ShopifyGatewayTransport(config, fakeFetch as typeof fetch);

  const verified = await transport.verifyConnection();

  assert.equal(verified.shop.name, "DSDST");
  assert.equal(
    verified.configuredLocationId,
    "gid://shopify/Location/75228315715",
  );
  assert.deepEqual(verified.scopes, ["read_orders", "write_inventory"]);

  await transport.listOrders({ first: 25 });

  assert.equal(
    calls.filter((call) => call.url.endsWith("/admin/oauth/access_token")).length,
    1,
  );

  const graphqlCalls = calls.filter((call) =>
    call.url.includes("/graphql.json")
  );

  assert.equal(graphqlCalls.length, 2);
  assert.equal(
    (graphqlCalls[0].init?.headers as Record<string, string>)["X-Shopify-Access-Token"],
    "token-1",
  );
});

test("Shopify transport fails closed when configured location is missing", async () => {
  const fakeFetch = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      data: {
        shop: {
          name: "DSDST",
          myshopifyDomain: "2b6rcy-br.myshopify.com",
          currencyCode: "TRY",
        },
        locations: { nodes: [] },
        currentAppInstallation: { accessScopes: [] },
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const transport = new ShopifyGatewayTransport(config, fakeFetch as typeof fetch);

  await assert.rejects(
    transport.verifyConnection(),
    (error: any) => error?.code === "SHOPIFY_LOCATION_NOT_FOUND",
  );
});

test("Shopify transport surfaces GraphQL errors without leaking credentials", async () => {
  const fakeFetch = async (input: URL | RequestInfo) => {
    const url = String(input);

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      errors: [{ message: "Access denied" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const transport = new ShopifyGatewayTransport(config, fakeFetch as typeof fetch);

  await assert.rejects(
    transport.listOrders(),
    (error: any) =>
      error?.code === "SHOPIFY_GRAPHQL_ERROR"
      && !String(error?.message).includes("client-secret"),
  );
});

test("Shopify poll normalizes a paid order and sends it to ChannelGateway", async () => {
  const captured: any[] = [];

  const gateway = {
    ingest(event: any, operationId: string, serviceActorId: string) {
      captured.push({
        event,
        operationId,
        serviceActorId,
      });

      return {
        result: {
          body: {
            state: "ACCEPTED",
            saleId: "sale-1",
            reservationId: "reservation-1",
          },
        },
      };
    },
  };

  const fakeFetch = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = String(input);

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const body = JSON.parse(
      String(init?.body || "{}"),
    );

    if (
      String(body.query)
        .includes("ShopifyOrderPoll")
    ) {
      return new Response(JSON.stringify({
        data: {
          orders: {
            nodes: [{
              id: "gid://shopify/Order/8408602148931",
              legacyResourceId: "8408602148931",
              name: "#1006",
              email: "customer@example.test",
              createdAt:
                "2026-09-24T15:00:00Z",
              updatedAt:
                "2026-09-24T15:35:56Z",
              cancelledAt: null,

              displayFinancialStatus: "PAID",
              displayFulfillmentStatus:
                "UNFULFILLED",

              taxesIncluded: true,

              currentTotalPriceSet: {
                shopMoney: {
                  amount: "450.00",
                  currencyCode: "TRY",
                },
              },

              currentTotalDiscountsSet: {
                shopMoney: {
                  amount: "0.00",
                  currencyCode: "TRY",
                },
              },

              currentTotalTaxSet: {
                shopMoney: {
                  amount: "68.64",
                  currencyCode: "TRY",
                },
              },

              shippingAddress: {
                name: "Test Customer",
                phone: "+905000000000",
                address1: "Test Address",
                address2: null,
                city: "Istanbul",
                province: "Istanbul",
                provinceCode: "34",
                zip: "34000",
                countryCodeV2: "TR",
              },

              billingAddress: null,

              lineItems: {
                nodes: [{
                  id:
                    "gid://shopify/LineItem/20158028513347",

                  name: "3 Yollu - 30mm",
                  sku: "DSDST-4Y-7KQ30",
                  quantity: 1,
                  currentQuantity: 1,
                  taxable: true,

                  originalUnitPriceSet: {
                    shopMoney: {
                      amount: "450.00",
                      currencyCode: "TRY",
                    },
                  },

                  discountedUnitPriceAfterAllDiscountsSet: {
                    shopMoney: {
                      amount: "450.00",
                      currencyCode: "TRY",
                    },
                  },

                  totalDiscountSet: {
                    shopMoney: {
                      amount: "0.00",
                      currencyCode: "TRY",
                    },
                  },

                  taxLines: [{
                    rate: 0.18,
                    priceSet: {
                      shopMoney: {
                        amount: "68.64",
                        currencyCode: "TRY",
                      },
                    },
                  }],

                  variant: {
                    id:
                      "gid://shopify/ProductVariant/43333979144259",

                    title: "30mm",

                    inventoryItem: {
                      id:
                        "gid://shopify/InventoryItem/45448261075011",
                    },
                  },
                }],
              },
            }],

            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    throw new Error(
      `UNEXPECTED_REQUEST:${url}`,
    );
  };

  const transport =
    new ShopifyGatewayTransport(
      config,
      fakeFetch as typeof fetch,
    );

  const summary = await transport.poll({
    gateway: gateway as any,
    accountId:
      "shopify:production:2b6rcy-br",
    query: "status:any",
    serviceActorId:
      "shopify-poller:test",
    operationIdPrefix:
      "shopify-test-poll",
    receivedAt:
      "2026-09-26T00:00:00.000Z",
  });

  assert.equal(summary.fetched, 1);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.exception, 0);
  assert.equal(captured.length, 1);

  const event = captured[0].event;

  assert.equal(
    event.externalOrderId,
    "8408602148931",
  );

  assert.equal(
    event.eventType,
    "ORDER_UPSERT",
  );

  assert.equal(
    event.currency,
    "TRY",
  );

  assert.equal(
    event.discountMinor,
    0,
  );

  assert.equal(
    event.lines[0].externalListingId,
    "gid://shopify/ProductVariant/43333979144259",
  );

  assert.equal(
    event.lines[0].externalSku,
    "DSDST-4Y-7KQ30",
  );

  assert.equal(
    event.lines[0].actualUnitGrossMinor,
    45000,
  );

  assert.equal(
    event.lines[0].vatRateBps,
    1800,
  );

  assert.equal(
    event.rawPayload.recipient.cityName,
    "Istanbul",
  );
});

test("Shopify shipment tracking creates fulfillment and is replay-safe", async () => {
  let mutationVariables: any = null;

  const fakeFetch = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = String(input);

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    const body = JSON.parse(
      String(init?.body || "{}"),
    );

    if (
      String(body.query)
        .includes("ShopifyFulfillmentCheck")
    ) {
      return new Response(JSON.stringify({
        data: {
          order: {
            id: "gid://shopify/Order/8412576448579",
            name: "#1007",
            displayFulfillmentStatus: "UNFULFILLED",
            fulfillmentOrders: {
              nodes: [{
                id: "gid://shopify/FulfillmentOrder/1",
                status: "OPEN",
                requestStatus: "UNSUBMITTED",
              }],
            },
            fulfillments: [],
          },
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    if (
      String(body.query)
        .includes("ShopifyFulfillmentCreate")
    ) {
      mutationVariables = body.variables;

      return new Response(JSON.stringify({
        data: {
          fulfillmentCreate: {
            fulfillment: {
              id: "gid://shopify/Fulfillment/1",
              status: "SUCCESS",
              trackingInfo: [{
                company: "Geliver",
                number: "85198249",
                url: "https://tracking.example/85198249",
              }],
            },
            userErrors: [],
          },
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    }

    throw new Error(`UNEXPECTED_REQUEST:${url}`);
  };

  const transport =
    new ShopifyGatewayTransport(
      config,
      fakeFetch as typeof fetch,
    );

  const result =
    await transport.publishShipmentTracking({
      externalOrderId: "8412576448579",
      trackingNumber: "85198249",
      trackingUrl:
        "https://tracking.example/85198249",
      company: "GELIVER",
      notifyCustomer: false,
    });

  assert.equal(result.state, "SUCCEEDED");
  assert.equal(result.replayed, false);
  assert.equal(
    mutationVariables
      .fulfillment
      .lineItemsByFulfillmentOrder[0]
      .fulfillmentOrderId,
    "gid://shopify/FulfillmentOrder/1",
  );
  assert.equal(
    mutationVariables.fulfillment.trackingInfo.company,
    "Geliver",
  );
  assert.equal(
    mutationVariables.fulfillment.trackingInfo.number,
    "85198249",
  );
  assert.equal(
    mutationVariables.fulfillment.notifyCustomer,
    false,
  );
});

test("Shopify poll keeps canonical raw payload compatible with bootstrap ingestion", async () => {
  const captured: any[] = [];
  let recoverException = false;
  let recoveryCalls = 0;

  const gateway = {
    ingest(event: any) {
      captured.push(event);

      return {
        result: {
          body: {
            state: "DUPLICATE",
            saleId:
              recoverException
                ? null
                : "sale-existing",
          },
        },
      };
    },

    tryAutoRecoverExceptionOrder(input: any) {
      recoveryCalls += 1;

      assert.equal(
        input.externalOrderId,
        "8408602148931",
      );

      return {
        state: "ACCEPTED",
        saleId: "sale-recovered",
        reservationId:
          "reservation-recovered",
      };
    },
  };

  const fakeFetch = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = String(input);

    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "token-1",
        expires_in: 86399,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = JSON.parse(String(init?.body || "{}"));

    if (String(body.query).includes("ShopifyOrderPoll")) {
      return new Response(JSON.stringify({
        data: {
          orders: {
            nodes: [{
              id: "gid://shopify/Order/8408602148931",
              legacyResourceId: "8408602148931",
              name: "#1006",
              email: null,
              createdAt: "2026-09-24T15:00:00Z",
              updatedAt: "2026-09-24T15:35:56Z",
              cancelledAt: null,
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              taxesIncluded: true,
              currentTotalPriceSet: {
                shopMoney: {
                  amount: "450.00",
                  currencyCode: "TRY",
                },
              },
              currentTotalDiscountsSet: {
                shopMoney: {
                  amount: "0.00",
                  currencyCode: "TRY",
                },
              },
              currentTotalTaxSet: {
                shopMoney: {
                  amount: "68.64",
                  currencyCode: "TRY",
                },
              },
              shippingAddress: null,
              billingAddress: null,
              lineItems: {
                nodes: [{
                  id: "gid://shopify/LineItem/20158028513347",
                  name: "3 Yollu - 30mm",
                  sku: "DSDST-4Y-7KQ30",
                  quantity: 1,
                  currentQuantity: 1,
                  taxable: true,
                  originalUnitPriceSet: {
                    shopMoney: {
                      amount: "450.00",
                      currencyCode: "TRY",
                    },
                  },
                  discountedUnitPriceAfterAllDiscountsSet: {
                    shopMoney: {
                      amount: "450.00",
                      currencyCode: "TRY",
                    },
                  },
                  totalDiscountSet: {
                    shopMoney: {
                      amount: "0.00",
                      currencyCode: "TRY",
                    },
                  },
                  taxLines: [{
                    rate: 0.18,
                    priceSet: {
                      shopMoney: {
                        amount: "68.64",
                        currencyCode: "TRY",
                      },
                    },
                  }],
                  variant: {
                    id: "gid://shopify/ProductVariant/43333979144259",
                    title: "30mm",
                    inventoryItem: {
                      id: "gid://shopify/InventoryItem/45448261075011",
                    },
                  },
                }],
              },
            }],
            pageInfo: {
              hasNextPage: false,
              endCursor: null,
            },
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`UNEXPECTED_REQUEST:${url}`);
  };

  const transport = new ShopifyGatewayTransport(
    config,
    fakeFetch as typeof fetch,
  );

  const summary = await transport.poll({
    gateway: gateway as any,
    accountId: "shopify:production:2b6rcy-br",
    query: "name:#1006",
    serviceActorId: "shopify-poller:test",
    operationIdPrefix: "compat-test",
    receivedAt: "2026-09-26T00:00:00Z",
    maxPages: 1,
  });

  assert.equal(summary.duplicate, 1);
  assert.equal(captured.length, 1);

  assert.deepEqual(
    Object.keys(captured[0].rawPayload).sort(),
    ["orderId", "orderName", "provider", "recipient"],
  );

  assert.equal(
    captured[0].rawPayload.orderId,
    "gid://shopify/Order/8408602148931",
  );

  assert.equal(recoveryCalls, 0);

  // Same provider event, but the existing local order is still EXCEPTION.
  // Poll must invoke durable safe auto recovery instead of treating it as
  // a terminal duplicate.
  recoverException = true;

  const recoverySummary =
    await transport.poll({
      gateway: gateway as any,
      accountId:
        "shopify:production:2b6rcy-br",
      query: "name:#1006",
      serviceActorId:
        "shopify-poller:test",
      operationIdPrefix:
        "compat-recovery-test",
      receivedAt:
        "2026-09-26T00:00:15Z",
      maxPages: 1,
    });

  assert.equal(recoverySummary.accepted, 1);
  assert.equal(recoverySummary.duplicate, 0);
  assert.equal(recoverySummary.exception, 0);
  assert.equal(recoveryCalls, 1);
});

# Panel module boundaries

The Panel remains one Express process and one SQLite database. Modules are extracted in small, test-gated phases; route URLs and response contracts stay in place.

- Phase 1 — `auth`: login/change-password/current-user routes, JWT/static-key middleware, write protection, admin guard, and permission normalization.
- Phase 2 — `warehouse`: Warehouse API composition and print-worker lifecycle around the existing Warehouse services/routes.
- Phase 3 — `products`: central/BOM stock calculations and compatibility hydration.
- Phase 4 — `integrations`: Panel API key HMAC ownership.
- Phase 5 — `backup`: backup policy defaults and safe configuration bounds.
- Phase 6 — `finance`: active exchange-rate access behind a database-bound reader.
- Phase 7 — `marketplaces`: Trendyol environment/configuration routing.

The route registrations that still coordinate multiple domains deliberately stay in `server.ts`; their domain policy and stateful services now have explicit module seams. Future route moves can use these seams without changing URLs, transaction ownership, or the single-process architecture.

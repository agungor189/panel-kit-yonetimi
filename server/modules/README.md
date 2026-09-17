# Panel module boundaries

The Panel remains one Express process and one SQLite database. Modules are extracted in small, test-gated phases; route URLs and response contracts stay in place.

- Phase 1 — `auth`: login/change-password/current-user routes, JWT/static-key middleware, write protection, admin guard, and permission normalization.
- Phase 2 — `warehouse`: Warehouse API composition and print-worker lifecycle around the existing Warehouse services/routes.
- Phase 3 — `products`: central/BOM stock calculations and compatibility hydration.

The remaining large finance, marketplace, backup, and integration route groups deliberately stay in `server.ts` for the next phases. They share transaction and upload state with several legacy routes, so moving them independently is safer than an all-at-once rewrite. The next extraction order is `integrations`, `backup`, `marketplaces`, then `finance`; each phase must run test, typecheck, and build before continuing.


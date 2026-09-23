import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import { initializeDatabase } from "../db/initialize.js";
import { CatalogService } from "../modules/catalog/catalogService.js";
import { ProcurementService } from "../modules/procurement/procurementService.js";
import { authoredKitContentHash, type KitPublicationProposal } from "../modules/kits/publishedKitService.js";
import { createKitPublicationV1Router } from "./kitPublicationV1Routes.js";

function seededDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initializeDatabase(db);
  const catalog = new CatalogService(db);
  catalog.createProduct({ id: "connector", sku: "CON-API", title: "Connector", catalog_type: "connector", base_uom_code: "piece" });
  catalog.createProduct({ id: "profile", sku: "PRO-API", title: "Profile", catalog_type: "profile", base_uom_code: "meter", profile: { material: "ALUMINUM", form: "square", width_mm: "40", height_mm: "40", wall_thickness_mm: "2", standard_purchase_lengths_mm: [3000], custom_length_allowed: false } });
  const procurement = new ProcurementService(db);
  procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
  procurement.createPurchase({ id: "purchase-connector", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST", invoiceNumber: "INV-C", invoiceDate: "2026-09-23", lines: [{ id: "line-connector", productId: "connector", quantity: "10", quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }] });
  procurement.finalizeAcquisitionCosts("purchase-connector", { allocations: [] });
  procurement.createPurchase({ id: "purchase-profile", supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST", invoiceNumber: "INV-P", invoiceDate: "2026-09-23", lines: [{ id: "line-profile", productId: "profile", quantity: "1", quoteBasis: "profile_bar", profileLengthMm: 3000, supplierUnitPriceMinor: 3000, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }] });
  procurement.finalizeAcquisitionCosts("purchase-profile", { allocations: [] });
  return db;
}

function proposal(db: Database.Database): KitPublicationProposal {
  const ref = (id: string) => String(db.prepare("SELECT catalog_version_ref FROM products WHERE id=?").pluck().get(id));
  const value = {
    workspaceKitId: "workspace-api", workspaceVersionId: "workspace-api-v1", publishedKitId: null,
    sku: "KIT-API", title: "API Kit", components: [{ productId: "connector", catalogVersionRef: ref("connector"), quantityBaseInt: 2, role: "CONNECTOR" }],
    profileCutPlan: { profileProductId: "profile", catalogVersionRef: ref("profile"), cuts: [{ quantity: 1, lengthMm: 1800 }] },
    packagingPlan: { packageCount: 1, instructionVersion: "packing:v1", installationGuideVersion: "guide:v1", packages: [{ packageNumber: 1, items: [{ productId: "connector", quantityBaseInt: 2 }, { productId: "profile", quantityBaseInt: 1803 }] }] },
    finalSalePriceMinor: 4000, currency: "TRY" as const,
  };
  return { ...value, authoredContentHash: authoredKitContentHash(value) };
}

async function serve(db: Database.Database, user: any) {
  const app = express();
  app.use(express.json());
  app.use("/api/kit-publications/v1", createKitPublicationV1Router({
    db,
    authenticateService: (req, _res, next) => { req.panelApiKey = { id: "kit-studio", name: "Kit Studio", permissions: ["kit-publications:write"] }; next(); },
    authenticateUserToken: (token) => token === "valid" ? user : null,
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not start");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("Panel publication API requires authorized human and replays one audited publish", async () => {
  const db = seededDb();
  const { server, baseUrl } = await serve(db, { id: "approver", username: "approver", role: "admin", permissions: {}, must_change_password: false });
  try {
    const input = proposal(db);
    const headers = { "content-type": "application/json", authorization: "Bearer valid" };
    const preview = await (await fetch(`${baseUrl}/api/kit-publications/v1/preview`, { method: "POST", headers, body: JSON.stringify(input) })).json() as any;
    const publishBody = { proposal: input, approvedContentHash: preview.data.contentHash, approvedPolicyHash: preview.data.corePolicyHash };
    const first = await fetch(`${baseUrl}/api/kit-publications/v1/publish`, { method: "POST", headers: { ...headers, "x-operation-id": "api-publish-1" }, body: JSON.stringify(publishBody) });
    assert.equal(first.status, 201);
    assert.equal((await first.json() as any).idempotent, false);
    const replay = await fetch(`${baseUrl}/api/kit-publications/v1/publish`, { method: "POST", headers: { ...headers, "x-operation-id": "api-publish-1" }, body: JSON.stringify(publishBody) });
    assert.equal(replay.status, 201);
    assert.equal((await replay.json() as any).idempotent, true);
    assert.equal(Number(db.prepare("SELECT COUNT(*) FROM published_kit_versions").pluck().get()), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) FROM command_audit_log WHERE command_type='kit.publication.publish.v1'").pluck().get()), 1);
    const denied = await fetch(`${baseUrl}/api/kit-publications/v1/preview`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer invalid" }, body: JSON.stringify(input) });
    assert.equal(denied.status, 401);
  } finally { server.close(); db.close(); }
});

test("Panel publication API denies a human without kits:approve", async () => {
  const db = seededDb();
  const { server, baseUrl } = await serve(db, { id: "viewer", username: "viewer", role: "user", permissions: { "kits:view": true }, must_change_password: false });
  try {
    const response = await fetch(`${baseUrl}/api/kit-publications/v1/preview`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer valid" }, body: JSON.stringify(proposal(db)) });
    assert.equal(response.status, 403);
  } finally { server.close(); db.close(); }
});

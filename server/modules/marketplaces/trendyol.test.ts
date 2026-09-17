import assert from "node:assert/strict";
import test from "node:test";
import { defaultTrendyolConfig, normalizeTrendyolEnvironment, trendyolBaseUrl } from "./trendyol.js";

test("marketplace module keeps Trendyol stage/prod routing contract", () => {
  assert.equal(defaultTrendyolConfig.environment, "stage");
  assert.equal(normalizeTrendyolEnvironment("production"), "prod");
  assert.equal(normalizeTrendyolEnvironment("unexpected"), "stage");
  assert.equal(trendyolBaseUrl("prod"), "https://apigw.trendyol.com");
  assert.equal(trendyolBaseUrl("stage"), "https://stageapigw.trendyol.com");
});


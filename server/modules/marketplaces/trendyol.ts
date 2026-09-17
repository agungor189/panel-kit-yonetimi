export type TrendyolEnvironment = "stage" | "prod";

export const defaultTrendyolConfig = {
  enabled: false,
  environment: "stage" as TrendyolEnvironment,
  api_key_id: "",
  sync_window_days: 14,
  store_front_code: "",
};

export const normalizeTrendyolEnvironment = (value: unknown): TrendyolEnvironment =>
  value === "prod" || value === "production" || value === "live" ? "prod" : "stage";

export const trendyolBaseUrl = (environment: TrendyolEnvironment) =>
  environment === "prod" ? "https://apigw.trendyol.com" : "https://stageapigw.trendyol.com";


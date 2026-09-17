export type BackupConfig = {
  enabled: boolean;
  run_at: string;
  retention_days: number;
  include_uploads: boolean;
  uploads_strategy: "smart" | "full" | "incremental" | "none";
  weekly_full_day: number;
};

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  enabled: true,
  run_at: "03:00",
  retention_days: 7,
  include_uploads: true,
  uploads_strategy: "smart",
  weekly_full_day: 0,
};

export function normalizeBackupConfig(input: unknown): BackupConfig {
  const merged = {
    ...DEFAULT_BACKUP_CONFIG,
    ...(input && typeof input === "object" && !Array.isArray(input) ? input : {}),
  } as Record<string, unknown>;
  const runAt = String(merged.run_at || DEFAULT_BACKUP_CONFIG.run_at);
  const strategy = ["smart", "full", "incremental", "none"].includes(String(merged.uploads_strategy))
    ? String(merged.uploads_strategy)
    : DEFAULT_BACKUP_CONFIG.uploads_strategy;
  return {
    enabled: Boolean(merged.enabled),
    run_at: /^([01]\d|2[0-3]):[0-5]\d$/.test(runAt) ? runAt : DEFAULT_BACKUP_CONFIG.run_at,
    retention_days: Math.min(30, Math.max(1, Math.trunc(Number(merged.retention_days) || DEFAULT_BACKUP_CONFIG.retention_days))),
    include_uploads: Boolean(merged.include_uploads),
    uploads_strategy: strategy as BackupConfig["uploads_strategy"],
    weekly_full_day: Math.min(6, Math.max(0, Math.trunc(Number(merged.weekly_full_day) || 0))),
  };
}


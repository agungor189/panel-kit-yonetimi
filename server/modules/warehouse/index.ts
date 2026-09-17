import type Database from "better-sqlite3";
import type { Express, RequestHandler } from "express";
import { createWarehouseRouter } from "../../routes/warehouseRoutes.js";
import { startPrintQueueWorker } from "../../services/printQueueWorker.js";

type WarehouseUser = {
  id: string;
  username: string;
  role: string;
  permissions: Record<string, unknown>;
  must_change_password: boolean;
};

type WarehouseModuleDependencies = {
  app: Express;
  db: Database.Database;
  hashApiKey: (clearKey: string) => string;
  logActivity: (
    action: string,
    entityType: string,
    entityId: string,
    details?: unknown,
    actorId?: string,
  ) => void;
  uploadsDir: string;
  authenticateUserToken: (token: string) => WarehouseUser | null;
  rateLimiters: RequestHandler[];
};

export function mountWarehouseModule({
  app,
  db,
  hashApiKey,
  logActivity,
  uploadsDir,
  authenticateUserToken,
  rateLimiters,
}: WarehouseModuleDependencies) {
  app.use(
    "/api/warehouse/v1",
    ...rateLimiters,
    createWarehouseRouter({ db, hashApiKey, logActivity, uploadsDir, authenticateUserToken }),
  );
  return startPrintQueueWorker(db);
}


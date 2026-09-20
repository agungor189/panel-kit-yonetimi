import Database from "better-sqlite3";
import { CommandExecutor } from "../commands/commandFoundation.js";
import { InventoryService, InventoryValidationError } from "./inventoryService.js";

const [databasePath, suffix] = process.argv.slice(2);
const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
try {
  const inventory = new InventoryService(db);
  try {
    const outcome = new CommandExecutor(db).execute({
      operationId: `reserve-${suffix}`,
      commandType: "inventory.order.reserve.v1",
      payload: { orderId: `order-${suffix}`, quantityBaseInt: 1 },
      actor: { human: { id: `user-${suffix}` } },
      authorization: { decision: "ALLOW", capability: "inventory:reserve" },
    }, () => ({ statusCode: 201, body: inventory.reserveOrder({
      reservationId: `reservation-${suffix}`,
      orderId: `order-${suffix}`,
      lines: [{ productId: "part", quantityBaseInt: 1 }],
      operationId: `reserve-${suffix}`,
    }) }));
    process.stdout.write(JSON.stringify({ status: outcome.result.statusCode }));
  } catch (error) {
    if (!(error instanceof InventoryValidationError)) throw error;
    process.stdout.write(JSON.stringify({ code: error.code }));
  }
} finally {
  db.close();
}

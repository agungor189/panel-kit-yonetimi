import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CommandActor = {
  human?: { id: string; name?: string | null };
  service?: { id: string; name?: string | null };
};

export type CommandRequest = {
  operationId: string;
  commandType: string;
  payload: unknown;
  actor: CommandActor;
  authorization: {
    decision: "ALLOW";
    capability: string;
  };
  correlationId?: string | null;
  requestId?: string | null;
  requestMetadata?: Record<string, unknown>;
};

export type CommandResult<T extends JsonValue = JsonValue> = {
  statusCode: number;
  body: T;
};

export type OutboxMessage = {
  topic: string;
  eventType: string;
  payload: unknown;
  aggregateType?: string | null;
  aggregateId?: string | null;
  availableAt?: string | null;
};

export type CommandContext = {
  addOutbox(message: OutboxMessage): void;
};

export type CommandOutcome<T extends JsonValue = JsonValue> = {
  result: CommandResult<T>;
  replayed: boolean;
};

export class CommandFoundationError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class OperationConflictError extends CommandFoundationError {
  constructor() {
    super(409, "IDEMPOTENCY_KEY_CONFLICT", "Operation key was already committed with a different canonical payload.");
  }
}

const identifier = (value: unknown, field: string, maxLength = 200): string => {
  if (typeof value !== "string") throw new CommandFoundationError(400, "INVALID_COMMAND", `${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CommandFoundationError(400, "INVALID_COMMAND", `${field} is invalid.`);
  }
  return normalized;
};

const optionalText = (value: unknown, field: string, maxLength: number): string | null => {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, field, maxLength);
};

const canonicalize = (value: unknown, path = "payload", seen = new Set<object>()): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CommandFoundationError(400, "INVALID_COMMAND", `${path} must contain only finite JSON numbers.`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new CommandFoundationError(400, "INVALID_COMMAND", `${path} must be JSON-compatible.`);
  }
  if (seen.has(value)) throw new CommandFoundationError(400, "INVALID_COMMAND", `${path} must not contain cycles.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item, index) => canonicalize(item, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CommandFoundationError(400, "INVALID_COMMAND", `${path} must contain only plain JSON objects.`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, seen)}`
    )).join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

export const canonicalPayloadHash = (payload: unknown): string => createHash("sha256")
  .update(canonicalize(payload), "utf8")
  .digest("hex");

const canonicalJson = (value: unknown, field: string): string => canonicalize(value, field);

type StoredOperation = {
  id: string;
  payload_hash: string;
  result_status_code: number;
  result_json: string;
};

export class CommandExecutor {
  constructor(private readonly db: Database.Database) {}

  execute<T extends JsonValue>(
    request: CommandRequest,
    handler: (context: CommandContext) => CommandResult<T>,
  ): CommandOutcome<T> {
    const operationId = identifier(request.operationId, "operationId");
    const commandType = identifier(request.commandType, "commandType");
    const humanActorId = request.actor.human ? identifier(request.actor.human.id, "actor.human.id") : null;
    const serviceActorId = request.actor.service ? identifier(request.actor.service.id, "actor.service.id") : null;
    if (!humanActorId && !serviceActorId) {
      throw new CommandFoundationError(400, "ACTOR_REQUIRED", "A human or service actor is required.");
    }
    const actorScope = canonicalPayloadHash({ humanActorId, serviceActorId });
    const payloadHash = canonicalPayloadHash(request.payload);
    const correlationId = optionalText(request.correlationId, "correlationId", 200);
    const requestId = optionalText(request.requestId, "requestId", 200);
    const capability = identifier(request.authorization.capability, "authorization.capability");
    const requestMetadataJson = request.requestMetadata === undefined
      ? null
      : canonicalJson(request.requestMetadata, "requestMetadata");
    if (requestMetadataJson && Buffer.byteLength(requestMetadataJson, "utf8") > 4096) {
      throw new CommandFoundationError(400, "REQUEST_METADATA_TOO_LARGE", "Request metadata exceeds 4096 bytes.");
    }

    const executeTransaction = this.db.transaction((): CommandOutcome<T> => {
      const existing = this.db.prepare(`
        SELECT id, payload_hash, result_status_code, result_json
        FROM command_operations
        WHERE actor_scope = ? AND command_type = ? AND operation_id = ?
      `).get(actorScope, commandType, operationId) as StoredOperation | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new OperationConflictError();
        return {
          result: {
            statusCode: existing.result_status_code,
            body: JSON.parse(existing.result_json) as T,
          },
          replayed: true,
        };
      }

      const outbox: OutboxMessage[] = [];
      const result = handler({ addOutbox: (message) => { outbox.push(message); } });
      if (!Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599) {
        throw new CommandFoundationError(500, "INVALID_COMMAND_RESULT", "Command result statusCode must be an HTTP status code.");
      }
      const resultJson = canonicalJson(result.body, "result.body");
      const resultHash = createHash("sha256").update(resultJson, "utf8").digest("hex");
      const operationRecordId = randomUUID();

      this.db.prepare(`
        INSERT INTO command_operations (
          id, actor_scope, operation_id, command_type, payload_hash,
          result_status_code, result_json, result_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(operationRecordId, actorScope, operationId, commandType, payloadHash, result.statusCode, resultJson, resultHash);

      this.db.prepare(`
        INSERT INTO command_audit_log (
          id, operation_record_id, operation_id, human_actor_id, human_actor_name,
          service_actor_id, service_actor_name, command_type, payload_hash,
          authorization_decision, capability, result_status_code, result_hash,
          correlation_id, request_id, request_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ALLOW', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), operationRecordId, operationId, humanActorId,
        optionalText(request.actor.human?.name, "actor.human.name", 200),
        serviceActorId, optionalText(request.actor.service?.name, "actor.service.name", 200),
        commandType, payloadHash, capability, result.statusCode, resultHash,
        correlationId, requestId, requestMetadataJson,
      );

      const insertOutbox = this.db.prepare(`
        INSERT INTO command_outbox (
          id, operation_record_id, event_index, topic, event_type,
          aggregate_type, aggregate_id, payload_json, payload_hash, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
      `);
      outbox.forEach((message, eventIndex) => {
        const topic = identifier(message.topic, `outbox[${eventIndex}].topic`);
        const eventType = identifier(message.eventType, `outbox[${eventIndex}].eventType`);
        const aggregateType = optionalText(message.aggregateType, `outbox[${eventIndex}].aggregateType`, 200);
        const aggregateId = optionalText(message.aggregateId, `outbox[${eventIndex}].aggregateId`, 200);
        const payloadJson = canonicalJson(message.payload, `outbox[${eventIndex}].payload`);
        const outboxPayloadHash = createHash("sha256").update(payloadJson, "utf8").digest("hex");
        const availableAt = optionalText(message.availableAt, `outbox[${eventIndex}].availableAt`, 50);
        insertOutbox.run(
          randomUUID(), operationRecordId, eventIndex, topic, eventType,
          aggregateType, aggregateId, payloadJson, outboxPayloadHash, availableAt,
        );
      });

      return {
        result: { statusCode: result.statusCode, body: JSON.parse(resultJson) as T },
        replayed: false,
      };
    });

    return executeTransaction.immediate();
  }
}

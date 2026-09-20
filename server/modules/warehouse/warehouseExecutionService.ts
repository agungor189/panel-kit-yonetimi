import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalPayloadHash } from "../commands/commandFoundation.js";
import { InventoryService } from "../inventory/inventoryService.js";

type StorageRole = "PICKING" | "RESERVE" | "MIXED" | "QUARANTINE";
type PackageDisposition = "ACCEPTED" | "DAMAGED";

type DepthInput = { code: string; isFront: boolean; priority: number };
type LevelInput = {
  number: number;
  role?: StorageRole;
  allowMixedSku?: boolean;
  allowMixedLot?: boolean;
  maxWeightGrams?: number | null;
  placementPriority?: number;
  lastResort?: boolean;
  heavyPenalty?: number;
  active?: boolean;
};
type PositionInput = Omit<LevelInput, "number"> & { level: number; position: number };
type RackInput = {
  code: string;
  levelCount: number;
  positionCount: number;
  depths: DepthInput[];
  role: StorageRole;
  allowMixedSku: boolean;
  allowMixedLot: boolean;
  maxWeightGrams?: number | null;
  placementPriority: number;
  lastResort?: boolean;
  active?: boolean;
  levels?: LevelInput[];
  positions?: PositionInput[];
};

export type WarehouseTopologyInput = {
  id: string;
  name: string;
  codeTemplate: string;
  racks: RackInput[];
};

type ReceiptPackageInput = {
  id: string;
  code: string;
  quantityBaseInt: number;
  targetQuantityBaseInt?: number;
  weightGrams?: number;
  disposition?: PackageDisposition;
};

export class WarehouseExecutionError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = "WarehouseExecutionError";
  }
}

const requiredText = (value: unknown, field: string, max = 200) => {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return normalized;
};

const nonNegativeInteger = (value: unknown, field: string) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new WarehouseExecutionError("INVALID_BASE_QUANTITY", `${field} must be a non-negative base-unit integer.`);
  }
  return Number(value);
};

const positiveInteger = (value: unknown, field: string) => {
  const result = nonNegativeInteger(value, field);
  if (result === 0) throw new WarehouseExecutionError("INVALID_BASE_QUANTITY", `${field} must be positive.`);
  return result;
};

const timestamp = (value: unknown, field: string) => {
  const normalized = requiredText(value, field, 50);
  if (!Number.isFinite(new Date(normalized).getTime())) {
    throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", `${field} must be an ISO timestamp.`);
  }
  return normalized;
};

const boolInt = (value: boolean | undefined, fallback: boolean) => (value ?? fallback) ? 1 : 0;
const role = (value: unknown, field: string): StorageRole => {
  if (!["PICKING", "RESERVE", "MIXED", "QUARANTINE"].includes(String(value))) {
    throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", `${field} is invalid.`);
  }
  return value as StorageRole;
};

const slotCode = (template: string, values: { rack: string; level: number; position: number; depth: string }) =>
  template
    .replaceAll("{rack}", values.rack)
    .replaceAll("{level}", String(values.level))
    .replaceAll("{position}", String(values.position))
    .replaceAll("{depth}", values.depth);

type SlotRow = {
  id: string;
  code: string;
  rack_code: string;
  level_number: number;
  position_number: number;
  depth_code: string;
  depth_index: number;
  is_front: number;
  role: StorageRole;
  allow_mixed_sku: number;
  allow_mixed_lot: number;
  max_weight_grams: number | null;
  placement_priority: number;
  last_resort: number;
  heavy_penalty: number;
};

const mapSlot = (row: SlotRow) => ({
  id: row.id,
  code: row.code,
  rackCode: row.rack_code,
  levelNumber: Number(row.level_number),
  positionNumber: Number(row.position_number),
  depthCode: row.depth_code,
  depthIndex: Number(row.depth_index),
  isFront: Boolean(row.is_front),
  role: row.role,
  allowMixedSku: Boolean(row.allow_mixed_sku),
  allowMixedLot: Boolean(row.allow_mixed_lot),
  maxWeightGrams: row.max_weight_grams === null ? null : Number(row.max_weight_grams),
  placementPriority: Number(row.placement_priority),
  lastResort: Boolean(row.last_resort),
  heavyPenalty: Number(row.heavy_penalty),
});

export class WarehouseExecutionService {
  constructor(private readonly db: Database.Database) {}

  configureTopology(input: WarehouseTopologyInput) {
    const topologyId = requiredText(input.id, "id");
    const name = requiredText(input.name, "name");
    const template = requiredText(input.codeTemplate, "codeTemplate", 300);
    for (const token of ["{rack}", "{level}", "{position}", "{depth}"]) {
      if (!template.includes(token)) throw new WarehouseExecutionError("INVALID_LOCATION_CODE_TEMPLATE", `codeTemplate must include ${token}.`);
    }
    if (!Array.isArray(input.racks) || input.racks.length === 0) {
      throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", "At least one rack is required.");
    }
    const configHash = canonicalPayloadHash(input);
    return this.db.transaction(() => {
      const previousTopology = this.db.prepare("SELECT id FROM warehouse_topologies WHERE active=1").get() as { id: string } | undefined;
      this.db.prepare(`INSERT INTO warehouse_topologies
        (id,name,code_template,config_json,config_hash,active) VALUES (?,?,?,?,?,0)`)
        .run(topologyId, name, template, JSON.stringify(input), configHash);
      const rackCodes = new Set<string>();
      const locationCodes = new Set<string>();
      const insertRack = this.db.prepare(`INSERT INTO warehouse_rack_configs
        (id,topology_id,rack_code,level_count,position_count,depth_count,role,allow_mixed_sku,allow_mixed_lot,
         max_weight_grams,placement_priority,last_resort,active,config_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertLevel = this.db.prepare(`INSERT INTO warehouse_level_configs
        (id,topology_id,rack_code,level_number,role,allow_mixed_sku,allow_mixed_lot,max_weight_grams,
         placement_priority,last_resort,heavy_penalty,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertPosition = this.db.prepare(`INSERT INTO warehouse_position_configs
        (id,topology_id,rack_code,level_number,position_number,role,allow_mixed_sku,allow_mixed_lot,
         max_weight_grams,placement_priority,last_resort,heavy_penalty,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertSlot = this.db.prepare(`INSERT INTO warehouse_location_slots
        (id,topology_id,code,rack_code,level_number,position_number,depth_code,depth_index,is_front,role,
         allow_mixed_sku,allow_mixed_lot,max_weight_grams,placement_priority,last_resort,heavy_penalty,active)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const updateSlot = this.db.prepare(`UPDATE warehouse_location_slots SET
        topology_id=?,rack_code=?,level_number=?,position_number=?,depth_code=?,depth_index=?,is_front=?,role=?,
        allow_mixed_sku=?,allow_mixed_lot=?,max_weight_grams=?,placement_priority=?,last_resort=?,heavy_penalty=?,
        active=? WHERE id=?`);

      for (const [rackIndex, rackInput] of input.racks.entries()) {
        const rackCode = requiredText(rackInput.code, `racks[${rackIndex}].code`, 80).toUpperCase();
        if (rackCodes.has(rackCode)) throw new WarehouseExecutionError("DUPLICATE_RACK_CODE", `Rack ${rackCode} is duplicated.`);
        rackCodes.add(rackCode);
        const levelCount = positiveInteger(rackInput.levelCount, `racks[${rackIndex}].levelCount`);
        const positionCount = positiveInteger(rackInput.positionCount, `racks[${rackIndex}].positionCount`);
        if (positionCount !== 6) {
          throw new WarehouseExecutionError("INVALID_POSITION_COUNT", `Rack ${rackCode} must define exactly six positions per level.`);
        }
        if (!Array.isArray(rackInput.depths) || rackInput.depths.length === 0) {
          throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", `Rack ${rackCode} requires depth slots.`);
        }
        const rackRole = role(rackInput.role, `racks[${rackIndex}].role`);
        const rackMixedSku = boolInt(rackInput.allowMixedSku, false);
        const rackMixedLot = boolInt(rackInput.allowMixedLot, false);
        const rackWeight = rackInput.maxWeightGrams == null ? null : positiveInteger(rackInput.maxWeightGrams, "maxWeightGrams");
        const rackPriority = nonNegativeInteger(rackInput.placementPriority, "placementPriority");
        const rackLast = boolInt(rackInput.lastResort, false);
        const rackActive = boolInt(rackInput.active, true);
        const depths = rackInput.depths.map((depth, depthIndex) => ({
          code: requiredText(depth.code, `racks[${rackIndex}].depths[${depthIndex}].code`, 80).toUpperCase(),
          isFront: Boolean(depth.isFront),
          priority: nonNegativeInteger(depth.priority, "depth.priority"),
        }));
        if (new Set(depths.map(({ code }) => code)).size !== depths.length || depths.filter(({ isFront }) => isFront).length !== 1) {
          throw new WarehouseExecutionError("INVALID_DEPTH_CONFIGURATION", `Rack ${rackCode} requires unique depths and exactly one front depth.`);
        }
        insertRack.run(randomUUID(), topologyId, rackCode, levelCount, positionCount, depths.length, rackRole,
          rackMixedSku, rackMixedLot, rackWeight, rackPriority, rackLast, rackActive, JSON.stringify(rackInput));

        for (let levelNumber = 1; levelNumber <= levelCount; levelNumber += 1) {
          const levelOverride = rackInput.levels?.find((item) => item.number === levelNumber);
          const levelRole = role(levelOverride?.role ?? rackRole, "level.role");
          const levelMixedSku = boolInt(levelOverride?.allowMixedSku, Boolean(rackMixedSku));
          const levelMixedLot = boolInt(levelOverride?.allowMixedLot, Boolean(rackMixedLot));
          const levelWeight = levelOverride?.maxWeightGrams === undefined ? rackWeight
            : levelOverride.maxWeightGrams === null ? null : positiveInteger(levelOverride.maxWeightGrams, "level.maxWeightGrams");
          const levelPriority = levelOverride?.placementPriority === undefined ? rackPriority : nonNegativeInteger(levelOverride.placementPriority, "level.placementPriority");
          const levelLast = boolInt(levelOverride?.lastResort, Boolean(rackLast));
          const levelPenalty = nonNegativeInteger(levelOverride?.heavyPenalty ?? 0, "level.heavyPenalty");
          const levelActive = boolInt(levelOverride?.active, Boolean(rackActive));
          insertLevel.run(randomUUID(), topologyId, rackCode, levelNumber, levelRole, levelMixedSku, levelMixedLot,
            levelWeight, levelPriority, levelLast, levelPenalty, levelActive);

          for (let positionNumber = 1; positionNumber <= positionCount; positionNumber += 1) {
            const positionOverride = rackInput.positions?.find((item) => item.level === levelNumber && item.position === positionNumber);
            const positionRole = role(positionOverride?.role ?? levelRole, "position.role");
            const positionMixedSku = boolInt(positionOverride?.allowMixedSku, Boolean(levelMixedSku));
            const positionMixedLot = boolInt(positionOverride?.allowMixedLot, Boolean(levelMixedLot));
            const positionWeight = positionOverride?.maxWeightGrams === undefined ? levelWeight
              : positionOverride.maxWeightGrams === null ? null : positiveInteger(positionOverride.maxWeightGrams, "position.maxWeightGrams");
            const positionPriority = positionOverride?.placementPriority === undefined ? levelPriority : nonNegativeInteger(positionOverride.placementPriority, "position.placementPriority");
            const positionLast = boolInt(positionOverride?.lastResort, Boolean(levelLast));
            const positionPenalty = nonNegativeInteger(positionOverride?.heavyPenalty ?? levelPenalty, "position.heavyPenalty");
            const positionActive = boolInt(positionOverride?.active, Boolean(levelActive));
            insertPosition.run(randomUUID(), topologyId, rackCode, levelNumber, positionNumber, positionRole,
              positionMixedSku, positionMixedLot, positionWeight, positionPriority, positionLast, positionPenalty, positionActive);

            for (const [depthIndex, depth] of depths.entries()) {
              const code = slotCode(template, { rack: rackCode, level: levelNumber, position: positionNumber, depth: depth.code });
              if (locationCodes.has(code)) throw new WarehouseExecutionError("DUPLICATE_LOCATION_CODE", `Location ${code} is duplicated.`);
              locationCodes.add(code);
              const existing = this.db.prepare("SELECT id FROM warehouse_location_slots WHERE code=?").get(code) as { id: string } | undefined;
              if (existing) {
                updateSlot.run(topologyId, rackCode, levelNumber, positionNumber, depth.code, depthIndex,
                  depth.isFront ? 1 : 0, positionRole, positionMixedSku, positionMixedLot, positionWeight,
                  positionPriority + depth.priority, positionLast, positionPenalty, positionActive, existing.id);
              } else {
                insertSlot.run(randomUUID(), topologyId, code, rackCode, levelNumber, positionNumber, depth.code,
                  depthIndex, depth.isFront ? 1 : 0, positionRole, positionMixedSku, positionMixedLot, positionWeight,
                  positionPriority + depth.priority, positionLast, positionPenalty, positionActive);
              }
            }
          }
        }
      }
      if (previousTopology) {
        const removedSlots = this.db.prepare("SELECT id,code FROM warehouse_location_slots WHERE topology_id=?").all(previousTopology.id) as Array<{ id: string; code: string }>;
        for (const removed of removedSlots) {
          const occupied = this.db.prepare(`SELECT 1 FROM warehouse_execution_packages
            WHERE current_slot_id=? AND remaining_quantity_base_int>0 LIMIT 1`).get(removed.id);
          if (occupied) {
            throw new WarehouseExecutionError("TOPOLOGY_GEOMETRY_OCCUPIED", `Occupied location ${removed.code} cannot be removed from warehouse geometry.`, 409);
          }
          this.db.prepare("UPDATE warehouse_location_slots SET active=0 WHERE id=?").run(removed.id);
        }
      }
      this.db.prepare("UPDATE warehouse_topologies SET active=0,updated_at=CURRENT_TIMESTAMP WHERE active=1 AND id<>?").run(topologyId);
      this.db.prepare("UPDATE warehouse_topologies SET active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(topologyId);
      return this.getTopology();
    }).immediate();
  }

  getTopology() {
    const active = this.db.prepare("SELECT id,name,code_template,config_hash,created_at,updated_at FROM warehouse_topologies WHERE active=1").get() as any;
    if (!active) throw new WarehouseExecutionError("WAREHOUSE_TOPOLOGY_NOT_CONFIGURED", "Warehouse topology is not configured.", 409);
    const racks = (this.db.prepare(`SELECT rack_code,level_count,position_count,depth_count,role,allow_mixed_sku,
      allow_mixed_lot,max_weight_grams,placement_priority,last_resort,active FROM warehouse_rack_configs
      WHERE topology_id=? ORDER BY rack_code`).all(active.id) as any[]).map((row) => ({
      rackCode: row.rack_code, levelCount: Number(row.level_count), positionCount: Number(row.position_count),
      depthCount: Number(row.depth_count), role: row.role, allowMixedSku: Boolean(row.allow_mixed_sku),
      allowMixedLot: Boolean(row.allow_mixed_lot), maxWeightGrams: row.max_weight_grams === null ? null : Number(row.max_weight_grams),
      placementPriority: Number(row.placement_priority), lastResort: Boolean(row.last_resort), active: Boolean(row.active),
    }));
    const slotCount = Number(this.db.prepare("SELECT COUNT(*) FROM warehouse_location_slots WHERE topology_id=?").pluck().get(active.id));
    return { id: active.id, name: active.name, codeTemplate: active.code_template, configHash: active.config_hash, racks, summary: { rackCount: racks.length, slotCount } };
  }

  configureSettings(input: { watchThresholdPct: number; prepareThresholdPct: number; heavyPackageThresholdGrams: number }) {
    const watch = nonNegativeInteger(input.watchThresholdPct, "watchThresholdPct");
    const prepare = nonNegativeInteger(input.prepareThresholdPct, "prepareThresholdPct");
    const heavy = positiveInteger(input.heavyPackageThresholdGrams, "heavyPackageThresholdGrams");
    if (watch > 100 || prepare > 100 || prepare > watch) {
      throw new WarehouseExecutionError("INVALID_REPLENISHMENT_THRESHOLDS", "prepare threshold must be less than or equal to watch threshold.");
    }
    this.db.prepare(`INSERT INTO warehouse_execution_settings
      (id,watch_threshold_pct,prepare_threshold_pct,heavy_package_threshold_grams,updated_at)
      VALUES ('default',?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET watch_threshold_pct=excluded.watch_threshold_pct,
      prepare_threshold_pct=excluded.prepare_threshold_pct,
      heavy_package_threshold_grams=excluded.heavy_package_threshold_grams,updated_at=CURRENT_TIMESTAMP`).run(watch, prepare, heavy);
    return this.getSettings();
  }

  getSettings() {
    const row = this.db.prepare("SELECT * FROM warehouse_execution_settings WHERE id='default'").get() as any;
    if (!row) {
      throw new WarehouseExecutionError("WAREHOUSE_SETTINGS_NOT_CONFIGURED", "Persisted warehouse execution settings are required.", 409);
    }
    return {
      watchThresholdPct: Number(row.watch_threshold_pct),
      prepareThresholdPct: Number(row.prepare_threshold_pct),
      heavyPackageThresholdGrams: Number(row.heavy_package_threshold_grams),
    };
  }

  approveExcess(input: { approvalId: string; costSnapshotId: string; maximumAcceptedQuantityBaseInt: number; reason: string; operationId: string; approvedAt?: string }) {
    const approvalId = requiredText(input.approvalId, "approvalId");
    const snapshotId = requiredText(input.costSnapshotId, "costSnapshotId");
    const maximum = positiveInteger(input.maximumAcceptedQuantityBaseInt, "maximumAcceptedQuantityBaseInt");
    const reasonText = requiredText(input.reason, "reason", 1000);
    const operationId = requiredText(input.operationId, "operationId");
    const approvedAt = input.approvedAt ? timestamp(input.approvedAt, "approvedAt") : new Date().toISOString();
    const snapshot = this.db.prepare("SELECT quantity_base_int FROM acquisition_lot_cost_snapshots WHERE id=?").get(snapshotId) as any;
    if (!snapshot) throw new WarehouseExecutionError("COST_SNAPSHOT_NOT_FOUND", "The acquisition-cost snapshot was not found.", 404);
    if (maximum <= Number(snapshot.quantity_base_int)) throw new WarehouseExecutionError("INVALID_EXCESS_APPROVAL", "Excess approval must authorize more than the expected quantity.");
    this.db.prepare(`INSERT INTO warehouse_excess_approvals
      (id,acquisition_cost_snapshot_id,maximum_accepted_quantity_base_int,reason,approval_operation_id,approved_at)
      VALUES (?,?,?,?,?,?)`).run(approvalId, snapshotId, maximum, reasonText, operationId, approvedAt);
    return { id: approvalId, costSnapshotId: snapshotId, maximumAcceptedQuantityBaseInt: maximum, reason: reasonText, approvedAt };
  }

  receiveGoods(input: {
    receiptId: string;
    receiptSeriesId: string;
    stageIndex: number;
    isFinal: boolean;
    costSnapshotId: string;
    supplierLotCode: string;
    acceptedQuantityBaseInt: number;
    damagedQuantityBaseInt: number;
    receivedAt: string;
    packages: ReceiptPackageInput[];
    excessApprovalId?: string;
    operationId: string;
  }) {
    const receiptId = requiredText(input.receiptId, "receiptId");
    const seriesId = requiredText(input.receiptSeriesId, "receiptSeriesId");
    if (input.stageIndex !== 1 || input.isFinal !== true) {
      throw new WarehouseExecutionError("PARTIAL_RECEIPT_DISABLED", "Partial multi-stage receipt is currently disabled.", 409);
    }
    const snapshotId = requiredText(input.costSnapshotId, "costSnapshotId");
    const supplierLotCode = requiredText(input.supplierLotCode, "supplierLotCode");
    const accepted = nonNegativeInteger(input.acceptedQuantityBaseInt, "acceptedQuantityBaseInt");
    const damaged = nonNegativeInteger(input.damagedQuantityBaseInt, "damagedQuantityBaseInt");
    const receivedAt = timestamp(input.receivedAt, "receivedAt");
    const operationId = requiredText(input.operationId, "operationId");
    if (!Array.isArray(input.packages)) {
      throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", "packages must be an array.");
    }
    const packages = input.packages.map((item, index) => ({
      id: requiredText(item.id, `packages[${index}].id`),
      code: requiredText(item.code, `packages[${index}].code`, 200).toUpperCase(),
      quantityBaseInt: positiveInteger(item.quantityBaseInt, `packages[${index}].quantityBaseInt`),
      targetQuantityBaseInt: positiveInteger(item.targetQuantityBaseInt ?? item.quantityBaseInt, `packages[${index}].targetQuantityBaseInt`),
      weightGrams: nonNegativeInteger(item.weightGrams ?? 0, `packages[${index}].weightGrams`),
      disposition: (item.disposition ?? "ACCEPTED") as PackageDisposition,
    }));
    if (packages.some(({ disposition }) => !["ACCEPTED", "DAMAGED"].includes(disposition))) {
      throw new WarehouseExecutionError("WAREHOUSE_VALIDATION_FAILED", "Package disposition is invalid.");
    }
    const acceptedPackageQuantity = packages.filter(({ disposition }) => disposition === "ACCEPTED").reduce((sum, item) => sum + item.quantityBaseInt, 0);
    const damagedPackageQuantity = packages.filter(({ disposition }) => disposition === "DAMAGED").reduce((sum, item) => sum + item.quantityBaseInt, 0);
    if (acceptedPackageQuantity !== accepted || damagedPackageQuantity !== damaged) {
      throw new WarehouseExecutionError("PACKAGE_QUANTITY_MISMATCH", "Package quantities must equal accepted and damaged receipt quantities.", 409);
    }

    return this.db.transaction(() => {
      const snapshot = this.db.prepare(`SELECT l.id,l.purchase_order_id,l.purchase_line_id,l.product_id,l.state,
        l.quantity_base_int,l.base_uom_code_snapshot,p.status AS purchase_status
        FROM acquisition_lot_cost_snapshots l JOIN purchase_orders p ON p.id=l.purchase_order_id WHERE l.id=?`).get(snapshotId) as any;
      if (!snapshot) throw new WarehouseExecutionError("COST_SNAPSHOT_NOT_FOUND", "The acquisition-cost snapshot was not found.", 404);
      if (snapshot.state !== "COSTED_PENDING_RECEIPT" || snapshot.purchase_status !== "APPROVED") {
        throw new WarehouseExecutionError("COST_SNAPSHOT_NOT_RECEIVABLE", "Only an approved costed purchase snapshot may be received.", 409);
      }
      if (this.db.prepare("SELECT 1 FROM warehouse_goods_receipts WHERE acquisition_cost_snapshot_id=?").get(snapshotId)) {
        throw new WarehouseExecutionError("RECEIPT_ALREADY_FINALIZED", "This cost snapshot already has a final goods receipt.", 409);
      }
      const expected = Number(snapshot.quantity_base_int);
      const delivered = accepted + damaged;
      const variance = delivered - expected;
      const shortage = Math.max(0, -variance);
      const excess = Math.max(0, variance);
      let approvalId: string | null = null;
      if (excess > 0) {
        if (!input.excessApprovalId) {
          throw new WarehouseExecutionError("EXCESS_APPROVAL_REQUIRED", "Excess receipt requires an explicit authorized approval.", 409);
        }
        approvalId = requiredText(input.excessApprovalId, "excessApprovalId");
        const approval = this.db.prepare(`SELECT id,maximum_accepted_quantity_base_int,receipt_id
          FROM warehouse_excess_approvals WHERE id=? AND acquisition_cost_snapshot_id=?`).get(approvalId, snapshotId) as any;
        if (!approval || approval.receipt_id || Number(approval.maximum_accepted_quantity_base_int) < delivered) {
          throw new WarehouseExecutionError("EXCESS_APPROVAL_REQUIRED", "Excess receipt requires a matching unused authorized approval.", 409);
        }
      }

      const inventoryLotId = accepted > 0 ? `warehouse-lot:${receiptId}` : null;
      if (inventoryLotId) {
        new InventoryService(this.db).receiveCostedLot({
          receiptId,
          costSnapshotId: snapshotId,
          receivedAt,
          location: { id: `RECEIVING:${receiptId}`, kind: "RESERVE" },
          operationId,
          acceptedQuantityBaseInt: accepted,
          lotId: inventoryLotId,
        });
      }
      const status = accepted === 0 ? "QUARANTINE_ONLY" : variance === 0 && damaged === 0 ? "ACCEPTED" : "ACCEPTED_WITH_VARIANCE";
      this.db.prepare(`INSERT INTO warehouse_goods_receipts (
        id,receipt_series_id,stage_index,is_final,partial_policy,acquisition_cost_snapshot_id,purchase_order_id,
        purchase_line_id,product_id,supplier_lot_code,base_uom_code_snapshot,expected_quantity_base_int,
        accepted_quantity_base_int,damaged_quantity_base_int,variance_quantity_base_int,shortage_quantity_base_int,
        excess_quantity_base_int,excess_approval_id,inventory_lot_id,status,receipt_operation_id,received_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, seriesId, 1, 1, "DISABLED", snapshot.id, snapshot.purchase_order_id, snapshot.purchase_line_id, snapshot.product_id,
        supplierLotCode, snapshot.base_uom_code_snapshot, expected, accepted, damaged, variance, shortage, excess,
        approvalId, inventoryLotId, status, operationId, receivedAt,
      );
      if (approvalId) this.db.prepare("UPDATE warehouse_excess_approvals SET receipt_id=? WHERE id=?").run(receiptId, approvalId);
      const insertPackage = this.db.prepare(`INSERT INTO warehouse_execution_packages (
        id,package_code,receipt_id,inventory_lot_id,product_id,supplier_lot_code,purchase_order_id,purchase_line_id,
        acquisition_cost_snapshot_id,base_uom_code_snapshot,initial_quantity_base_int,remaining_quantity_base_int,
        target_quantity_base_int,weight_grams,disposition,status,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of packages) {
        insertPackage.run(item.id, item.code, receiptId, item.disposition === "ACCEPTED" ? inventoryLotId : null,
          snapshot.product_id, supplierLotCode, snapshot.purchase_order_id, snapshot.purchase_line_id, snapshot.id,
          snapshot.base_uom_code_snapshot, item.quantityBaseInt, item.quantityBaseInt, item.targetQuantityBaseInt,
          item.weightGrams, item.disposition, item.disposition === "DAMAGED" ? "QUARANTINE" : "RECEIVED", receivedAt);
      }
      return {
        id: receiptId, receiptSeriesId: seriesId, stageIndex: 1, isFinal: true, partialPolicy: "DISABLED" as const,
        costSnapshotId: snapshotId, purchaseOrderId: snapshot.purchase_order_id, purchaseLineId: snapshot.purchase_line_id,
        productId: snapshot.product_id, supplierLotCode, inventoryLotId, expectedQuantityBaseInt: expected,
        deliveredQuantityBaseInt: delivered, acceptedQuantityBaseInt: accepted, damagedQuantityBaseInt: damaged, varianceQuantityBaseInt: variance,
        shortageQuantityBaseInt: shortage, excessQuantityBaseInt: excess, excessApprovalId: approvalId, status,
        packages: packages.map(({ id }) => this.getPackage(id)),
      };
    }).immediate();
  }

  identifyPackage(input: { packageId: string; labelIdentity: string }) {
    const packageId = requiredText(input.packageId, "packageId");
    const identity = requiredText(input.labelIdentity, "labelIdentity");
    const pkg = this.packageRow(packageId);
    if (pkg.disposition === "ACCEPTED" && pkg.status === "RECEIVED") {
      this.db.prepare("UPDATE warehouse_execution_packages SET label_identity=?,status='LABELED',updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(identity, packageId);
    } else {
      this.db.prepare("UPDATE warehouse_execution_packages SET label_identity=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(identity, packageId);
    }
    return this.getPackage(packageId);
  }

  getPackage(packageIdValue: string) {
    const row = this.packageRow(requiredText(packageIdValue, "packageId"));
    const currentLocationCode = row.current_slot_id
      ? (this.db.prepare("SELECT code FROM warehouse_location_slots WHERE id=?").pluck().get(row.current_slot_id) as string | undefined) ?? null
      : null;
    return {
      id: row.id, code: row.package_code, receiptId: row.receipt_id, inventoryLotId: row.inventory_lot_id,
      productId: row.product_id, supplierLotCode: row.supplier_lot_code, purchaseOrderId: row.purchase_order_id,
      purchaseLineId: row.purchase_line_id, costSnapshotId: row.acquisition_cost_snapshot_id,
      baseUomCode: row.base_uom_code_snapshot, initialQuantityBaseInt: Number(row.initial_quantity_base_int),
      remainingQuantityBaseInt: Number(row.remaining_quantity_base_int), targetQuantityBaseInt: Number(row.target_quantity_base_int),
      weightGrams: Number(row.weight_grams), disposition: row.disposition, labelIdentity: row.label_identity,
      status: row.status, currentSlotId: row.current_slot_id, currentLocationCode,
    };
  }

  getAvailability(productIdValue: string) {
    const productId = requiredText(productIdValue, "productId");
    const row = this.db.prepare(`SELECT p.base_uom_code,COALESCE(SUM(l.on_hand_base_int),0) AS on_hand,
      COALESCE(SUM(l.reserved_base_int),0) AS reserved FROM products p LEFT JOIN inventory_lots l ON l.product_id=p.id
      WHERE p.id=? GROUP BY p.id`).get(productId) as any;
    if (!row) throw new WarehouseExecutionError("PRODUCT_NOT_FOUND", "Product was not found.", 404);
    return { productId, baseUomCode: row.base_uom_code, onHandBaseInt: Number(row.on_hand), reservedBaseInt: Number(row.reserved), availableBaseInt: Number(row.on_hand) - Number(row.reserved) };
  }

  suggestLocation(packageIdValue: string) {
    const candidates = this.listAvailableLocations(packageIdValue);
    if (candidates.length === 0) throw new WarehouseExecutionError("NO_ELIGIBLE_LOCATION", "No eligible warehouse location is available.", 409);
    return candidates[0];
  }

  listAvailableLocations(packageIdValue: string) {
    const packageId = requiredText(packageIdValue, "packageId");
    const pkg = this.packageRow(packageId);
    if (pkg.disposition !== "ACCEPTED") return [];
    const topology = this.db.prepare("SELECT id FROM warehouse_topologies WHERE active=1").get() as any;
    if (!topology) throw new WarehouseExecutionError("WAREHOUSE_TOPOLOGY_NOT_CONFIGURED", "Warehouse topology is not configured.", 409);
    const settings = this.getSettings();
    const moving = Boolean(pkg.current_slot_id);
    const hasPickFace = Boolean(this.db.prepare(`SELECT 1 FROM warehouse_execution_packages p
      JOIN warehouse_location_slots s ON s.id=p.current_slot_id
      WHERE p.product_id=? AND p.id<>? AND p.status='PICKING' AND p.remaining_quantity_base_int>0
        AND s.is_front=1 AND s.role IN ('PICKING','MIXED') LIMIT 1`).get(pkg.product_id, moving ? pkg.id : ""));
    const hasSameLotPickFace = Boolean(this.db.prepare(`SELECT 1 FROM warehouse_execution_packages p
      JOIN warehouse_location_slots s ON s.id=p.current_slot_id
      WHERE p.product_id=? AND p.inventory_lot_id=? AND p.id<>? AND p.status='PICKING'
        AND p.remaining_quantity_base_int>0 AND s.is_front=1 AND s.role IN ('PICKING','MIXED') LIMIT 1`)
      .get(pkg.product_id, pkg.inventory_lot_id, moving ? pkg.id : ""));
    const fifoLotId = this.db.prepare(`SELECT id FROM inventory_lots WHERE product_id=? AND on_hand_base_int>0
      AND status<>'STOCK_DISCREPANCY' ORDER BY datetime(received_at),received_at,id LIMIT 1`).pluck().get(pkg.product_id) as string | undefined;
    const requiresFront = !hasPickFace || (fifoLotId === pkg.inventory_lot_id && !hasSameLotPickFace);
    const rows = this.db.prepare(`SELECT s.* FROM warehouse_location_slots s
      WHERE s.topology_id=? AND s.active=1
        AND NOT EXISTS (SELECT 1 FROM warehouse_execution_packages p
          WHERE p.current_slot_id=s.id AND p.id<>? AND p.remaining_quantity_base_int>0)`).all(topology.id, packageId) as SlotRow[];
    const candidates: Array<ReturnType<typeof mapSlot> & { score: number[] }> = [];
    for (const row of rows) {
      if (row.id === pkg.current_slot_id || row.role === "QUARANTINE") continue;
      if (requiresFront && !(row.is_front && ["PICKING", "MIXED"].includes(row.role))) continue;
      if (row.max_weight_grams !== null && Number(pkg.weight_grams) > Number(row.max_weight_grams)) continue;
      const peers = this.db.prepare(`SELECT p.product_id,p.inventory_lot_id,p.id,s.is_front,s.depth_code
        FROM warehouse_execution_packages p JOIN warehouse_location_slots s ON s.id=p.current_slot_id
        WHERE s.topology_id=? AND s.rack_code=? AND s.level_number=? AND s.position_number=? AND p.id<>?
          AND p.remaining_quantity_base_int>0`)
        .all(topology.id, row.rack_code, row.level_number, row.position_number, packageId) as any[];
      if (!row.allow_mixed_sku && peers.some((peer) => peer.product_id !== pkg.product_id)) continue;
      if (!row.allow_mixed_lot && peers.some((peer) => peer.inventory_lot_id !== pkg.inventory_lot_id)) continue;
      const rearSameSku = !row.is_front && peers.some((peer) => !peer.is_front && peer.product_id === pkg.product_id);
      const rearSameLot = !row.is_front && peers.some((peer) => !peer.is_front && peer.inventory_lot_id === pkg.inventory_lot_id);
      const heavyPenalty = Number(pkg.weight_grams) >= settings.heavyPackageThresholdGrams ? Number(row.heavy_penalty) : 0;
      // Ordered policy: mandatory/FIFO pick face, accessibility/depth use, rear pairing,
      // weight, configured priority, configured last-resort. Mixed policies are filters above.
      const score = [
        requiresFront ? (row.is_front ? 0 : 1) : 0,
        requiresFront ? 0 : (row.is_front ? 1 : 0),
        rearSameSku ? 0 : 1,
        rearSameLot ? 0 : 1,
        heavyPenalty,
        Number(row.placement_priority),
        row.last_resort ? 1 : 0,
        Number(row.depth_index),
        Number(row.level_number),
        Number(row.position_number),
      ];
      candidates.push({ ...mapSlot(row), score });
    }
    candidates.sort((left, right) => {
      for (let index = 0; index < left.score.length; index += 1) {
        if (left.score[index] !== right.score[index]) return left.score[index] - right.score[index];
      }
      return left.code.localeCompare(right.code);
    });
    return candidates.map(({ score: _score, ...candidate }) => candidate);
  }

  getPositionOccupancy(rackCodeValue: string, levelNumber: number, positionNumber: number) {
    const rackCode = requiredText(rackCodeValue, "rackCode").toUpperCase();
    return (this.db.prepare(`SELECT s.depth_code,p.id AS package_id FROM warehouse_location_slots s
      JOIN warehouse_topologies t ON t.id=s.topology_id AND t.active=1
      LEFT JOIN warehouse_execution_packages p ON p.current_slot_id=s.id AND p.remaining_quantity_base_int>0
      WHERE s.rack_code=? AND s.level_number=? AND s.position_number=? ORDER BY s.depth_index`)
      .all(rackCode, positiveInteger(levelNumber, "levelNumber"), positiveInteger(positionNumber, "positionNumber")) as any[])
      .map((row) => ({ depthCode: row.depth_code, packageId: row.package_id ?? null }));
  }

  placePackage(input: { packageId: string; destinationCode: string; scannedDestinationCode: string; operationId: string; placedAt?: string }) {
    const packageId = requiredText(input.packageId, "packageId");
    const pkg = this.packageRow(packageId);
    if (pkg.disposition !== "ACCEPTED" || pkg.status !== "LABELED" || !pkg.label_identity || pkg.current_slot_id) {
      throw new WarehouseExecutionError("PACKAGE_NOT_READY_FOR_PLACEMENT", "The accepted package must be labeled and unplaced.", 409);
    }
    const destination = this.validatedDestination(packageId, input.destinationCode, input.scannedDestinationCode);
    const movedAt = input.placedAt ? timestamp(input.placedAt, "placedAt") : new Date().toISOString();
    const before = this.getAvailability(pkg.product_id).onHandBaseInt;
    return this.db.transaction(() => {
      this.transferBalance(pkg.inventory_lot_id, `RECEIVING:${pkg.receipt_id}`, destination.id, pkg.remaining_quantity_base_int, destination);
      const status = destination.isFront && ["PICKING", "MIXED"].includes(destination.role) ? "PICKING" : "RESERVE";
      this.db.prepare("UPDATE warehouse_execution_packages SET current_slot_id=?,status=?,updated_at=? WHERE id=?")
        .run(destination.id, status, movedAt, packageId);
      this.insertMovement(input.operationId, "PLACEMENT", pkg, `RECEIVING:${pkg.receipt_id}`, destination.id, movedAt);
      const after = this.getAvailability(pkg.product_id).onHandBaseInt;
      if (after !== before) throw new WarehouseExecutionError("MOVE_CHANGED_ON_HAND", "Placement cannot change product on-hand.", 500);
      return { package: this.getPackage(packageId), destination, onHandBaseInt: after };
    }).immediate();
  }

  movePackage(input: { packageId: string; destinationCode: string; scannedDestinationCode: string; operationId: string; movedAt?: string; movementType?: "MOVE" | "REPLENISHMENT" }) {
    const packageId = requiredText(input.packageId, "packageId");
    const pkg = this.packageRow(packageId);
    if (pkg.disposition !== "ACCEPTED" || !pkg.current_slot_id || !["PICKING", "RESERVE"].includes(pkg.status)) {
      throw new WarehouseExecutionError("PACKAGE_NOT_MOVABLE", "The package is not placed in an active stock location.", 409);
    }
    const destination = this.validatedDestination(packageId, input.destinationCode, input.scannedDestinationCode);
    const movedAt = input.movedAt ? timestamp(input.movedAt, "movedAt") : new Date().toISOString();
    const before = this.getAvailability(pkg.product_id).onHandBaseInt;
    return this.db.transaction(() => {
      this.transferBalance(pkg.inventory_lot_id, pkg.current_slot_id, destination.id, pkg.remaining_quantity_base_int, destination);
      const status = destination.isFront && ["PICKING", "MIXED"].includes(destination.role) ? "PICKING" : "RESERVE";
      this.db.prepare("UPDATE warehouse_execution_packages SET current_slot_id=?,status=?,updated_at=? WHERE id=?")
        .run(destination.id, status, movedAt, packageId);
      this.insertMovement(input.operationId, input.movementType ?? "MOVE", pkg, pkg.current_slot_id, destination.id, movedAt);
      const after = this.getAvailability(pkg.product_id).onHandBaseInt;
      if (after !== before) throw new WarehouseExecutionError("MOVE_CHANGED_ON_HAND", "Internal movement cannot change product on-hand.", 500);
      return { package: this.getPackage(packageId), destination, onHandBaseInt: after };
    }).immediate();
  }

  prepareReplenishment(input: { productId: string; operationId: string }) {
    const productId = requiredText(input.productId, "productId");
    const operationId = requiredText(input.operationId, "operationId");
    const settings = this.getSettings();
    return this.db.transaction(() => {
      const lot = this.db.prepare(`SELECT id FROM inventory_lots WHERE product_id=? AND on_hand_base_int>0
        ORDER BY datetime(received_at),received_at,id LIMIT 1`).get(productId) as any;
      if (!lot) throw new WarehouseExecutionError("STOCK_NOT_FOUND", "No on-hand FIFO lot exists for replenishment.", 404);
      const pick = this.db.prepare(`SELECT p.*,s.id AS slot_id FROM warehouse_execution_packages p
        JOIN warehouse_location_slots s ON s.id=p.current_slot_id
        WHERE p.product_id=? AND p.inventory_lot_id=? AND p.status='PICKING' AND s.is_front=1
        ORDER BY (p.remaining_quantity_base_int>0) DESC,p.created_at,p.id LIMIT 1`).get(productId, lot.id) as any;
      if (!pick) throw new WarehouseExecutionError("MANDATORY_PICK_FACE_MISSING", "The FIFO lot has no accessible front pick face.", 409);
      const currentPct = Math.floor(Number(pick.remaining_quantity_base_int) * 100 / Number(pick.target_quantity_base_int));
      if (currentPct > settings.watchThresholdPct) return { state: "HEALTHY" as const, productId, lotId: lot.id, currentPct };
      if (currentPct > settings.prepareThresholdPct) {
        const taskId = randomUUID();
        this.db.prepare(`INSERT INTO warehouse_replenishment_tasks
          (id,operation_id,product_id,inventory_lot_id,pick_package_id,target_slot_id,threshold_pct,current_pct,status)
          VALUES (?,?,?,?,?,?,?,?, 'LOW_WATCH')`).run(taskId, operationId, productId, lot.id, pick.id, pick.slot_id, settings.watchThresholdPct, currentPct);
        return { id: taskId, state: "LOW_WATCH" as const, productId, lotId: lot.id, pickPackageId: pick.id, sourcePackageId: null, currentPct };
      }
      const source = this.db.prepare(`SELECT p.* FROM warehouse_execution_packages p
        JOIN warehouse_location_slots s ON s.id=p.current_slot_id
        WHERE p.product_id=? AND p.inventory_lot_id=? AND p.status='RESERVE' AND p.remaining_quantity_base_int>0
          AND (s.is_front=0 OR s.role='RESERVE') ORDER BY datetime(p.created_at),p.created_at,p.id LIMIT 1`).get(productId, lot.id) as any;
      const taskId = randomUUID();
      if (!source) {
        this.db.prepare(`INSERT INTO warehouse_stock_discrepancies_v2
          (id,operation_id,product_id,inventory_lot_id,package_id,location_id,reason,status)
          VALUES (?,?,?,?,?,?,?,'COUNT_REQUIRED')`).run(randomUUID(), operationId, productId, lot.id, null, pick.slot_id, "EXPECTED_SAME_LOT_RESERVE_NOT_FOUND");
        this.db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lot.id);
        this.db.prepare(`INSERT INTO warehouse_replenishment_tasks
          (id,operation_id,product_id,inventory_lot_id,pick_package_id,target_slot_id,threshold_pct,current_pct,status)
          VALUES (?,?,?,?,?,?,?,?, 'STOCK_DISCREPANCY')`).run(taskId, operationId, productId, lot.id, pick.id, pick.slot_id, settings.prepareThresholdPct, currentPct);
        return { id: taskId, state: "STOCK_DISCREPANCY" as const, productId, lotId: lot.id, pickPackageId: pick.id, sourcePackageId: null, currentPct };
      }
      this.db.prepare(`INSERT INTO warehouse_replenishment_tasks
        (id,operation_id,product_id,inventory_lot_id,pick_package_id,source_package_id,target_slot_id,threshold_pct,current_pct,status)
        VALUES (?,?,?,?,?,?,?,?,?,'PREPARE_REPLENISHMENT')`).run(taskId, operationId, productId, lot.id, pick.id, source.id, pick.slot_id, settings.prepareThresholdPct, currentPct);
      return { id: taskId, state: "PREPARE_REPLENISHMENT" as const, productId, lotId: lot.id, pickPackageId: pick.id, sourcePackageId: source.id, currentPct };
    }).immediate();
  }

  completeReplenishment(input: { taskId: string; destinationCode: string; scannedDestinationCode: string; operationId: string; movedAt?: string }) {
    const taskId = requiredText(input.taskId, "taskId");
    return this.db.transaction(() => {
      const task = this.db.prepare(`SELECT * FROM warehouse_replenishment_tasks
        WHERE id=? AND status='PREPARE_REPLENISHMENT'`).get(taskId) as any;
      if (!task || !task.source_package_id) {
        throw new WarehouseExecutionError("REPLENISHMENT_TASK_NOT_READY", "Replenishment task is not ready for movement.", 409);
      }
      const destination = this.listAvailableLocations(task.source_package_id)
        .find((slot) => slot.code === String(input.destinationCode).trim().toUpperCase());
      if (!destination || !destination.isFront || !["PICKING", "MIXED"].includes(destination.role)) {
        throw new WarehouseExecutionError("REPLENISHMENT_PICK_FACE_REQUIRED", "Same-lot replenishment must move to an empty accessible front pick face.", 409);
      }
      const moved = this.movePackage({
        packageId: task.source_package_id,
        destinationCode: input.destinationCode,
        scannedDestinationCode: input.scannedDestinationCode,
        operationId: input.operationId,
        movedAt: input.movedAt,
        movementType: "REPLENISHMENT",
      });
      this.db.prepare("UPDATE warehouse_replenishment_tasks SET status='COMPLETED',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(taskId);
      return { id: taskId, state: "COMPLETED" as const, lotId: task.inventory_lot_id, sourcePackageId: task.source_package_id, movement: moved };
    }).immediate();
  }

  reportDiscrepancy(input: { discrepancyId: string; productId: string; lotId: string; packageId?: string; locationId?: string; reason: string; operationId: string }) {
    const discrepancyId = requiredText(input.discrepancyId, "discrepancyId");
    const productId = requiredText(input.productId, "productId");
    const lotId = requiredText(input.lotId, "lotId");
    const operationId = requiredText(input.operationId, "operationId");
    const reasonText = requiredText(input.reason, "reason", 1000);
    const lot = this.db.prepare("SELECT id FROM inventory_lots WHERE id=? AND product_id=?").get(lotId, productId);
    if (!lot) throw new WarehouseExecutionError("LOT_NOT_FOUND", "Inventory lot was not found for the product.", 404);
    const packageId = input.packageId ? requiredText(input.packageId, "packageId") : null;
    const locationId = input.locationId ? requiredText(input.locationId, "locationId") : null;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO warehouse_stock_discrepancies_v2
        (id,operation_id,product_id,inventory_lot_id,package_id,location_id,reason,status)
        VALUES (?,?,?,?,?,?,?,'COUNT_REQUIRED')`).run(discrepancyId, operationId, productId, lotId, packageId, locationId, reasonText);
      this.db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lotId);
      if (packageId) this.db.prepare("UPDATE warehouse_execution_packages SET status='DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=? AND inventory_lot_id=?")
        .run(packageId, lotId);
    }).immediate();
    return { id: discrepancyId, productId, lotId, packageId, locationId, reason: reasonText, status: "COUNT_REQUIRED" as const };
  }

  recordCount(input: { countId: string; packageId: string; observedQuantityBaseInt: number; reason: string; operationId: string; countedAt?: string }) {
    const countId = requiredText(input.countId, "countId");
    const packageId = requiredText(input.packageId, "packageId");
    const pkg = this.packageRow(packageId);
    if (!pkg.current_slot_id || !pkg.inventory_lot_id) throw new WarehouseExecutionError("PACKAGE_NOT_COUNTABLE", "Package must be placed before count.", 409);
    const observed = nonNegativeInteger(input.observedQuantityBaseInt, "observedQuantityBaseInt");
    const expected = Number(pkg.remaining_quantity_base_int);
    const difference = observed - expected;
    const reasonText = requiredText(input.reason, "reason", 1000);
    const countedAt = input.countedAt ? timestamp(input.countedAt, "countedAt") : new Date().toISOString();
    const status = difference === 0 ? "MATCHED" : "PENDING_APPROVAL";
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO warehouse_stock_counts_v2
        (id,operation_id,package_id,inventory_lot_id,location_id,expected_quantity_base_int,
         observed_quantity_base_int,difference_base_int,reason,status,counted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(countId, requiredText(input.operationId, "operationId"), packageId, pkg.inventory_lot_id,
        pkg.current_slot_id, expected, observed, difference, reasonText, status, countedAt);
      if (difference !== 0) {
        this.db.prepare(`INSERT INTO warehouse_stock_discrepancies_v2
          (id,operation_id,product_id,inventory_lot_id,package_id,location_id,reason,status)
          VALUES (?,?,?,?,?,?,?,'COUNT_REQUIRED')`).run(randomUUID(), `${input.operationId}:discrepancy`, pkg.product_id,
          pkg.inventory_lot_id, packageId, pkg.current_slot_id, reasonText);
        this.db.prepare("UPDATE inventory_lots SET status='STOCK_DISCREPANCY',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(pkg.inventory_lot_id);
      }
    }).immediate();
    return { id: countId, packageId, expectedQuantityBaseInt: expected, observedQuantityBaseInt: observed, differenceBaseInt: difference, status };
  }

  approveCount(input: { countId: string; approvalReference: string; operationId: string; approvedAt?: string }) {
    const countId = requiredText(input.countId, "countId");
    const approvalReference = requiredText(input.approvalReference, "approvalReference", 500);
    const operationId = requiredText(input.operationId, "operationId");
    const approvedAt = input.approvedAt ? timestamp(input.approvedAt, "approvedAt") : new Date().toISOString();
    return this.db.transaction(() => {
      const count = this.db.prepare(`SELECT c.*,p.product_id,p.base_uom_code_snapshot,p.remaining_quantity_base_int
        FROM warehouse_stock_counts_v2 c JOIN warehouse_execution_packages p ON p.id=c.package_id WHERE c.id=?`).get(countId) as any;
      if (!count) throw new WarehouseExecutionError("COUNT_NOT_FOUND", "Stock count was not found.", 404);
      if (count.status !== "PENDING_APPROVAL") throw new WarehouseExecutionError("COUNT_NOT_PENDING", "Stock count does not require approval.", 409);
      const lot = this.db.prepare("SELECT on_hand_base_int,reserved_base_int FROM inventory_lots WHERE id=?").get(count.inventory_lot_id) as any;
      const difference = Number(count.difference_base_int);
      const nextOnHand = Number(lot.on_hand_base_int) + difference;
      if (nextOnHand < Number(lot.reserved_base_int) || nextOnHand < 0) {
        throw new WarehouseExecutionError("COUNT_WOULD_CREATE_NEGATIVE_INVENTORY", "Approved count cannot reduce inventory below reserved or zero.", 409);
      }
      const location = this.db.prepare("SELECT quantity_base_int FROM inventory_lot_location_balances WHERE lot_id=? AND location_id=?").get(count.inventory_lot_id, count.location_id) as any;
      if (!location || Number(location.quantity_base_int) + difference < 0) {
        throw new WarehouseExecutionError("COUNT_LOCATION_UNDERFLOW", "Count would create a negative location balance.", 409);
      }
      this.db.prepare("UPDATE warehouse_execution_packages SET remaining_quantity_base_int=?,updated_at=? WHERE id=?")
        .run(count.observed_quantity_base_int, approvedAt, count.package_id);
      this.db.prepare("UPDATE inventory_lots SET on_hand_base_int=?,updated_at=? WHERE id=?").run(nextOnHand, approvedAt, count.inventory_lot_id);
      this.db.prepare("UPDATE inventory_lot_location_balances SET quantity_base_int=quantity_base_int+?,updated_at=? WHERE lot_id=? AND location_id=?")
        .run(difference, approvedAt, count.inventory_lot_id, count.location_id);
      this.db.prepare(`INSERT INTO inventory_ledger_events
        (id,operation_id,event_type,product_id,lot_id,quantity_delta_base_int,base_uom_code_snapshot,
         reason_code,reference_type,reference_id,occurred_at)
        VALUES (?,?,'CORRECTION',?,?,?,?, 'APPROVED_WAREHOUSE_COUNT','warehouse_stock_count',?,?)`).run(
        randomUUID(), operationId, count.product_id, count.inventory_lot_id, difference, count.base_uom_code_snapshot, countId, approvedAt);
      this.db.prepare(`UPDATE warehouse_stock_counts_v2 SET status='APPROVED',approval_reference=?,approval_operation_id=?,approved_at=? WHERE id=?`)
        .run(approvalReference, operationId, approvedAt, countId);
      this.db.prepare("UPDATE warehouse_stock_discrepancies_v2 SET status='RESOLVED',resolved_at=? WHERE package_id=? AND status<>'RESOLVED'")
        .run(approvedAt, count.package_id);
      const open = this.db.prepare("SELECT 1 FROM warehouse_stock_discrepancies_v2 WHERE inventory_lot_id=? AND status<>'RESOLVED' LIMIT 1").get(count.inventory_lot_id);
      if (!open) this.db.prepare("UPDATE inventory_lots SET status='USABLE',updated_at=? WHERE id=?").run(approvedAt, count.inventory_lot_id);
      this.syncProjection(count.product_id);
      return { id: countId, status: "APPROVED" as const, differenceBaseInt: difference, onHandBaseInt: nextOnHand, approvalReference };
    }).immediate();
  }

  getReconciliation(productIdValue: string) {
    const productId = requiredText(productIdValue, "productId");
    const lot = Number(this.db.prepare("SELECT COALESCE(SUM(on_hand_base_int),0) FROM inventory_lots WHERE product_id=?").pluck().get(productId));
    const ledger = Number(this.db.prepare("SELECT COALESCE(SUM(quantity_delta_base_int),0) FROM inventory_ledger_events WHERE product_id=?").pluck().get(productId));
    const location = Number(this.db.prepare(`SELECT COALESCE(SUM(b.quantity_base_int),0) FROM inventory_lot_location_balances b
      JOIN inventory_lots l ON l.id=b.lot_id WHERE l.product_id=?`).pluck().get(productId));
    const packages = Number(this.db.prepare(`SELECT COALESCE(SUM(remaining_quantity_base_int),0) FROM warehouse_execution_packages
      WHERE product_id=? AND disposition='ACCEPTED'`).pluck().get(productId));
    const projection = Number(this.db.prepare("SELECT central_stock FROM products WHERE id=?").pluck().get(productId));
    return {
      productId, lotOnHandBaseInt: lot, ledgerOnHandBaseInt: ledger, locationOnHandBaseInt: location,
      packageOnHandBaseInt: packages, centralStockProjectionBaseInt: projection,
      reconciled: lot === ledger && lot === location && lot === packages && lot === projection,
    };
  }

  private packageRow(packageId: string) {
    const row = this.db.prepare("SELECT * FROM warehouse_execution_packages WHERE id=? OR package_code=?").get(packageId, packageId) as any;
    if (!row) throw new WarehouseExecutionError("PACKAGE_NOT_FOUND", "Warehouse package was not found.", 404);
    return row;
  }

  private validatedDestination(packageId: string, destinationCodeValue: string, scannedCodeValue: string) {
    const destinationCode = requiredText(destinationCodeValue, "destinationCode").toUpperCase();
    const scannedCode = requiredText(scannedCodeValue, "scannedDestinationCode").toUpperCase();
    if (destinationCode !== scannedCode) throw new WarehouseExecutionError("DESTINATION_SCAN_MISMATCH", "Scanned destination does not match the selected location.", 409);
    const destination = this.listAvailableLocations(packageId).find(({ code }) => code === destinationCode);
    if (!destination) throw new WarehouseExecutionError("LOCATION_POLICY_VIOLATION", "Destination is occupied or violates configured placement policy.", 409);
    return destination;
  }

  private transferBalance(lotId: string, fromLocationId: string, toLocationId: string, quantityValue: number, destination: ReturnType<typeof mapSlot>) {
    const quantity = positiveInteger(Number(quantityValue), "quantityBaseInt");
    const changed = this.db.prepare(`UPDATE inventory_lot_location_balances SET quantity_base_int=quantity_base_int-?,updated_at=CURRENT_TIMESTAMP
      WHERE lot_id=? AND location_id=? AND quantity_base_int>=?`).run(quantity, lotId, fromLocationId, quantity);
    if (changed.changes !== 1) throw new WarehouseExecutionError("LOCATION_BALANCE_CONFLICT", "Source location balance changed or is insufficient.", 409);
    const kind = destination.isFront && ["PICKING", "MIXED"].includes(destination.role) ? "PICKING" : "RESERVE";
    this.db.prepare(`INSERT INTO inventory_lot_location_balances
      (id,lot_id,location_id,location_kind,quantity_base_int,active,physical_state,updated_at)
      VALUES (?,?,?,?,?,1,'CONFIRMED',CURRENT_TIMESTAMP)
      ON CONFLICT(lot_id,location_id) DO UPDATE SET quantity_base_int=quantity_base_int+excluded.quantity_base_int,
        location_kind=excluded.location_kind,active=1,physical_state='CONFIRMED',updated_at=CURRENT_TIMESTAMP`)
      .run(randomUUID(), lotId, toLocationId, kind, quantity);
  }

  private insertMovement(operationIdValue: string, movementType: "PLACEMENT" | "MOVE" | "REPLENISHMENT", pkg: any, from: string, to: string, movedAt: string) {
    this.db.prepare(`INSERT INTO warehouse_package_movements_v2
      (id,operation_id,movement_type,package_id,inventory_lot_id,product_id,quantity_base_int,from_location_id,to_location_id,moved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), requiredText(operationIdValue, "operationId"), movementType,
      pkg.id, pkg.inventory_lot_id, pkg.product_id, pkg.remaining_quantity_base_int, from, to, movedAt);
  }

  private syncProjection(productId: string) {
    this.db.prepare(`UPDATE products SET central_stock=COALESCE((SELECT SUM(on_hand_base_int) FROM inventory_lots WHERE product_id=?),0),
      updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(productId, productId);
  }
}

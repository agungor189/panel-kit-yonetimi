import type Database from "better-sqlite3";
import { ReconciliationService } from "./reconciliationService.js";

export const DEFAULT_RECONCILIATION_TIME_ZONE = "Europe/Istanbul";

const partsInZone = (date: Date, timeZone: string) => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
) as Record<"year"|"month"|"day"|"hour"|"minute"|"second", number>;

const localToUtc = (local: { year:number; month:number; day:number; hour:number }, timeZone: string) => {
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, 0, 0);
  let candidate = desired;
  for (let index = 0; index < 3; index += 1) {
    const actual = partsInZone(new Date(candidate), timeZone);
    const rendered = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    candidate += desired - rendered;
  }
  return new Date(candidate);
};

export const dateKeyInZone = (date: Date, timeZone = DEFAULT_RECONCILIATION_TIME_ZONE) => {
  const value = partsInZone(date, timeZone);
  return `${value.year}-${String(value.month).padStart(2,"0")}-${String(value.day).padStart(2,"0")}`;
};

export const nextDailyReconciliationAt = (from = new Date(), timeZone = process.env.RECONCILIATION_TIME_ZONE || DEFAULT_RECONCILIATION_TIME_ZONE) => {
  const local = partsInZone(from, timeZone);
  const tomorrow = local.hour >= 3;
  const day = new Date(Date.UTC(local.year, local.month - 1, local.day + (tomorrow ? 1 : 0)));
  return localToUtc({ year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour: 3 }, timeZone);
};

export function startDailyReconciliationScheduler(db:Database.Database,logger:Pick<Console,"error"|"info">=console,
  timeZone=process.env.RECONCILIATION_TIME_ZONE || DEFAULT_RECONCILIATION_TIME_ZONE){
  partsInZone(new Date(), timeZone);
  let timer:NodeJS.Timeout;const schedule=()=>{const target=nextDailyReconciliationAt(new Date(),timeZone);timer=setTimeout(()=>{try{const day=dateKeyInZone(new Date(),timeZone);new ReconciliationService(db).run({trigger:"SCHEDULED",actor:{type:"SYSTEM",id:"reconciliation-scheduler"},operationId:`reconciliation:daily:${day}`});logger.info(`[Reconciliation] Daily 03:00 scan completed (${timeZone}).`);}catch(value){logger.error("[Reconciliation] Daily scan failed.",value);}finally{schedule();}},Math.max(1,target.getTime()-Date.now()));timer.unref();};schedule();return()=>clearTimeout(timer);
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ReconciliationService } from "./reconciliationService.js";

export const nextDailyReconciliationAt = (from=new Date())=>{const next=new Date(from);next.setHours(3,0,0,0);if(next.getTime()<=from.getTime())next.setDate(next.getDate()+1);return next;};
export function startDailyReconciliationScheduler(db:Database.Database,logger:Pick<Console,"error"|"info">=console){
  let timer:NodeJS.Timeout;const schedule=()=>{const target=nextDailyReconciliationAt();timer=setTimeout(()=>{try{const day=new Date().toISOString().slice(0,10);new ReconciliationService(db).run({trigger:"SCHEDULED",actor:{type:"SYSTEM",id:"reconciliation-scheduler"},operationId:`reconciliation:daily:${day}`});logger.info("[Reconciliation] Daily 03:00 scan completed.");}catch(value){logger.error("[Reconciliation] Daily scan failed.",value);}finally{schedule();}},Math.max(1,target.getTime()-Date.now()));timer.unref();};schedule();return()=>clearTimeout(timer);
}

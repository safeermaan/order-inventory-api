import type { Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { transaction } from '../db/transaction.js';
import { finishLocked } from '../modules/service.js';
export async function expireOrders(db: Pool) {
 let count = 0;
 // One order per transaction keeps product locking order consistent across workers.
 for (let i=0; i<100; i++) {
  const expired = await transaction(db, async c => {
   const row = (await c.query("SELECT id FROM orders WHERE status='PENDING' AND expires_at <= clock_timestamp() ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
   if (!row) return false;
   await finishLocked(c,row.id,'EXPIRED');
   return true;
  });
  if (!expired) break;
  count++;
 }
 return count;
}
export async function cleanupKeys(db: Pool) {
 return (await db.query("DELETE FROM idempotency_keys WHERE created_at < now()-interval '24 hours'")).rowCount;
}
export function startWorker(db: Pool, interval: number, logger: FastifyBaseLogger) {
 let running: Promise<void> | undefined;
 const timer = setInterval(() => {
  if (running) return;
  const log = logger.child({ reqId: 'expiry-worker' });
  running = (async () => {
   try { const expired = await expireOrders(db); const removed = await cleanupKeys(db); log.debug({ expired, removed },'Maintenance completed'); }
   catch (err) { log.error({ err },'Maintenance failed'); }
  })().finally(() => { running = undefined; });
 }, interval);
 timer.unref();
 return async () => { clearInterval(timer); await running; };
}

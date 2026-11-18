import type { Pool, PoolClient } from 'pg';
import { setTimeout } from 'node:timers/promises';
export async function transaction<T>(db: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
 for (let attempt = 0; ; attempt++) {
  const client = await db.connect();
  try {
   await client.query('BEGIN');
   const result = await fn(client);
   await client.query('COMMIT');
   return result;
  } catch (error) {
   try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
   const code = (error as { code?: string }).code;
   if (attempt >= 1 || !['40P01','40001'].includes(code ?? '')) throw error;
  } finally { client.release(); }
  await setTimeout(10 + Math.random() * 30);
 }
}

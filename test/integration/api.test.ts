import { beforeAll, afterAll, afterEach, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import { expireOrders, cleanupKeys } from '../../src/workers/expiry.js';
import { invariants } from '../helpers/invariants.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.');
const schema = 'test_' + randomUUID().replaceAll('-','');
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 20 });
let app: FastifyInstance;
beforeAll(async () => {
 await admin.query(`CREATE SCHEMA ${schema}`);
 const client = await db.connect();
 try { await runner({ dbClient: client, direction: 'up', dir: 'migrations', migrationsTable: 'pgmigrations', schema, log: () => {} }); }
 finally { client.release(); }
 app = await createApp(db,false);
});
afterEach(async () => { await invariants(db); });
afterAll(async () => {
 if (app) await app.close(); await db.end();
 await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
});
async function post(url: string, payload: unknown, key?: string) {
 const res = await app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: key ? { 'Idempotency-Key': key } : {} });
 return { status: res.statusCode, body: res.json(), replay: res.headers['idempotent-replay'] };
}
async function product(quantity = 10) {
 const p = await post('/products',{ sku: randomUUID(), name: 'Keyboard', priceCents: 1250 });
 expect(p.status).toBe(201);
 if (quantity) expect((await post(`/inventory/${p.body.id}/receive`,{ quantity })).status).toBe(200);
 return p.body;
}
function order(productId: string, quantity = 1, customerId = 'customer') { return { customerId, items: [{ productId, quantity }] }; }
async function stock(id: string) { return (await app.inject(`/products/${id}`)).json(); }
// All jobs wait at a barrier before submitting, maximizing overlap without timing assertions.
async function parallel<T>(jobs: (() => Promise<T>)[]) {
 let release!: () => void;
 const barrier = new Promise<void>(r => { release = r; });
 const tasks = jobs.map(async job => { await barrier; return job(); });
 release(); return Promise.all(tasks);
}
it('50 concurrent requests for 10 units yield 10 creations and 40 conflicts', async () => {
 const p = await product();
 const results = await parallel(Array.from({ length: 50 }, () => () => post('/orders',order(p.id),randomUUID())));
 expect(results.filter(r => r.status===201)).toHaveLength(10);
 expect(results.filter(r => r.status===409)).toHaveLength(40);
 expect((await stock(p.id)).reserved).toBe(10);
});
it('20 concurrent duplicate submissions produce one stored order', async () => {
 const p = await product(); const key = randomUUID();
 const results = await parallel(Array.from({ length: 20 }, () => () => post('/orders',order(p.id,2),key)));
 expect(results.filter(r => r.status===201)).toHaveLength(1);
 expect(results.filter(r => r.status===200)).toHaveLength(19);
 expect(new Set(results.map(r => r.body.id)).size).toBe(1);
 expect((await stock(p.id)).reserved).toBe(2);
 expect(results.filter(r => r.status===200).every(r => r.replay==='true')).toBe(true);
 expect((await post('/orders',order(p.id,3),key)).status).toBe(422);
});
it('replays the stored creation response after confirmation or a lost response', async () => {
 const p = await product(); const key = randomUUID();
 const original = await post('/orders',order(p.id),key);
 expect((await post(`/orders/${original.body.id}/confirm`,{})).status).toBe(200);
 const retry = await post('/orders',order(p.id),key);
 expect(retry.status).toBe(200); expect(retry.body).toEqual(original.body);
 expect((await app.inject(`/orders/${original.body.id}`)).json().status).toBe('CONFIRMED');
});
it('scopes keys by customer', async () => {
 const p = await product(); const key = randomUUID();
 const a = await post('/orders',order(p.id,1,'alice'),key);
 const b = await post('/orders',order(p.id,1,'bob'),key);
 expect(a.status).toBe(201); expect(b.status).toBe(201); expect(a.body.id).not.toBe(b.body.id);
});
it('opposite item ordering converges to one hash and avoids deadlock errors', async () => {
 const a = await product(30); const b = await product(30);
 const items = [{ productId: a.id, quantity: 1 },{ productId: b.id, quantity: 1 }];
 const results = await parallel(Array.from({ length: 20 }, (_,i) => () => post('/orders',{ customerId: 'c', items: i%2 ? [...items].reverse() : items },randomUUID())));
 expect(results.every(r => r.status===201)).toBe(true);
 const key = randomUUID();
 const first = await post('/orders',{ customerId: 'c', items },key);
 const replay = await post('/orders',{ customerId: 'c', items: [...items].reverse() },key);
 expect(replay.status).toBe(200); expect(replay.body).toEqual(first.body);
});
it('rolls back earlier reservations when last sorted product is unavailable', async () => {
 const products = [await product(5),await product(5)].sort((a,b) => a.id.localeCompare(b.id));
 await post(`/inventory/${products[1].id}/adjust`,{ quantity: -5, reason: 'Empty last product' });
 const key = randomUUID();
 const res = await post('/orders',{ customerId: 'c', items: products.map(p => ({ productId: p.id, quantity: 1 })) },key);
 expect(res.status).toBe(409); expect((await stock(products[0].id)).reserved).toBe(0);
 expect((await db.query('SELECT * FROM idempotency_keys WHERE key=$1',[key])).rows).toEqual([]);
});
it('confirm versus cancel has one winner, repeated winner leaves stock unchanged', async () => {
 const p = await product(); const created = await post('/orders',order(p.id,2),randomUUID());
 const results = await parallel(['confirm','cancel'].map(action => () => post(`/orders/${created.body.id}/${action}`,{})));
 expect(results.map(r => r.status).sort()).toEqual([200,409]);
 const winner = results.find(r => r.status===200)!;
 const action = winner.body.status==='CONFIRMED' ? 'confirm' : 'cancel';
 const repeat = await parallel(Array.from({ length: 10 }, () => () => post(`/orders/${created.body.id}/${action}`,{})));
 expect(repeat.every(r => r.status===200)).toBe(true);
 expect((await stock(p.id)).reserved).toBe(0);
 expect((await stock(p.id)).on_hand).toBe(action==='confirm' ? 8 : 10);
});
it('multiple expiry workers release each reservation exactly once', async () => {
 const p = await product(20); const ids: string[] = [];
 for (let i=0;i<10;i++) ids.push((await post('/orders',order(p.id),randomUUID())).body.id);
 await db.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[ids]);
 await parallel(Array.from({ length: 4 }, () => () => expireOrders(db)));
 expect((await stock(p.id)).reserved).toBe(0); expect((await stock(p.id)).on_hand).toBe(20);
 expect((await db.query("SELECT count(*) FROM orders WHERE id=ANY($1::uuid[]) AND status='EXPIRED'",[ids])).rows[0].count).toBe('10');
});
it('expiry wins even if confirmation reaches an overdue order before the worker', async () => {
 const p = await product(); const created = await post('/orders',order(p.id),randomUUID());
 await db.query("UPDATE orders SET expires_at=now()-interval '1 second' WHERE id=$1",[created.body.id]);
 expect((await post(`/orders/${created.body.id}/confirm`,{})).status).toBe(409);
 expect((await app.inject(`/orders/${created.body.id}`)).json().status).toBe('EXPIRED');
});
it('rejects adjustments below reserved stock and enforces immutable ledger', async () => {
 const p = await product(5);
 await post('/orders',order(p.id,3),randomUUID());
 expect((await post(`/inventory/${p.id}/adjust`,{ quantity: -3, reason: 'Correction' })).status).toBe(409);
 expect((await post(`/inventory/${p.id}/adjust`,{ quantity: -2, reason: 'Correction' })).status).toBe(200);
 expect((await stock(p.id)).on_hand).toBe(3);
 await expect(db.query('UPDATE stock_movements SET quantity=quantity WHERE product_id=$1',[p.id])).rejects.toThrow('append-only');
 await expect(db.query('DELETE FROM stock_movements WHERE product_id=$1',[p.id])).rejects.toThrow('append-only');
 await expect(db.query('TRUNCATE stock_movements')).rejects.toThrow('append-only');
 await expect(db.query('UPDATE inventory SET reserved=on_hand+1 WHERE product_id=$1',[p.id])).rejects.toThrow();
});
it('validates missing keys, duplicate UUID casing, missing products and duplicate SKUs', async () => {
 const p = await product();
 expect((await post('/orders',order(p.id))).status).toBe(400);
 expect((await post('/products',{ sku: p.sku, name: 'Same', priceCents: 0 })).status).toBe(409);
 expect((await post('/orders',order(randomUUID()),randomUUID())).status).toBe(404);
 expect((await post('/orders',{ customerId: 'c', items: [{ productId: p.id, quantity: 1 },{ productId: p.id.toUpperCase(), quantity: 1 }] },randomUUID())).status).toBe(400);
 expect((await post(`/inventory/${p.id}/receive`,{ quantity: -1 })).status).toBe(400);
 expect((await post(`/inventory/${p.id}/adjust`,{ quantity: -1, reason: '' })).status).toBe(400);
});
it('cleans keys older than 24h while keeping orders and audit records', async () => {
 const p = await product(); const created = await post('/orders',order(p.id),randomUUID());
 // Test an independent expired key so the full suite order/key invariant remains meaningful.
 await db.query("INSERT INTO idempotency_keys(scope,key,request_hash,response_code,response_body,created_at) VALUES('cleanup','old','x',201,'{}',now()-interval '25 hours')");
 expect(await cleanupKeys(db)).toBe(1);
 expect((await app.inject(`/orders/${created.body.id}`)).statusCode).toBe(200);
});

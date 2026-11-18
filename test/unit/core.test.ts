import { describe, it, expect } from 'vitest';
import { canonicalize, requestHash } from '../../src/modules/hash.js';
import { transitionAllowed } from '../../src/errors.js';
import { createApp } from '../../src/app.js';
import pg from 'pg';
const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
describe('request identity', () => {
 it('normalizes item ordering, property order and UUID casing', () => {
  const one = { customerId: 'c', items: [{ productId: a.toUpperCase(), quantity: 2 }, { productId: b, quantity: 1 }] };
  const two = { items: [{ quantity: 1, productId: b }, { quantity: 2, productId: a }], customerId: 'c' };
  expect(requestHash(one)).toBe(requestHash(two));
  expect(canonicalize(one).items[0].productId).toBe(a);
  expect(requestHash({ ...two, customerId: 'different' })).not.toBe(requestHash(two));
 });
});
it('only allows pending or repeated final transitions', () => {
 expect(transitionAllowed('PENDING','CONFIRMED')).toBe(true);
 expect(transitionAllowed('CONFIRMED','CONFIRMED')).toBe(true);
 expect(transitionAllowed('CANCELLED','CONFIRMED')).toBe(false);
 expect(transitionAllowed('EXPIRED','CANCELLED')).toBe(false);
});
it('maps validation, malformed JSON and unavailable database to consistent errors', async () => {
 const db = new pg.Pool({ connectionString: 'postgres://none:none@127.0.0.1:1/none', connectionTimeoutMillis: 50 });
 const app = await createApp(db,false);
 try {
  const bad = await app.inject({ method: 'POST', url: '/products', payload: {} });
  expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe('INVALID_INPUT');
  expect(bad.headers['x-request-id']).toBeTruthy();
  const malformed = await app.inject({ method: 'POST', url: '/products', headers: { 'content-type': 'application/json' }, payload: '{' });
  expect(malformed.statusCode).toBe(400); expect(malformed.json().error.details).toEqual({});
  const unavailable = await app.inject('/health'); expect(unavailable.statusCode).toBe(503);
  expect((await app.inject('/missing')).statusCode).toBe(404);
  expect((await app.inject('/docs/')).statusCode).toBe(200);
  const spec = (await app.inject('/openapi.json')).json(); expect(spec.paths['/orders'].post).toBeTruthy();
 } finally { await app.close(); await db.end(); }
});

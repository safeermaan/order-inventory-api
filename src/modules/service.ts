import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { config } from '../config.js';
import { DomainError, transitionAllowed } from '../errors.js';
import { transaction } from '../db/transaction.js';
import { canonicalize, requestHash } from './hash.js';
import { readProduct, readOrder, movement, lockOrder, reserve } from './repository.js';
import type { productInput, orderInput } from './schemas.js';

export async function createProduct(db: Pool, input: z.infer<typeof productInput>) {
 return transaction(db, async c => {
  const row = (await c.query('INSERT INTO products(sku,name,price_cents) VALUES($1,$2,$3) RETURNING id',[input.sku,input.name,input.priceCents])).rows[0];
  await c.query('INSERT INTO inventory(product_id) VALUES($1)',[row.id]);
  return readProduct(c,row.id);
 });
}
export async function changeStock(db: Pool, product: string, quantity: number, type: 'RECEIVE' | 'ADJUST', reason?: string) {
 return transaction(db, async c => {
  await readProduct(c,product);
  const row = (await c.query('UPDATE inventory SET on_hand=on_hand+$2, updated_at=now() WHERE product_id=$1 AND on_hand::bigint+$2 >= reserved AND on_hand::bigint+$2 <= 2147483647 RETURNING product_id',[product,quantity])).rows[0];
  if (!row) throw new DomainError(409,'INVALID_STOCK_ADJUSTMENT','Adjustment exceeds stock limits or would strand reservations');
  await movement(c,product,null,type,quantity,reason);
  return readProduct(c,product);
 });
}
export async function createOrder(db: Pool, raw: z.infer<typeof orderInput>, key: string) {
 const input = canonicalize(raw);
 if (new Set(input.items.map(i => i.productId)).size !== input.items.length) throw new DomainError(400,'DUPLICATE_ITEM','Duplicate products are not allowed');
 const hash = requestHash(input);
 return transaction(db, async c => {
  // Expired keys may be reused; unique-index locking still serializes concurrent claims.
  await c.query("DELETE FROM idempotency_keys WHERE scope=$1 AND key=$2 AND created_at < now()-interval '24 hours'",[input.customerId,key]);
  const inserted = await c.query("INSERT INTO idempotency_keys(scope,key,request_hash,response_code,response_body) VALUES($1,$2,$3,201,'{}') ON CONFLICT(scope,key) DO NOTHING RETURNING key",[input.customerId,key,hash]);
  if (!inserted.rowCount) {
   const row = (await c.query('SELECT * FROM idempotency_keys WHERE scope=$1 AND key=$2',[input.customerId,key])).rows[0];
   if (row.request_hash !== hash) throw new DomainError(422,'IDEMPOTENCY_CONFLICT','Key already used with a different request');
   return { replay: true, order: row.response_body };
  }
  const order = (await c.query("INSERT INTO orders(customer_id,status,total_cents,expires_at) VALUES($1,'PENDING',0,now()+$2*interval '1 second') RETURNING id",[input.customerId,config.ORDER_TTL_SECONDS])).rows[0];
  let total = 0;
  for (const item of input.items) {
   const product = await readProduct(c,item.productId);
   await reserve(c,item.productId,item.quantity);
   total += product.price_cents * item.quantity;
   await c.query('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES($1,$2,$3,$4)',[order.id,item.productId,item.quantity,product.price_cents]);
   await movement(c,item.productId,order.id,'RESERVE',item.quantity);
  }
  await c.query('UPDATE orders SET total_cents=$2 WHERE id=$1',[order.id,total]);
  const response = await readOrder(c,order.id);
  await c.query('UPDATE idempotency_keys SET order_id=$3,response_body=$4 WHERE scope=$1 AND key=$2',[input.customerId,key,order.id,JSON.stringify(response)]);
  return { replay: false, order: response };
 });
}
export async function finishLocked(c: PoolClient, id: string, target: 'CONFIRMED' | 'CANCELLED' | 'EXPIRED') {
 const items = (await c.query('SELECT product_id,quantity FROM order_items WHERE order_id=$1 ORDER BY product_id',[id])).rows;
 for (const item of items) {
  await c.query('UPDATE inventory SET reserved=reserved-$2, on_hand=on_hand-$3, updated_at=now() WHERE product_id=$1',[item.product_id,item.quantity,target === 'CONFIRMED' ? item.quantity : 0]);
  await movement(c,item.product_id,id,target === 'CONFIRMED' ? 'COMMIT' : 'RELEASE',-item.quantity);
 }
 await c.query('UPDATE orders SET status=$2, updated_at=now() WHERE id=$1',[id,target]);
 return readOrder(c,id);
}
export async function transition(db: Pool, id: string, target: 'CONFIRMED' | 'CANCELLED') {
 const result = await transaction(db, async c => {
  const row = await lockOrder(c,id);
  if (row.status === 'PENDING' && row.overdue) {
   await finishLocked(c,id,'EXPIRED');
   return { expired: true, order: null };
  }
  if (!transitionAllowed(row.status,target)) throw new DomainError(409,'INVALID_TRANSITION',`Cannot transition ${row.status} to ${target}`);
  return { expired: false, order: row.status === target ? await readOrder(c,id) : await finishLocked(c,id,target) };
 });
 if (result.expired) throw new DomainError(409,'ORDER_EXPIRED','Order reservation has expired');
 return result.order;
}

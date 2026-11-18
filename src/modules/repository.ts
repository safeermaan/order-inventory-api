import type { Pool, PoolClient } from 'pg';
import { DomainError } from '../errors.js';
type DB = Pool | PoolClient;
export async function readProduct(db: DB, id: string) {
 const result = await db.query(`SELECT p.*, i.on_hand, i.reserved, i.on_hand-i.reserved AS available
 FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.id=$1`,[id]);
 if (!result.rows[0]) throw new DomainError(404,'PRODUCT_NOT_FOUND','Product not found');
 const row = result.rows[0];
 return { ...row, created_at: row.created_at.toISOString() };
}
export async function readOrder(db: DB, id: string) {
 const result = await db.query('SELECT * FROM orders WHERE id=$1',[id]);
 if (!result.rows[0]) throw new DomainError(404,'ORDER_NOT_FOUND','Order not found');
 const row = result.rows[0];
 const items = (await db.query('SELECT product_id,quantity,unit_price_cents FROM order_items WHERE order_id=$1 ORDER BY product_id',[id])).rows;
 return { ...row, total_cents: Number(row.total_cents), created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(), expires_at: row.expires_at.toISOString(), items };
}
export async function movement(db: PoolClient, product: string, order: string | null, type: string, quantity: number, reason: string | null = null) {
 await db.query('INSERT INTO stock_movements(product_id,order_id,type,quantity,reason) VALUES($1,$2,$3,$4,$5)',[product,order,type,quantity,reason]);
}
export async function lockOrder(db: PoolClient, id: string) {
 const row = (await db.query('SELECT *, expires_at <= clock_timestamp() AS overdue FROM orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if (!row) throw new DomainError(404,'ORDER_NOT_FOUND','Order not found');
 return row;
}
export async function reserve(db: PoolClient, product: string, quantity: number) {
 const row = (await db.query('UPDATE inventory SET reserved=reserved+$2, updated_at=now() WHERE product_id=$1 AND on_hand-reserved >= $2 RETURNING product_id',[product,quantity])).rows[0];
 if (!row) throw new DomainError(409,'INSUFFICIENT_STOCK','Insufficient stock',{ productId: product });
}

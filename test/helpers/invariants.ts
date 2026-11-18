import { expect } from 'vitest';
import type { Pool } from 'pg';
export async function invariants(db: Pool) {
 const bad = await db.query('SELECT * FROM inventory WHERE reserved < 0 OR on_hand < 0 OR reserved > on_hand');
 expect(bad.rows).toEqual([]);
 const ledger = await db.query(`SELECT i.product_id FROM inventory i LEFT JOIN stock_movements m ON m.product_id=i.product_id
 GROUP BY i.product_id,i.on_hand,i.reserved HAVING
 i.on_hand <> COALESCE(sum(CASE WHEN m.type IN ('RECEIVE','ADJUST','COMMIT') THEN m.quantity ELSE 0 END),0)
 OR i.reserved <> COALESCE(sum(CASE WHEN m.type IN ('RESERVE','RELEASE','COMMIT') THEN m.quantity ELSE 0 END),0)`);
 expect(ledger.rows).toEqual([]);
 const pending = await db.query(`SELECT i.product_id FROM inventory i LEFT JOIN order_items oi ON oi.product_id=i.product_id LEFT JOIN orders o ON o.id=oi.order_id GROUP BY i.product_id,i.reserved HAVING i.reserved <> COALESCE(sum(oi.quantity) FILTER(WHERE o.status='PENDING'),0)`);
 expect(pending.rows).toEqual([]);
 const orphan = await db.query('SELECT o.id FROM orders o LEFT JOIN idempotency_keys k ON k.order_id=o.id WHERE k.order_id IS NULL');
 expect(orphan.rows).toEqual([]);
 const duplicate = await db.query('SELECT order_id FROM idempotency_keys GROUP BY order_id HAVING count(*) <> 1');
 expect(duplicate.rows).toEqual([]);
}

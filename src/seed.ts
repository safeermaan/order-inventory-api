import { pool } from './db.js';
import { createProduct, changeStock } from './modules/service.js';
try {
 for (let i=1; i<=20; i++) {
  const sku = `DEMO-${String(i).padStart(3,'0')}`;
  if ((await pool.query('SELECT 1 FROM products WHERE sku=$1',[sku])).rowCount) continue;
  const product = await createProduct(pool,{ sku, name: `Demo product ${i}`, priceCents: i*500 });
  await changeStock(pool,product.id,100,'RECEIVE');
 }
 console.log(JSON.stringify({ reqId: 'seed', message: '20 demo products ready' }));
} finally { await pool.end(); }

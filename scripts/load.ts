import { performance } from 'node:perf_hooks';
const base = process.env.API_URL ?? 'http://localhost:3000';
async function post(path: string, body: unknown, key?: string) {
 const response = await fetch(base+path,{ method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
 if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
 return response.json();
}
const product = await post('/products',{ sku: `LOAD-${Date.now()}`, name: 'Benchmark', priceCents: 100 });
await post(`/inventory/${product.id}/receive`,{ quantity: 10000 });
const samples: number[] = [];
// Ten in-flight requests, 200 unique orders; each creates a one-unit reservation.
for (let batch=0;batch<20;batch++) {
 await Promise.all(Array.from({ length: 10 },async () => {
  const start = performance.now();
  await post('/orders',{ customerId: 'load-test', items: [{ productId: product.id, quantity: 1 }] },crypto.randomUUID());
  samples.push(performance.now()-start);
 }));
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({ requests: samples.length, concurrency: 10, p50Ms: samples[99], p95Ms: samples[189], targetP95Ms: 100, meetsTarget: samples[189]<100 },null,2));

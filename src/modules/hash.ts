import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { orderInput } from './schemas.js';
export function canonicalize(input: z.infer<typeof orderInput>) {
 return { customerId: input.customerId, items: input.items.map(i => ({ productId: i.productId.toLowerCase(), quantity: i.quantity })).sort((a,b) => a.productId.localeCompare(b.productId)) };
}
export function requestHash(input: z.infer<typeof orderInput>) {
 return createHash('sha256').update(JSON.stringify(canonicalize(input))).digest('hex');
}

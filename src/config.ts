import { z } from 'zod';
const configSchema = z.object({
 DATABASE_URL: z.string().default('postgres://inventory:inventory@localhost:5432/inventory'),
 PORT: z.coerce.number().int().min(0).max(65535).default(3000),
 ORDER_TTL_SECONDS: z.coerce.number().int().min(1).default(900),
 WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
 LOG_LEVEL: z.enum(['silent','fatal','error','warn','info','debug','trace']).default('info')
});
export const config = configSchema.parse(process.env);

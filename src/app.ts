import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from 'pg';
import { config } from './config.js';
import { DomainError } from './errors.js';
import * as schemas from './modules/schemas.js';
import { readProduct, readOrder } from './modules/repository.js';
import { createProduct, changeStock, createOrder, transition } from './modules/service.js';

export async function createApp(db: Pool, logging = true) {
 const app = Fastify({ logger: logging ? { level: config.LOG_LEVEL, base: { reqId: 'system' } } : false, bodyLimit: 65536 });
 app.setValidatorCompiler(validatorCompiler);
 app.setSerializerCompiler(serializerCompiler);
 app.addHook('onRequest', async (req, reply) => { reply.header('X-Request-Id',req.id); });
 app.addHook('preHandler', async req => {
  req.log = req.log.child({ orderId: (req.params as { id?: string })?.id, idempotencyKey: req.headers['idempotency-key'] });
 });
 await app.register(swagger, { openapi: { info: { title: 'Transaction-Safe Order & Inventory API', version: '1.0.0' } }, transform: jsonSchemaTransform });
 await app.register(swaggerUI, { routePrefix: '/docs' });
 const api = app.withTypeProvider<ZodTypeProvider>();
 const errors = { 400: schemas.errorResponse, 404: schemas.errorResponse, 409: schemas.errorResponse, 422: schemas.errorResponse, 413: schemas.errorResponse, 500: schemas.errorResponse, 503: schemas.errorResponse };
 api.get('/health', { schema: { response: { 200: z.object({ status: z.literal('ok') }), ...errors } } }, async () => {
  try { await db.query('SELECT 1'); } catch { throw new DomainError(503,'DATABASE_UNAVAILABLE','Database is unavailable'); }
  return { status: 'ok' as const };
 });
 api.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
 api.post('/products', { schema: { body: schemas.productInput, response: { 201: schemas.productResponse, ...errors } } }, async (req, reply) => reply.code(201).send(await createProduct(db,req.body)));
 api.get('/products/:id', { schema: { params: schemas.orderParams, response: { 200: schemas.productResponse, ...errors } } }, async req => readProduct(db,req.params.id));
 api.post('/inventory/:productId/receive', { schema: { params: schemas.inventoryParams, body: schemas.receiptInput, response: { 200: schemas.productResponse, ...errors } } }, async req => changeStock(db,req.params.productId,req.body.quantity,'RECEIVE'));
 api.post('/inventory/:productId/adjust', { schema: { params: schemas.inventoryParams, body: schemas.adjustmentInput, response: { 200: schemas.productResponse, ...errors } } }, async req => changeStock(db,req.params.productId,req.body.quantity,'ADJUST',req.body.reason));
 api.post('/orders', { schema: { headers: schemas.keyHeaders, body: schemas.orderInput, response: { 200: schemas.orderResponse, 201: schemas.orderResponse, ...errors } } }, async (req, reply) => {
  const result = await createOrder(db,req.body,req.headers['idempotency-key']);
  req.log.info({ orderId: result.order.id, replay: result.replay },'Order creation resolved');
  return reply.header('Idempotent-Replay',String(result.replay)).code(result.replay ? 200 : 201).send(result.order);
 });
 api.get('/orders/:id', { schema: { params: schemas.orderParams, response: { 200: schemas.orderResponse, ...errors } } }, async req => readOrder(db,req.params.id));
 for (const [action,target] of [['confirm','CONFIRMED'],['cancel','CANCELLED']] as const) {
  api.post(`/orders/:id/${action}`, { schema: { params: schemas.orderParams, response: { 200: schemas.orderResponse, ...errors } } }, async req => transition(db,req.params.id,target));
 }
 app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', details: {} } }));
 app.setErrorHandler((error, req, reply) => {
  if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
  if (hasZodFastifySchemaValidationErrors(error)) return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request', details: { issues: error.validation } } });
  const err = error as { code?: string; statusCode?: number };
  if (err.code === '23505') return reply.code(409).send({ error: { code: 'DUPLICATE_RESOURCE', message: 'Resource already exists', details: {} } });
  if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid request', details: {} } });
  req.log.error({ err: error },'Request failed');
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } });
 });
 return app;
}

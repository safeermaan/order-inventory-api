# Transaction-Safe Order & Inventory API

A REST API for products, inventory and customer orders, built with **TypeScript, Fastify, PostgreSQL and Zod**. Database transactions prevent overselling, while idempotency keys prevent duplicate orders when clients retry requests.

## Quick start

Requires Docker Engine and Docker Compose. Run from the project directory:

```bash
docker compose up --build
```

This starts PostgreSQL 17 and the API, applies database migrations and starts the reservation-expiry worker.

- **Interactive API documentation:** http://localhost:3000/docs
- **OpenAPI specification:** http://localhost:3000/openapi.json
- **Health check:** http://localhost:3000/health

Ports `3000` and `5432` bind to localhost. Database data persists in the `inventory-data` volume.

```bash
docker compose up -d       # Start in the background
docker compose logs -f api # Follow API logs
docker compose down        # Stop services; keep database data
```

## Use the API

In Swagger UI, expand an endpoint, click **Try it out**, enter the parameters and JSON body, then click **Execute**. Paste only JSON into request-body fields.

Follow this example, copying the returned IDs between steps:

| Step | Endpoint | Input | Expected result |
| --- | --- | --- | --- |
| 1 | `POST /products` | `{"sku":"KEYBOARD-01","name":"Keyboard","priceCents":7500}` | 201; copy the product `id` |
| 2 | `POST /inventory/{productId}/receive` | Product ID; body `{"quantity":10}` | 10 units on hand and available |
| 3 | `POST /orders` | Body below; header `Idempotency-Key: demo-order-001` | 201; copy the order `id` |
| 4 | `POST /orders/{id}/confirm` | Order ID; no body | Order becomes `CONFIRMED` |
| 5 | `GET /products/{id}` | Product ID | `on_hand: 8`, `reserved: 0`, `available: 8` |

Order request body—replace `PRODUCT_ID` with the actual UUID:

```json
{
  "customerId": "customer-01",
  "items": [
    { "productId": "PRODUCT_ID", "quantity": 2 }
  ]
}
```

Repeat step 3 with the same key and body to test duplicate prevention: it returns 200 with the same order and reserves no additional stock. Use a new key for each new logical order.

Additional endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /orders/{id}` | Read the current order, items, total and expiry time |
| `POST /orders/{id}/cancel` | Cancel a pending order and release its reservation |
| `POST /inventory/{productId}/adjust` | Correct stock with a signed quantity and reason, e.g. `{"quantity":-1,"reason":"Damaged item"}` |

Products start with zero stock. SKUs must be unique. Prices and totals use integer cents; request fields use camelCase and response fields use snake_case. Orders support up to 100 distinct products, with no duplicate product IDs.

## Inventory and order rules

- **Available stock = on hand − reserved.** An order reserves all its items or none. Adjustments cannot remove stock already reserved.
- Orders start as `PENDING`, then become `CONFIRMED`, `CANCELLED` or `EXPIRED`. Confirmation consumes stock; cancellation and expiry release reservations. Repeating the same confirmation/cancellation is safe; switching a terminal state is rejected.
- Pending orders expire after 15 minutes by default. The worker checks every 5 seconds; release may happen later under backlog.
- Idempotency keys are scoped by `customerId` and retained for 24 hours. A replay returns the stored creation response with `Idempotent-Replay: true`; use `GET /orders/{id}` for current status. Reusing an expired key may create a new order.
- Every stock change writes an append-only ledger entry. Receipts, adjustments and sales reconcile to on-hand stock; reservations, releases and sales reconcile to reserved stock.

Conditional SQL updates, database constraints and consistent product-lock ordering protect concurrent requests. Transitions lock the order row; expiry workers use `SKIP LOCKED`. Transactions retry once after a deadlock or serialization failure.

Errors use `{"error":{"code":"...","message":"...","details":{}}}`. Status codes: **400** invalid input, **404** missing resource, **409** stock/state conflict, **422** key reused with a different payload, **503** failed database health check. Responses include `X-Request-Id`; server logs are structured JSON.

## Local development

Requires Node.js **24+**, npm and PostgreSQL. To run the database in Docker and the API locally, stop the Compose API first if it is running:

```bash
docker compose stop api
docker compose up -d db
npm ci
export DATABASE_URL=postgres://inventory:inventory@localhost:5432/inventory
npm run migrate
npm run seed
npm run dev
```

The optional, repeatable seed creates 20 demo products with 100 units each. Migrations are tracked with `node-pg-migrate`. For compiled execution, run `npm run build`, `npm run migrate`, then `npm start`.

### Configuration

See `.env.example`. Local npm commands read exported environment variables; they do not automatically load `.env`. Compose reads `.env` for the timing and log-level settings below; its database URL and published ports are defined in `compose.yaml`.

| Variable | Default / purpose |
| --- | --- |
| `DATABASE_URL` | `postgres://inventory:inventory@localhost:5432/inventory` locally; Compose uses hostname `db` |
| `PORT` | `3000` for the local API |
| `ORDER_TTL_SECONDS` | `900`; reservation lifetime |
| `WORKER_INTERVAL_MS` | `5000`; expiry and key-cleanup interval |
| `LOG_LEVEL` | `info` |
| `TEST_DATABASE_URL` | Required for integration tests run through npm |

## Tests and development commands

Run the test suite with a disposable PostgreSQL container:

```bash
docker compose --profile test run --build --rm test
```

Or use a local database. Tests create and remove an isolated schema; the database role must have schema-creation permission.

```bash
export TEST_DATABASE_URL=postgres://inventory:inventory@localhost:5432/inventory
npm test
npm run lint
npm run build
```

Other commands: `npm run test:unit`, `npm run test:integration`, `npm run typecheck`, `npm run openapi` to regenerate the committed specification, and `npm run load` to benchmark a running API. The benchmark creates persistent demo data; use a local database. Override its API address with `API_URL` if needed.

The 15 tests cover concurrent stock contention, duplicate requests, rollback, state transitions, multiple expiry workers and ledger invariants. The concurrency test verifies exactly 10 successful orders from 50 requests competing for 10 units. GitHub Actions runs lint, build and tests against PostgreSQL 17, checks generated OpenAPI and builds the Docker image.

## Code structure and deployment

`src/app.ts` defines routes and Swagger; `src/modules/` contains schemas, services and SQL helpers; `src/db/` handles transactions; `src/workers/` handles expiry. Database changes live in `migrations/`, tests in `test/`, and the generated specification in `openapi/`.

The Docker runtime runs as a non-root user and applies migrations before startup. For public deployment, configure HTTPS, database credentials and backups, plus authentication and rate limiting. Authentication and payment processing are not implemented: customer IDs are supplied by callers, and confirmation simulates completion of a purchase.

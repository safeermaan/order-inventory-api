exports.up = pgm => pgm.sql(`
CREATE TABLE products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text UNIQUE NOT NULL, name text NOT NULL,
 price_cents integer NOT NULL CHECK(price_cents >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory (
 product_id uuid PRIMARY KEY REFERENCES products(id),
 on_hand integer NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved >= 0),
 updated_at timestamptz NOT NULL DEFAULT now(), CHECK(reserved <= on_hand)
);
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('PENDING','CONFIRMED','CANCELLED','EXPIRED')),
 total_cents bigint NOT NULL CHECK(total_cents >= 0), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_expiry ON orders(expires_at) WHERE status='PENDING';
CREATE TABLE order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 product_id uuid NOT NULL REFERENCES products(id), quantity integer NOT NULL CHECK(quantity > 0),
 unit_price_cents integer NOT NULL CHECK(unit_price_cents >= 0), UNIQUE(order_id,product_id)
);
CREATE TABLE stock_movements (
 id bigserial PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), order_id uuid REFERENCES orders(id),
 type text NOT NULL CHECK(type IN ('RECEIVE','ADJUST','RESERVE','RELEASE','COMMIT')),
 quantity integer NOT NULL CHECK(quantity <> 0), reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((type='ADJUST' AND reason IS NOT NULL AND length(trim(reason)) > 0) OR type <> 'ADJUST'),
 CHECK(type='ADJUST' OR (type IN ('RECEIVE','RESERVE') AND quantity > 0) OR (type IN ('RELEASE','COMMIT') AND quantity < 0)),
 CHECK(type IN ('RECEIVE','ADJUST') OR order_id IS NOT NULL)
);
CREATE INDEX movements_product ON stock_movements(product_id);
CREATE FUNCTION reject_movement_edit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'stock_movements is append-only'; END; $$;
CREATE TRIGGER immutable_movements BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION reject_movement_edit();
CREATE TRIGGER immutable_movements_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION reject_movement_edit();
CREATE TABLE idempotency_keys (
 scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
 response_code integer NOT NULL, response_body jsonb NOT NULL, order_id uuid REFERENCES orders(id),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key)
);
CREATE INDEX idempotency_created ON idempotency_keys(created_at);
`);
exports.down = pgm => pgm.sql(`DROP TABLE idempotency_keys, stock_movements, order_items, orders, inventory, products; DROP FUNCTION reject_movement_edit();`);

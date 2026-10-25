BEGIN;
-- Paid period passes via Toss Payments (off unless BILLING_ENABLED).
-- Orders are transaction records and are kept after a privacy deletion (user_id is
-- pseudonymized); entitlements are deleted with the user.
CREATE TABLE billing_orders (
 order_id text PRIMARY KEY CHECK (order_id ~ '^[A-Za-z0-9_-]{6,64}$'),
 user_id text NOT NULL,
 plan_id text NOT NULL,
 amount_krw integer NOT NULL CHECK (amount_krw > 0),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','canceled','expired')),
 payment_key text UNIQUE,
 method text,
 created_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz,
 canceled_at timestamptz,
 cancel_reason text,
 raw_status text
);
CREATE INDEX billing_orders_user_idx ON billing_orders(user_id, created_at DESC);
CREATE INDEX billing_orders_created_idx ON billing_orders(created_at DESC);
CREATE TABLE billing_entitlements (
 user_id text PRIMARY KEY,
 plan_id text NOT NULL,
 valid_until timestamptz NOT NULL,
 last_order_id text REFERENCES billing_orders(order_id)
);
INSERT INTO schema_migrations(name) VALUES('0028_billing.sql');
COMMIT;

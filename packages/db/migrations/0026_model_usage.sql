BEGIN;
-- Direct model calls (LiteLLM or provider API): one row per call, plus a
-- once-per-month marker for the 80% / 100% budget alerts.
CREATE TABLE model_usage (
 id bigserial PRIMARY KEY,
 at timestamptz NOT NULL DEFAULT now(),
 feature text NOT NULL,
 model text NOT NULL,
 input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
 output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
 cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
 ok boolean NOT NULL,
 error text,
 latency_ms integer NOT NULL DEFAULT 0,
 note text
);
CREATE INDEX model_usage_at_idx ON model_usage(at);
CREATE INDEX model_usage_feature_at_idx ON model_usage(feature, at);
CREATE TABLE model_budget_alerts (
 month text NOT NULL,
 level text NOT NULL CHECK (level IN ('warn','exceeded')),
 sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (month, level)
);
INSERT INTO schema_migrations(name) VALUES('0026_model_usage.sql');
COMMIT;

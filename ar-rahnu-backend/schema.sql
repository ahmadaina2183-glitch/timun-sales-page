CREATE TABLE IF NOT EXISTS arrahnu_clients (
  client_id TEXT PRIMARY KEY,
  records JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_ops JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_ts BIGINT
);

CREATE TABLE IF NOT EXISTS arrahnu_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

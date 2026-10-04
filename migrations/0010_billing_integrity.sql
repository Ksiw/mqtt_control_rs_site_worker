-- Связывает атомарное продление подписки с конкретным счётом.
ALTER TABLE subscriptions ADD COLUMN last_payment_id TEXT;
ALTER TABLE subscriptions ADD COLUMN billing_anchor_day INTEGER;
ALTER TABLE payments ADD COLUMN provider_payment_id TEXT;
ALTER TABLE payments ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT 'none';

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_payment_id
ON payments(provider_payment_id) WHERE provider_payment_id IS NOT NULL;

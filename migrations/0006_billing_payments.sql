-- Миграция 0006: Таблица платежей и истории подписок
CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    order_id TEXT UNIQUE NOT NULL,
    invoice_id TEXT,
    amount_usd REAL NOT NULL,
    plan_tier TEXT NOT NULL,
    duration_days INTEGER NOT NULL,
    payment_status TEXT NOT NULL,
    pay_currency TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(org_id);

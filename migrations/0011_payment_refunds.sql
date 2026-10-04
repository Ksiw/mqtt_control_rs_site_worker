-- Возврат относится к конкретной попытке оплаты, а не ко всему счёту.
CREATE TABLE IF NOT EXISTS payment_refunds (
    provider_payment_id TEXT PRIMARY KEY,
    payment_id TEXT NOT NULL,
    refunded_at INTEGER NOT NULL,
    FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

-- У старых возвратов нет идентификатора попытки: автоматически отличить
-- повторную оплату от запоздалого уведомления по ней невозможно.
UPDATE payments SET reconciliation_status = 'legacy_refund'
WHERE payment_status = 'refunded' AND applied_at IS NULL;

-- Один оплаченный счёт должен продлить подписку ровно один раз.
ALTER TABLE payments ADD COLUMN applied_at INTEGER;

-- Уже обработанные уведомления не должны повторно продлевать старые платежи.
UPDATE payments
SET applied_at = updated_at
WHERE payment_status IN ('confirmed', 'finished');

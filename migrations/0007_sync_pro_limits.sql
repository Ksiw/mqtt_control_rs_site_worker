-- Миграция 0007: Синхронизация лимитов хостов для существующих подписок тарифа Pro (до 3 хостов)
UPDATE subscriptions
SET max_devices = 3
WHERE plan_tier = 'pro' AND max_devices > 3;

-- Для тарифа Free сбрасываем дату окончания в 0 (бессрочно) и лимит хостов в 1
UPDATE subscriptions
SET current_period_end = 0, max_devices = 1
WHERE plan_tier = 'free';

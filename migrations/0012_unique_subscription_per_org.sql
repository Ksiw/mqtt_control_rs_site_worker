-- Одна запись текущих прав организации; счета и платежи остаются отдельными строками.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_org_unique ON subscriptions(org_id);
DROP INDEX IF EXISTS idx_sub_org;

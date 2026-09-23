-- Миграция 0003: Защита от мультиаккаунтного привязывания хостов (machine_id) и 60-дневный триал Pro

ALTER TABLE devices ADD COLUMN machine_id TEXT;
ALTER TABLE device_pairings ADD COLUMN machine_id TEXT;
ALTER TABLE subscriptions ADD COLUMN trial_used INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_devices_machine ON devices(machine_id);

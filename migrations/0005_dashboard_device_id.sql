-- Добавление привязки дашбордов к конкретному хосту (device_id)
ALTER TABLE dashboards ADD COLUMN device_id TEXT;

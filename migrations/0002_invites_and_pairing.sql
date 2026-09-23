-- Миграция 0002: Семейный доступ (приглашения по Email) и быстрая привязка программы (Pairing)

-- 1. Приглашения членов семьи / операторов по Email
CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT DEFAULT 'operator',      -- 'operator' (управление) | 'viewer' (только просмотр)
    created_at INTEGER NOT NULL,
    UNIQUE(org_id, email),
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 2. Запросы на быструю связку программы с аккаунтом без ручного ввода ключей
CREATE TABLE IF NOT EXISTS device_pairings (
    code TEXT PRIMARY KEY,             -- Короткий проверочный код (напр. 842-195)
    secret_token TEXT NOT NULL,        -- Секретный токен ожидания для самой программы
    device_name TEXT NOT NULL,
    os_info TEXT,
    app_version TEXT,
    workspace_id TEXT,
    device_key TEXT,                   -- Выпущенный ключ устройства (передаётся программе при подтверждении)
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
CREATE INDEX IF NOT EXISTS idx_pairings_expiry ON device_pairings(expires_at);

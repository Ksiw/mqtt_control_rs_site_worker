-- Миграция схемы базы данных Cloudflare D1 для Облачного Хаба mqtt_control_rs

-- 1. Пользователи (авторизация через Google OAuth 2.0)
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
);

-- 2. Сессии пользователей (для авторизации по Cookie)
CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. Организации / Компании (единица биллинга и владения)
CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

-- 4. Подписки и тарифные планы
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    plan_tier TEXT NOT NULL,           -- 'free', 'pro', 'enterprise'
    status TEXT NOT NULL,              -- 'active', 'past_due', 'canceled', 'trialing'
    max_workspaces INTEGER NOT NULL,
    max_devices INTEGER NOT NULL,
    max_dashboards INTEGER NOT NULL,
    current_period_end INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 5. Членство и глобальные роли в организациях
CREATE TABLE IF NOT EXISTS organization_members (
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,                -- 'owner', 'admin', 'engineer', 'operator', 'viewer'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, user_id),
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 6. Рабочие пространства (Workspaces)
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (org_id, slug),
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- 7. Экземпляры настольной программы (Devices / Runtime Nodes)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'primary',       -- 'primary' (основной) | 'standby' (резервный)
    priority INTEGER DEFAULT 100,      -- Приоритет маршрутизации (больше = выше)
    key_hash TEXT UNIQUE NOT NULL,     -- SHA-256 хеш от секретного Device Key
    key_prefix TEXT NOT NULL,          -- Префикс ключа для UI (mcrs_live_ab12...)
    tunnel_url TEXT,                   -- Актуальный URL туннеля (trycloudflare или собственный)
    tunnel_mode TEXT DEFAULT 'quick',  -- 'quick' | 'custom_domain'
    routing_mode TEXT DEFAULT 'proxy', -- 'proxy' (прозрачный URL) | 'redirect' (прямой переход)
    is_online INTEGER DEFAULT 0,       -- 1 = онлайн, 0 = оффлайн
    app_version TEXT,                  -- Версия программы (напр. 0.6.9)
    os_info TEXT,                      -- Платформа (Linux x86_64, Windows, etc.)
    last_heartbeat_at INTEGER,         -- Время последнего подтверждения связи
    created_at INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 8. Дашборды (автоматически регистрируемые из программы)
CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    is_public INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- 9. Разграничение доступа к дашбордам (RBAC)
CREATE TABLE IF NOT EXISTS dashboard_permissions (
    dashboard_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    permission TEXT NOT NULL,          -- 'view' (просмотр) | 'control' (управление)
    created_at INTEGER NOT NULL,
    PRIMARY KEY (dashboard_id, user_id),
    FOREIGN KEY(dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 10. Журнал аудита безопасности (Audit Log)
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    user_id TEXT,
    device_id TEXT,
    event TEXT NOT NULL,
    ip_address TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
);

-- Индексы производительности
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sub_org ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_org_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_ws_org ON workspaces(org_id);
CREATE INDEX IF NOT EXISTS idx_ws_org_slug ON workspaces(org_id, slug);
CREATE INDEX IF NOT EXISTS idx_dev_ws ON devices(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dev_key ON devices(key_hash);
CREATE INDEX IF NOT EXISTS idx_dsh_ws ON dashboards(workspace_id);
CREATE INDEX IF NOT EXISTS idx_dsh_perm ON dashboard_permissions(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_dev_heartbeat ON devices(last_heartbeat_at);

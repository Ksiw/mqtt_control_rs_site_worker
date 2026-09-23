-- История переносов хостов для защиты от частой смены оборудования
CREATE TABLE IF NOT EXISTS host_transfers (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    old_device_id TEXT,
    new_device_id TEXT,
    transferred_at INTEGER NOT NULL,
    FOREIGN KEY(org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_host_transfers_org ON host_transfers(org_id, transferred_at);

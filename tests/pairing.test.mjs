import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDir = await mkdtemp(join(tmpdir(), 'mcrs-pairing-test-'));
after(() => rm(outputDir, { recursive: true, force: true }));
await build({
  entryPoints: { pairing: 'src/pairing.ts' }, outdir: outputDir,
  outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm'
});
const { pairRouter } = await import(join(outputDir, 'pairing.mjs'));

class TestD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.failAt = null;
  }

  prepare(sql) {
    const sqlite = this.sqlite;
    return {
      bind(...params) {
        const statement = sqlite.prepare(sql);
        return {
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => ({ meta: { changes: statement.run(...params).changes } }),
          runSync: () => ({ meta: { changes: statement.run(...params).changes } })
        };
      }
    };
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement, index) => {
        if (this.failAt === index) throw new Error('Injected database failure');
        return statement.runSync();
      });
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(join('migrations', file), 'utf8'));
  }
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`
    INSERT INTO users (id, google_id, email, created_at, last_login_at)
    VALUES ('user-1', 'google-1', 'user@example.org', ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO organizations (id, slug, name, owner_user_id, created_at)
    VALUES ('org-1', 'organization', 'Organization', 'user-1', ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO organization_members (org_id, user_id, role, created_at)
    VALUES ('org-1', 'user-1', 'owner', ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES ('sess_test', 'user-1', ?, ?)
  `).run(now + 3600, now);
  sqlite.prepare(`
    INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces,
      max_devices, max_dashboards, current_period_end, created_at)
    VALUES ('sub-1', 'org-1', 'free', 'active', 1, 1, 10, 0, ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO workspaces (id, org_id, slug, name, created_at)
    VALUES ('ws-1', 'org-1', 'main', 'Main', ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO devices (id, workspace_id, name, key_hash, key_prefix, created_at)
    VALUES ('old-device', 'ws-1', 'Old', 'old-hash', 'old-prefix', ?)
  `).run(now);
  sqlite.prepare(`
    INSERT INTO device_pairings (code, secret_token, device_name, status, expires_at, created_at)
    VALUES ('123-456', 'secret', 'New', 'pending', ?, ?)
  `).run(now + 300, now);
  return { sqlite, db: new TestD1(sqlite) };
}

function approve(db, action = 'transfer') {
  return pairRouter.request('https://site.test/approve', {
    method: 'POST',
    headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: '123-456', action })
  }, { DB: db });
}

test('public pairing request rejects malformed device metadata', async () => {
  const { db } = await fixture();
  const request = body => pairRouter.request('https://site.test/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body
  }, { DB: db, HUB_DOMAIN: 'https://site.test' });
  assert.equal((await request('broken json')).status, 400);
  assert.equal((await request(JSON.stringify({ device_name: { unexpected: true } }))).status, 400);
  const response = await request(JSON.stringify({ device_name: 'Laptop' }));
  assert.equal(response.status, 200);
  assert.match((await response.json()).code, /^\d{3}-\d{3}$/);
});

test('poll and approval reject malformed JSON without changing a pairing', async () => {
  const { sqlite, db } = await fixture();
  for (const path of ['poll', 'approve']) {
    for (const body of ['not json', 'null', '{"code":42}']) {
      const response = await pairRouter.request(`https://site.test/${path}`, {
        method: 'POST', headers: { Cookie: 'session=sess_test' }, body
      }, { DB: db });
      assert.equal(response.status, 400);
    }
  }
  assert.equal(sqlite.prepare('SELECT status FROM device_pairings').get().status, 'pending');
});

test('transfer replaces the old device exactly once', async () => {
  const { sqlite, db } = await fixture();
  assert.equal((await approve(db)).status, 200);
  assert.deepEqual(sqlite.prepare('SELECT name FROM devices').all().map(row => row.name), ['New']);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM host_transfers').get().count, 1);
  assert.equal((await approve(db)).status, 400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
});

test('failed transfer leaves the old device and pending request intact', async () => {
  const { sqlite, db } = await fixture();
  db.failAt = 2;
  assert.equal((await approve(db)).status, 500);
  assert.deepEqual(sqlite.prepare('SELECT id FROM devices').all().map(row => row.id), ['old-device']);
  assert.equal(sqlite.prepare('SELECT status FROM device_pairings').get().status, 'pending');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM host_transfers').get().count, 0);
});

test('parallel approvals of one code register one device', async () => {
  const { sqlite, db } = await fixture();
  const responses = await Promise.all([approve(db), approve(db)]);
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM host_transfers').get().count, 1);
});

test('trial activation and device registration succeed or roll back together', async () => {
  const { sqlite, db } = await fixture();
  db.failAt = 2;
  assert.equal((await approve(db, 'trial')).status, 500);
  assert.equal(sqlite.prepare('SELECT trial_used FROM subscriptions').get().trial_used, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
  assert.equal(sqlite.prepare('SELECT status FROM device_pairings').get().status, 'pending');

  db.failAt = null;
  assert.equal((await approve(db, 'trial')).status, 200);
  assert.equal(sqlite.prepare('SELECT trial_used FROM subscriptions').get().trial_used, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 2);
});

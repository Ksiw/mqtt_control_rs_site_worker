import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDir = await mkdtemp(join(tmpdir(), 'mcrs-quotas-test-'));
after(() => rm(outputDir, { recursive: true, force: true }));
await build({
  entryPoints: { cabinet: 'src/cabinet.ts', family: 'src/family.ts' },
  outdir: outputDir, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm'
});
const { cabinetRouter } = await import(join(outputDir, 'cabinet.mjs'));
const { familyRouter } = await import(join(outputDir, 'family.mjs'));

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(await readFile(join('migrations', file), 'utf8'));
  }
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO users (id, google_id, email, created_at, last_login_at)
    VALUES ('owner', 'google-owner', 'owner@example.test', ?, ?)`).run(now, now);
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, owner_user_id, created_at)
    VALUES ('org-1', 'organization', 'Organization', 'owner', ?)`).run(now);
  sqlite.prepare(`INSERT INTO organization_members (org_id, user_id, role, created_at)
    VALUES ('org-1', 'owner', 'owner', ?)`).run(now);
  sqlite.prepare(`INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES ('sess_owner', 'owner', ?, ?)`).run(now + 3600, now);
  sqlite.prepare(`INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces,
    max_devices, max_dashboards, current_period_end, created_at)
    VALUES ('sub-1', 'org-1', 'free', 'active', 1, 1, 10, 0, ?)`).run(now);
  sqlite.prepare(`INSERT INTO workspaces (id, org_id, slug, name, created_at)
    VALUES ('ws-1', 'org-1', 'main', 'Main', ?)`).run(now);
  const db = {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return {
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => ({ meta: { changes: statement.run(...params).changes } })
        };
      } };
    }
  };
  return { sqlite, db, now };
}

test('parallel device creation obeys the free-tier quota', async () => {
  const { sqlite, db } = await fixture();
  const create = name => cabinetRouter.request('https://site.test/api/v1/devices/create', {
    method: 'POST',
    headers: { Cookie: 'session=sess_owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: 'ws-1', name })
  }, { DB: db });
  const responses = await Promise.all([create('First'), create('Second')]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM devices').get().count, 1);
});

test('one organization cannot acquire two current subscription rows', async () => {
  const { sqlite, now } = await fixture();
  assert.throws(() => sqlite.prepare(`
    INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces,
      max_devices, max_dashboards, current_period_end, created_at)
    VALUES ('sub-2', 'org-1', 'pro', 'active', 5, 3, 50, 0, ?)
  `).run(now));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 1);
});

test('parallel family invitations obey the member quota', async () => {
  const { sqlite, db, now } = await fixture();
  for (let index = 1; index <= 3; index++) {
    sqlite.prepare(`INSERT INTO users (id, google_id, email, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?)`).run(`member-${index}`, `google-${index}`,
      `member${index}@example.test`, now, now);
    sqlite.prepare(`INSERT INTO organization_members (org_id, user_id, role, created_at)
      VALUES ('org-1', ?, 'operator', ?)`).run(`member-${index}`, now);
  }
  const invite = email => familyRouter.request('https://site.test/invite', {
    method: 'POST',
    headers: { Cookie: 'session=sess_owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role: 'viewer' })
  }, { DB: db });
  const responses = await Promise.all([
    invite('new1@example.test'), invite('new2@example.test')
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM invites').get().count, 1);
});

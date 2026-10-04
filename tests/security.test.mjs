import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const outputDir = await mkdtemp(join(tmpdir(), 'mcrs-worker-test-'));
after(() => rm(outputDir, { recursive: true, force: true }));
await build({
  entryPoints: {
    device: 'src/device.ts', billing: 'src/billing.ts', cabinet: 'src/cabinet.ts',
    cabinet_views: 'src/cabinet_views.ts', admin_view: 'src/admin_view.ts',
    types: 'src/types.ts', wiki: 'src/wiki.ts', auth: 'src/auth.ts',
    proxy: 'src/proxy.ts', admin_access: 'src/core/admin_access.ts'
  },
  outdir: outputDir, outExtension: { '.js': '.mjs' },
  bundle: true, platform: 'node', format: 'esm'
});

const { deviceRouter } = await import(join(outputDir, 'device.mjs'));
const { billingRouter } = await import(join(outputDir, 'billing.mjs'));
const { cabinetRouter } = await import(join(outputDir, 'cabinet.mjs'));
const { renderCabinetHtml } = await import(join(outputDir, 'cabinet_views.mjs'));
const { renderAdminScripts } = await import(join(outputDir, 'admin_view.mjs'));
const { getEffectivePlanTier } = await import(join(outputDir, 'types.mjs'));
const { wikiRouter } = await import(join(outputDir, 'wiki.mjs'));
const { authRouter, createUserSession, AccountIdentityConflictError } =
  await import(join(outputDir, 'auth.mjs'));
const { proxyRouter } = await import(join(outputDir, 'proxy.mjs'));
const { isSuperAdmin } = await import(join(outputDir, 'admin_access.mjs'));

test('configured Google ID takes precedence over the legacy administrator email', () => {
  const byEmail = { email: '754marcus@gmail.com', google_id: 'wrong-account' };
  const byId = { email: 'renamed@example.test', google_id: 'admin-google-id' };
  assert.equal(isSuperAdmin(byEmail), true);
  assert.equal(isSuperAdmin(byEmail, 'admin-google-id'), false);
  assert.equal(isSuperAdmin(byId, 'admin-google-id'), true);
});

test('operator route ignores a foreign device ID supplied in a cookie', async () => {
  const tunnelNames = [];
  const queries = [];
  const forwardedCookies = [];
  const env = {
    DB: {
      prepare(sql) {
        return { bind(...params) {
          queries.push({ sql, params });
          return { first: async () => sql.includes('FROM user_sessions s')
            ? { id: 'user-1' }
            : sql.includes('FROM workspaces w')
              ? { id: 'ws-own', device_id: null, member_role: 'viewer' }
              : null };
        } };
      }
    },
    TUNNEL_DO: {
      idFromName(name) { tunnelNames.push(name); return name; },
      get() { return { fetch: async request => {
        forwardedCookies.push(request.headers.get('Cookie'));
        return new Response('workspace tunnel', { status: 200 });
      } }; }
    }
  };
  const response = await proxyRouter.request('https://site.test/operator/command', {
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-own; last_dev_id=dev-foreign; operator_theme=dark' }
  }, env);
  assert.equal(response.status, 200);
  assert.deepEqual(tunnelNames, ['ws-own']);
  assert.deepEqual(forwardedCookies, ['operator_theme=dark']);
  const workspaceQuery = queries.find(query => query.sql.includes('FROM workspaces w'));
  assert.ok(workspaceQuery.sql.includes('linked_device.workspace_id = w.id'));
  assert.deepEqual(workspaceQuery.params, ['dev-foreign', '', 'ws-own', 'user-1']);
  const command = await proxyRouter.request('https://site.test/operator/command', {
    method: 'POST',
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-own; last_dev_id=dev-foreign' },
    body: '{}'
  }, env);
  assert.equal(command.status, 403);
  assert.deepEqual(tunnelNames, ['ws-own']);
});

test('dashboard and operator routes keep the operator token on the server', async () => {
  let dashboardPath = '/operator?token=private-token';
  const forwardedTokens = [];
  const env = {
    DB: { prepare(sql) {
      return { bind() { return { first: async () => sql.includes('FROM user_sessions s')
        ? { id: 'user-1' }
        : sql.includes('FROM dashboards d')
          ? { dash_id: 'dash-1', dash_path: dashboardPath,
            device_id: null, workspace_id: 'ws-1', member_role: 'viewer' }
          : sql.includes('FROM workspaces w')
            ? { id: 'ws-1', device_id: null, dash_path: dashboardPath, member_role: 'viewer' }
          : null }; } };
    } },
    TUNNEL_DO: { idFromName: name => name,
      get: () => ({ fetch: async request => {
        forwardedTokens.push(request.headers.get('X-Operator-Token'));
        return new Response('dashboard', {
        status: 200,
        headers: { 'Set-Cookie': 'session=forged; Path=/' }
        });
      } }) }
  };
  const response = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.every(cookie => !cookie.includes('private-token')));
  assert.ok(cookies.some(cookie => cookie.startsWith('last_dash_id=dash-1') && cookie.includes('HttpOnly')));
  assert.ok(cookies.some(cookie => cookie.startsWith('last_ws_id=ws-1')));
  assert.ok(cookies.some(cookie => cookie.startsWith('last_dev_id=;')));
  assert.ok(cookies.every(cookie => !cookie.startsWith('session=forged')));

  const operatorResponse = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test', Referer: 'https://site.test/view/org/ws/dash-1' }
  }, env);
  assert.equal(operatorResponse.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token', 'private-token']);

  const fallbackResponse = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-1; last_dash_id=dash-1' }
  }, env);
  assert.equal(fallbackResponse.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token', 'private-token', 'private-token']);

  dashboardPath = '/operator?tab=1#fragment-token';
  const fragmentResponse = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(fragmentResponse.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token', 'private-token', 'private-token', 'fragment-token']);
  assert.ok(fragmentResponse.headers.getSetCookie().every(cookie =>
    !cookie.includes('fragment-token')));

  dashboardPath = '//outside.test/operator';
  const invalidResponse = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(invalidResponse.status, 502);
  assert.equal(forwardedTokens.length, 4);
});

function deviceDb(device, batched) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql, params,
            first: async () => sql.includes('FROM devices WHERE key_hash') &&
              params[0] === device.key_hash ? device : null
          };
        }
      };
    },
    batch: async statements => { batched.push(...statements); return []; }
  };
}

test('heartbeat и unlink требуют настоящий ключ и HMAC, SQL использует параметры', async () => {
  const key = 'mcrs_live_0123456789abcdef0123456789abcdef';
  const device = {
    id: 'dev_test', workspace_id: 'ws_test',
    key_prefix: key.slice(0, 16),
    key_hash: createHash('sha256').update(key).digest('hex')
  };
  const batched = [];
  const env = { DB: deviceDb(device, batched) };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const maliciousId = "x') OR 1=1 --";
  const body = JSON.stringify({ dashboards: [{ id: maliciousId, name: 'test', path: '/operator' }] });
  const headers = {
    'X-Device-Prefix': device.key_prefix, 'X-Device-Key': key,
    'X-Timestamp': timestamp, 'X-Signature': '0'.repeat(64)
  };
  const request = (path, data, customHeaders) => deviceRouter.request(
    `https://example.test/${path}`,
    { method: 'POST', headers: customHeaders, body: data }, env
  );

  assert.equal((await request('heartbeat', body, headers)).status, 401);
  assert.equal((await request('unlink', '{}', headers)).status, 401);
  const noKey = { ...headers };
  delete noKey['X-Device-Key'];
  assert.equal((await request('heartbeat', body, noKey)).status, 401);
  assert.equal(batched.length, 0);

  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + body).digest('hex');
  assert.equal((await request('heartbeat', body + ' ', headers)).status, 401);
  assert.equal((await request('heartbeat', body, headers)).status, 200);
  const invalidBody = 'null';
  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + invalidBody).digest('hex');
  assert.equal((await request('heartbeat', invalidBody, headers)).status, 400);
  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + body).digest('hex');
  const deleteQuery = batched.find(s => s.sql.includes('DELETE FROM dashboards'));
  assert.ok(deleteQuery);
  assert.ok(!deleteQuery.sql.includes(maliciousId));
  assert.ok(deleteQuery.params.includes(`dev_test_${maliciousId}`));

  const batchesBeforeInvalid = batched.length;
  for (const invalid of [
    { dashboards: [{ id: 'valid', path: '/operator' }, { id: 42 }] },
    { dashboards: [{ id: 'valid', path: '//outside.test/operator' }] },
    { tunnel_url: 'javascript:alert(1)' }
  ]) {
    const invalidPayload = JSON.stringify(invalid);
    headers['X-Signature'] = createHmac('sha256', key)
      .update(timestamp + invalidPayload).digest('hex');
    assert.equal((await request('heartbeat', invalidPayload, headers)).status, 400);
    assert.equal(batched.length, batchesBeforeInvalid);
  }
  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + body).digest('hex');

  // Старые записи могли хранить более короткий префикс ключа.
  device.key_prefix = key.slice(0, 12);
  assert.equal((await request('heartbeat', body, headers)).status, 200);

  const unlinkBody = '{}';
  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + unlinkBody).digest('hex');
  assert.equal((await request('unlink', unlinkBody, headers)).status, 200);
});

test('plain HTTP cannot mark a device online as a WebSocket tunnel', async () => {
  const response = await deviceRouter.request('https://site.test/tunnel-ws?prefix=x&key=y',
    { method: 'GET' }, { DB: { prepare() { throw new Error('Database must not be touched'); } } });
  assert.equal(response.status, 426);
});

test('WebSocket tunnel rejects device credentials in the URL', async () => {
  const response = await deviceRouter.request('https://site.test/tunnel-ws?prefix=x&key=y',
    { headers: { Upgrade: 'websocket' } },
    { DB: { prepare() { throw new Error('Database must not be touched'); } } });
  assert.equal(response.status, 401);
});

test('WebSocket tunnel accepts device credentials in headers', async () => {
  const key = 'mcrs_live_0123456789abcdef0123456789abcdef';
  const keyHash = createHash('sha256').update(key).digest('hex');
  let connected = false;
  const env = {
    DB: { prepare(sql) { return { bind(...params) { return {
      first: async () => sql.includes('FROM devices WHERE key_hash') && params[0] === keyHash
        ? { id: 'device-1', key_prefix: key.slice(0, 16) } : null,
      run: async () => ({ meta: { changes: 1 } })
    }; } }; } },
    TUNNEL_DO: { idFromName: name => name,
      get: () => ({ fetch: async () => { connected = true; return new Response(null, { status: 200 }); } }) }
  };
  const response = await deviceRouter.request('https://site.test/tunnel-ws', {
    headers: { Upgrade: 'websocket', 'X-Device-Prefix': key.slice(0, 16), 'X-Device-Key': key }
  }, env);
  assert.equal(response.status, 200);
  assert.equal(connected, true);
});

test('trial endpoint refuses to overwrite a concurrently activated subscription', async () => {
  let updateSql = '';
  const db = { prepare(sql) {
    return { bind() { return {
      first: async () => sql.includes('FROM user_sessions s') ? { id: 'user-1' }
        : sql.includes('FROM organizations o') ? {
          org_id: 'org-1', plan_tier: 'free', status: 'active',
          current_period_end: 0, trial_used: 0, user_role: 'owner'
        } : null,
      run: async () => { updateSql = sql; return { meta: { changes: 0 } }; }
    }; } };
  } };
  const response = await cabinetRouter.request(
    'https://site.test/api/v1/subscription/activate-trial',
    { method: 'POST', headers: { Cookie: 'session=sess_test' } }, { DB: db }
  );
  assert.equal(response.status, 409);
  assert.ok(updateSql.includes('COALESCE(trial_used, 0) = 0'));
});

test('opening the cabinet never deletes dashboards and binds workspace IDs', async () => {
  const workspaceId = "ws_' OR 1=1 --";
  const statements = [];
  const db = { prepare(sql) {
    const statement = { sql, params: [], bind(...params) { this.params = params; return this; },
      first: async () => sql.includes('FROM user_sessions s')
        ? { id: 'user-1', email: 'owner@example.test', name: 'Owner' }
        : sql.includes('FROM subscriptions') ? {
          plan_tier: 'free', status: 'active', current_period_end: 0,
          max_devices: 1, trial_used: 0
        } : sql.includes('SELECT o.id FROM organizations o') ? { id: 'org-1' } : null,
      all: async () => ({ results: sql.includes('SELECT o.* FROM organizations o')
        ? [{ id: 'org-1', slug: 'org', name: 'Organization', owner_user_id: 'user-1' }]
        : sql.includes('FROM workspaces')
          ? [{ id: workspaceId, slug: 'main', org_id: 'org-1' }]
          : sql.includes('FROM dashboards d')
            ? [{ id: 'dash-1', name: 'Panel', slug: '/operator?tab=1#private-token',
              device_id: 'dev-1', workspace_id: workspaceId, org_slug: 'org', ws_slug: 'main' }]
            : sql.includes('FROM devices')
              ? [{ id: 'dev-1', workspace_id: workspaceId, name: 'Host', is_online: 1 }]
              : [] }) };
    statements.push(statement);
    return statement;
  } };
  const env = { DB: db };
  const options = { headers: { Cookie: 'session=sess_test' } };
  assert.equal((await cabinetRouter.request('https://site.test/cabinet', options, env)).status, 200);
  const state = await cabinetRouter.request('https://site.test/api/v1/cabinet/state', options, env);
  assert.equal(state.status, 200);
  assert.ok(!(await state.text()).includes('private-token'));
  assert.ok(statements.every(statement => !statement.sql.includes('DELETE FROM dashboards')));
  const deviceReads = statements.filter(statement =>
    statement.sql.includes('FROM devices') && !statement.sql.includes('FROM dashboards d'));
  assert.equal(deviceReads.length, 2);
  for (const statement of deviceReads) {
    assert.ok(!statement.sql.includes(workspaceId));
    assert.ok(statement.params.includes(workspaceId));
  }
});

test('webhook не принимает неподписанное или неполное уведомление', async () => {
  const secret = 'test-ipn-secret';
  const payload = { order_id: 'sub_org_test_month_1', payment_status: 'confirmed' };
  const body = JSON.stringify(payload);
  const request = (env, signature) => billingRouter.request('https://example.test/webhook', {
    method: 'POST', body,
    headers: signature ? { 'x-nowpayments-sig': signature } : {}
  }, env);

  assert.equal((await request({}, null)).status, 503);
  assert.equal((await request({ NOWPAYMENTS_IPN_SECRET: secret }, 'bad')).status, 403);
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal((await request({ NOWPAYMENTS_IPN_SECRET: secret }, signature)).status, 400);
});

test('истёкший и приостановленный тариф дают бесплатные лимиты', () => {
  const now = 1000;
  assert.equal(getEffectivePlanTier('pro', 'active', 999, now), 'free');
  assert.equal(getEffectivePlanTier('enterprise', 'past_due', 2000, now), 'free');
  assert.equal(getEffectivePlanTier('pro', 'trialing', 1001, now), 'pro');
});

test('API не создаёт второй хост по истёкшей Pro подписке', async () => {
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes('FROM user_sessions s')) return { id: 'usr_test' };
              if (sql.includes('FROM workspaces w')) return {
                org_id: 'org_test', user_role: 'owner', plan_tier: 'pro',
                status: 'active', current_period_end: 1, max_devices: 3, trial_used: 0
              };
              if (sql.includes('COUNT(*) as count FROM devices')) return { count: 1 };
              return null;
            }
          };
        }
      };
    }
  };
  const response = await cabinetRouter.request('https://example.test/api/v1/devices/create', {
    method: 'POST',
    headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: 'ws_test', name: 'new host' })
  }, { DB: db });
  assert.equal(response.status, 403);
});

test('кабинет экранирует пользовательские данные; скрипт администратора остаётся корректным', () => {
  const attack = '<img src=x onerror=alert(1)>';
  const html = renderCabinetHtml({
    user: { id: 'usr_test', name: attack, email: 'test@example.org' },
    currentOrg: { id: 'org_test', name: 'test', slug: 'test', owner_user_id: 'usr_test' },
    workspaces: [{ id: `ws_test</script>${attack}`, slug: 'main' }],
    devices: [{ id: 'dev_test', workspace_id: 'ws_test', name: attack, app_version: attack, is_online: 1 }],
    dashboards: [{ id: 'dash_test', device_id: 'dev_test', ws_slug: 'main', org_slug: 'test', name: attack, slug: '/operator?token=private-token', is_online: 1 }],
    members: [], pendingInvites: [], planTier: 'free', maxDevices: 1,
    maxMembers: 5, isOwner: true
  });
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('private-token'));
  const script = renderAdminScripts(true).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  const tbody = { innerHTML: '' };
  const browser = {
    document: { getElementById: id => id === 'adminUsersBody' ? tbody : null },
    window: { addEventListener() {} }
  };
  runInNewContext(script, browser);
  browser.renderUserRows([{
    email: `test'\"><img src=x onerror=alert(1)>@example.org`,
    name: attack, plan_tier: 'pro', max_devices: 3, current_period_end: 0
  }]);
  assert.ok(!tbody.innerHTML.includes(attack));
  assert.ok(!tbody.innerHTML.includes('<img'));
});

test('wiki comments require an account, enforce same-origin, and only allow deleting own comments', async () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = { sql, params: [], bind(...params) { this.params = params; return this; },
        first: async () => sql.includes('FROM user_sessions') ? {
          id: 'usr_member', email: 'member@example.org', name: 'Member'
        } : sql.includes('COUNT(*)') ? { count: 0 } : null,
        all: async () => ({ results: [] }), run: async () => ({ success: true, meta: { changes: 1 } }) };
      prepared.push(statement);
      return statement;
    },
  };
  const env = { DB: db };
  const request = (path, options = {}, headers = {}) => wikiRouter.request(`https://site.test/${path}`, {
    ...options, headers: { ...headers, ...(options.headers || {}) }
  }, env);

  assert.equal((await request('articles/autopilots/comments', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.test' },
    body: JSON.stringify({ body: 'Helpful note' })
  })).status, 401);

  const cookieHeaders = { Cookie: 'session=sess_test', 'Content-Type': 'application/json' };
  assert.equal((await request('articles/autopilots/comments', {
    method: 'POST', headers: { ...cookieHeaders, Origin: 'https://attacker.test' },
    body: JSON.stringify({ body: 'Helpful note' })
  })).status, 403);
  assert.equal((await request('articles/autopilots/comments', {
    method: 'POST', headers: {
      ...cookieHeaders, Origin: 'https://attacker.test', 'X-Forwarded-Host': 'attacker.test'
    }, body: JSON.stringify({ body: 'Helpful note' })
  })).status, 403);

  const submitted = await request('articles/autopilots/comments', {
    method: 'POST', headers: { ...cookieHeaders, Origin: 'https://site.test' },
    body: JSON.stringify({ body: 'Helpful note' })
  });
  assert.equal(submitted.status, 201);
  assert.ok(prepared.some(s => s.sql.includes('INSERT INTO wiki_comments')));

  const deletion = await request('articles/autopilots/comments/wcom_example', {
    method: 'DELETE', headers: { Cookie: 'session=sess_test', Origin: 'https://site.test' }
  });
  assert.equal(deletion.status, 200);
  const deleteQuery = prepared.find(s => s.sql.startsWith('DELETE FROM wiki_comments'));
  assert.deepEqual(deleteQuery.params.slice(-1), ['usr_member']);
});

test('Google login returns to the wiki only for an allowed local path', async () => {
  const request = (returnTo) => authRouter.request(
    `https://site.test/google?return=${encodeURIComponent(returnTo)}`,
    { method: 'GET' },
    { GOOGLE_CLIENT_ID: 'test-client-id', HUB_DOMAIN: 'https://site.test', SESSION_SECRET: 'test-secret' }
  );
  const accepted = await request('/en/wiki#article=brokers');
  assert.equal(accepted.status, 302);
  assert.ok(accepted.headers.get('set-cookie').includes('oauth_return=%2Fen%2Fwiki%23article%3Dbrokers'));
  const rejected = await request('https://attacker.example/');
  assert.equal(rejected.status, 302);
  assert.ok(rejected.headers.get('set-cookie').includes('oauth_return=%2Fcabinet'));
});

test('OAuth state requires the original browser cookie with or without a server secret', async () => {
  for (const secret of [undefined, 'test-secret']) {
    const env = { GOOGLE_CLIENT_ID: 'test-client-id', HUB_DOMAIN: 'https://site.test',
      SESSION_SECRET: secret };
    const start = await authRouter.request('https://site.test/google', { method: 'GET' }, env);
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    assert.equal((await authRouter.request(
      `https://site.test/callback?code=fake&state=${state}`, { method: 'GET' }, env
    )).status, 400);
    assert.equal((await authRouter.request(
      `https://site.test/callback?code=fake&state=${state}`,
      { method: 'GET', headers: { Cookie: 'oauth_state=other-browser' } }, env
    )).status, 400);
  }
});

test('a different Google account cannot inherit an existing account by email', async () => {
  const statements = [];
  const db = { prepare(sql) {
    statements.push(sql);
    return { bind() { return { first: async () => sql.includes('lower(email)')
      ? { id: 'existing-user', google_id: 'original-google-id' } : null }; } };
  } };
  await assert.rejects(
    createUserSession(db, { id: 'another-google-id', email: 'USER@example.org' }),
    AccountIdentityConflictError
  );
  assert.ok(statements.every(sql => sql.startsWith('SELECT')));
});

test('browser Google login rejects an unverified email address', async () => {
  const env = { GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-secret',
    HUB_DOMAIN: 'https://site.test' };
  const start = await authRouter.request('https://site.test/google', { method: 'GET' }, env);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => url.includes('/token')
    ? new Response(JSON.stringify({ access_token: 'test-access' }), { status: 200 })
    : new Response(JSON.stringify({ sub: 'google-user', email: 'user@example.org',
      email_verified: false }), { status: 200 });
  try {
    const response = await authRouter.request(
      `https://site.test/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `oauth_state=${encodeURIComponent(state)}` } }, env
    );
    assert.equal(response.status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
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
      return { bind() { return { all: async () => ({ results: sql.includes('SELECT id, tunnel_url, is_online FROM devices')
        ? [{ id: 'dev-1', tunnel_url: null, is_online: 1 }] : [] }),
        first: async () => sql.includes('FROM user_sessions s')
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
        if (new URL(request.url).pathname === '/operator/mode') {
          return Response.json({ enterprise_mode: false });
        }
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
  assert.ok(cookies.some(cookie => cookie.startsWith('last_dev_id=dev-1;')));
  assert.ok(cookies.every(cookie => !cookie.startsWith('session=forged')));

  assert.deepEqual(forwardedTokens, []);

  const operatorResponse = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test', Referer: 'https://site.test/view/org/ws/dash-1' }
  }, env);
  assert.equal(operatorResponse.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token']);

  const fallbackResponse = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-1; last_dash_id=dash-1' }
  }, env);
  assert.equal(fallbackResponse.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token', 'private-token']);

  dashboardPath = '/operator?tab=1#fragment-token';
  const fragmentResponse = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(fragmentResponse.status, 200);
  assert.ok(fragmentResponse.headers.getSetCookie().every(cookie =>
    !cookie.includes('fragment-token')));
  const operatorFragment = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test', Referer: 'https://site.test/view/org/ws/dash-1' }
  }, env);
  assert.equal(operatorFragment.status, 200);
  assert.deepEqual(forwardedTokens, ['private-token', 'private-token', 'fragment-token']);

  dashboardPath = '//outside.test/operator';
  const invalidResponse = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(invalidResponse.status, 502);
  assert.equal(forwardedTokens.length, 3);
});

test('proxy blocks device HTML/SVG execution and unknown operator subpaths', async () => {
  const env = {
    DB: { prepare(sql) {
      return { bind() { return { all: async () => ({ results: sql.includes('SELECT id, tunnel_url, is_online FROM devices')
        ? [{ id: 'dev-1', tunnel_url: null, is_online: 1 }] : [] }),
        first: async () => sql.includes('FROM user_sessions s')
        ? { id: 'user-1' }
        : sql.includes('FROM dashboards d')
          ? { dash_id: 'dash-1', dash_name: 'Main Panel', dash_path: '/operator',
            device_id: 'dev-1', workspace_id: 'ws-1', member_role: 'viewer' }
          : sql.includes('FROM workspaces w')
            ? { id: 'ws-1', device_id: 'dev-1', dash_path: '/operator', member_role: 'viewer' }
            : null }; } };
    } },
    TUNNEL_DO: { idFromName: name => name,
      get: () => ({ fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/operator/mode') return Response.json({ enterprise_mode: false });
        if (url.pathname === '/operator/view') {
          return new Response('<svg onload="alert(1)">', {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml' }
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      } }) }
  };

  const unknownSubpath = await proxyRouter.request('https://site.test/operator/malicious.js', {
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-1; last_dash_id=dash-1' }
  }, env);
  assert.equal(unknownSubpath.status, 404);

  const dangerousContent = await proxyRouter.request('https://site.test/operator/view', {
    headers: { Cookie: 'session=sess_test; last_ws_id=ws-1; last_dash_id=dash-1' }
  }, env);
  assert.equal(dangerousContent.status, 502);
  const dangerousBody = await dangerousContent.json();
  assert.equal(dangerousBody.error, 'invalid_device_content_type');

  const pageResponse = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.ok(pageResponse.headers.get('Content-Security-Policy').includes("default-src 'self'"));
  assert.equal(pageResponse.headers.get('X-Content-Type-Options'), 'nosniff');
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

test('WebSocket tunnel rejects incorrect device key in headers', async () => {
  const key = 'mcrs_live_0123456789abcdef0123456789abcdef';
  const wrongKey = 'mcrs_live_wrongwrongwrongwrongwrongwrong';
  const keyHash = createHash('sha256').update(key).digest('hex');
  const env = {
    DB: { prepare(sql) { return { bind(...params) { return {
      first: async () => sql.includes('FROM devices WHERE key_hash') && params[0] === keyHash
        ? { id: 'device-1', key_prefix: key.slice(0, 16) } : null,
      run: async () => ({ meta: { changes: 1 } })
    }; } }; } },
    TUNNEL_DO: { idFromName: name => name,
      get: () => ({ fetch: async () => new Response(null, { status: 200 }) }) }
  };
  const response = await deviceRouter.request('https://site.test/tunnel-ws', {
    headers: { Upgrade: 'websocket', 'X-Device-Prefix': wrongKey.slice(0, 16), 'X-Device-Key': wrongKey }
  }, env);
  assert.equal(response.status, 404);
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

test('device heartbeat stores malicious dashboard title, proxy view escapes it and CSP blocks inline execution', async () => {
  const key = 'mcrs_live_0123456789abcdef0123456789abcdef';
  const device = {
    id: 'dev_test',
    workspace_id: 'ws_test',
    key_prefix: key.slice(0, 16),
    key_hash: createHash('sha256').update(key).digest('hex')
  };
  const batched = [];
  const env = { DB: deviceDb(device, batched) };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const maliciousTitle = '</script><script>globalThis.pwned=1</script>';
  const body = JSON.stringify({
    dashboards: [{ id: 'dash-xss', name: maliciousTitle, path: '/operator' }]
  });
  const headers = {
    'X-Device-Prefix': device.key_prefix,
    'X-Device-Key': key,
    'X-Timestamp': timestamp,
    'X-Signature': createHmac('sha256', key).update(timestamp + body).digest('hex')
  };

  // 1. Device sends heartbeat with malicious title
  const heartbeatRes = await deviceRouter.request('https://site.test/heartbeat', {
    method: 'POST',
    headers,
    body
  }, env);
  assert.equal(heartbeatRes.status, 200);

  // 2. Verify dashboard was inserted into database batch with device payload
  const insertStatement = batched.find(s => s.sql.includes('INSERT INTO dashboards'));
  assert.ok(insertStatement, 'Dashboard must be inserted into batch');
  assert.equal(insertStatement.params[0], 'dev_test_dash-xss');
  assert.equal(insertStatement.params[3], maliciousTitle);

  // 3. User views the dashboard in the cabinet
  const viewEnv = {
    DB: {
      prepare(sql) {
        return {
          bind(...params) {
            return {
              all: async () => ({ results: sql.includes('SELECT id, tunnel_url, is_online FROM devices')
                ? [{ id: device.id, tunnel_url: null, is_online: 1 }] : [] }),
              first: async () => {
                if (sql.includes('FROM user_sessions')) return { id: 'user-1' };
                if (sql.includes('FROM dashboards d')) {
                  return {
                    dash_id: insertStatement.params[0],
                    dash_name: insertStatement.params[3],
                    dash_path: insertStatement.params[4],
                    device_id: device.id,
                    workspace_id: device.workspace_id,
                    member_role: 'admin',
                    sub_plan_tier: 'free',
                    sub_status: 'active',
                    sub_period_end: Math.floor(Date.now() / 1000) + 3600
                  };
                }
                return null;
              }
            };
          }
        };
      }
    },
    TUNNEL_DO: { idFromName: name => name,
      get: () => ({ fetch: async () => Response.json({ enterprise_mode: false }) }) }
  };

  const pageResponse = await proxyRouter.request('https://site.test/view/org/ws_test/dev_test_dash-xss', {
    headers: { Cookie: 'session=sess_test' }
  }, viewEnv);

  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();

  // MUST NOT contain unescaped </script> anywhere
  assert.ok(!html.includes('</script><script>globalThis.pwned=1</script>'));
  // Title in <title> tag must be HTML-escaped
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;globalThis.pwned=1&lt;/script&gt;'));
  // Title in JSON config must have < and > escaped as \u003c and \u003e
  assert.ok(html.includes('\\u003c/script\\u003e\\u003cscript\\u003eglobalThis.pwned=1\\u003c/script\\u003e'));
  // Config is inside application/json script block
  assert.ok(html.includes('<script type="application/json" id="operatorConfig">'));
  // JS is loaded from static external script with versioned content hash, NOT inline
  assert.ok(/<script src="\/operator-static\/operator\.[a-f0-9]+\.js"><\/script>/.test(html));
  assert.ok(/<link rel="stylesheet" href="\/operator-static\/operator\.[a-f0-9]+\.css">/.test(html));
  assert.ok(!html.includes('<script>'));

  // CSP header verification
  const csp = pageResponse.headers.get('Content-Security-Policy');
  assert.ok(csp, 'CSP header must be present');
  const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
  assert.ok(scriptSrcMatch, 'script-src directive must be present');
  assert.ok(!scriptSrcMatch[1].includes("'unsafe-inline'"), 'script-src must strictly forbid unsafe-inline');
  assert.ok(scriptSrcMatch[1].includes("'self'"), 'script-src must allow self');
});

test('real HTTP device tunnel response with immutable fetch headers is proxied without 502 or TypeError', async () => {
  // Start a REAL local HTTP server simulating a device endpoint
  const server = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Device-Hardware': 'TestBoard-v1'
    });
    res.end(JSON.stringify({ status: 'ok', value: 42, timestamp: Date.now() }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tunnelUrl = `http://127.0.0.1:${port}`;

  try {
    // Verify that native Node fetch produces immutable headers
    const directFetch = await fetch(`${tunnelUrl}/check`);
    assert.throws(() => {
      directFetch.headers.set('Test-Mutate', 'fail');
    }, /immutable/i);

    const env = {
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                first: async () => {
                  if (sql.includes('FROM user_sessions')) return { id: 'user-1' };
                  if (sql.includes('FROM workspaces w')) {
                    return { id: 'ws-1', device_id: 'dev-1', dash_path: '/operator', member_role: 'admin' };
                  }
                  if (sql.includes('FROM devices')) {
                    return {
                      id: 'dev-1',
                      workspace_id: 'ws-1',
                      is_online: 1,
                      tunnel_url: tunnelUrl,
                      role: 'primary',
                      priority: 10
                    };
                  }
                  return null;
                }
              };
            }
          };
        }
      }
    };

    const response = await proxyRouter.request('https://site.test/operator/view', {
      headers: { Cookie: 'session=sess_test; last_ws_id=ws-1; last_dash_id=dash-1' }
    }, env);

    assert.equal(response.status, 200, 'Must return 200, not 502 tunnel_error');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'; sandbox");
    const json = await response.json();
    assert.equal(json.status, 'ok');
    assert.equal(json.value, 42);
  } finally {
    server.close();
  }
});

test('device-reported enterprise mode controls login and the complete authorization flow', async () => {
  // Start a REAL local HTTP server simulating an Enterprise device
  const receivedRequests = [];
  let currentDeviceEnterpriseMode = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      receivedRequests.push({ url: req.url, method: req.method, body });
      if (req.url === '/operator/mode') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ enterprise_mode: Boolean(currentDeviceEnterpriseMode) }));
        return;
      }
      if (req.url === '/operator/login' && req.method === 'POST') {
        const credentials = JSON.parse(body || '{}');
        if (credentials.login === 'admin' && credentials.password === 'enterprise_secret') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'mcrs_op_sess=token_enterprise_session_789; Path=/; HttpOnly'
          });
          res.end(JSON.stringify({ display_name: 'Главный инженер' }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_credentials', message: 'Неверный логин или пароль' }));
        }
        return;
      }
      if (req.url === '/operator/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'mcrs_op_sess=; Path=/; Max-Age=0'
        });
        res.end(JSON.stringify({ success: true }));
        return;
      }
      if (req.url === '/operator/command' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, executed: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'live' }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tunnelUrl = `http://127.0.0.1:${port}`;

  try {
    let currentMemberRole = 'viewer';

    const env = {
      DB: {
        prepare(sql) {
          return {
            bind(...params) {
              return {
                all: async () => ({ results: sql.includes('SELECT id, tunnel_url, is_online FROM devices')
                  ? [{ id: 'dev-ent', tunnel_url: tunnelUrl, is_online: 1 }] : [] }),
                first: async () => {
                  if (sql.includes('FROM user_sessions')) return { id: 'user-1' };
                  if (sql.includes('FROM dashboards d')) {
                    return {
                      dash_id: 'dash-ent',
                      dash_name: 'Enterprise Station',
                      dash_path: '/operator',
                      device_id: 'dev-ent',
                      workspace_id: 'ws-ent',
                      member_role: currentMemberRole
                    };
                  }
                  if (sql.includes('FROM workspaces w')) {
                    return {
                      id: 'ws-ent',
                      device_id: 'dev-ent',
                      dash_path: '/operator',
                      member_role: currentMemberRole
                    };
                  }
                  if (sql.includes('FROM devices')) {
                    return {
                      id: 'dev-ent',
                      workspace_id: 'ws-ent',
                      is_online: 1,
                      tunnel_url: tunnelUrl,
                      role: 'primary',
                      priority: 10
                    };
                  }
                  return null;
                }
              };
            }
          };
        }
      }
    };

    // Стандартный режим устройства не показывает форму Enterprise.
    currentDeviceEnterpriseMode = 0;
    const stdDevRes = await proxyRouter.request('https://site.test/view/org/ws-ent/dash-ent', {
      headers: { Cookie: 'session=sess_test' }
    }, env);
    assert.equal(stdDevRes.status, 200);
    const stdDevHtml = await stdDevRes.text();
    assert.ok(!stdDevHtml.includes('id="enterpriseLogin"'), 'Standard device must not show enterprise login');
    assert.ok(stdDevHtml.includes('"enterprise_mode":false'), 'Must have enterprise_mode: false');

    // Текущий Enterprise-режим устройства показывает форму входа.
    currentDeviceEnterpriseMode = 1;
    const entDevRes = await proxyRouter.request('https://site.test/view/org/ws-ent/dash-ent', {
      headers: { Cookie: 'session=sess_test' }
    }, env);
    assert.equal(entDevRes.status, 200);
    const entDevHtml = await entDevRes.text();
    assert.ok(entDevHtml.includes('id="enterpriseLogin"'), 'Enterprise device must render enterprise login');
    assert.ok(entDevHtml.includes('id="signIn"'), 'Enterprise device must render sign in button');
    assert.ok(entDevHtml.includes('"enterprise_mode":true'), 'Must have enterprise_mode: true');

    // 3. Language selection test
    // 3a. Default language is Russian
    assert.ok(entDevHtml.includes('Войти'), 'Default language should be ru');
    assert.ok(entDevHtml.includes('lang="ru"'));

    // 3b. Query param ?lang=en chooses English
    const enQueryRes = await proxyRouter.request('https://site.test/view/org/ws-ent/dash-ent?lang=en', {
      headers: { Cookie: 'session=sess_test' }
    }, env);
    assert.equal(enQueryRes.status, 200);
    const enQueryHtml = await enQueryRes.text();
    assert.ok(enQueryHtml.includes('Sign in'), 'English language must show English sign in button');
    assert.ok(enQueryHtml.includes('placeholder="Login"'));
    assert.ok(enQueryHtml.includes('lang="en"'));

    // 3c. Accept-Language header chooses English when no query param
    const enHeaderRes = await proxyRouter.request('https://site.test/view/org/ws-ent/dash-ent', {
      headers: { Cookie: 'session=sess_test', 'Accept-Language': 'en-US,en;q=0.9' }
    }, env);
    assert.equal(enHeaderRes.status, 200);
    const enHeaderHtml = await enHeaderRes.text();
    assert.ok(enHeaderHtml.includes('Sign in'), 'Accept-Language: en must select English');

    // 4. Asset versioning and immutable cache headers
    const jsPathMatch = entDevHtml.match(/<script src="(\/operator-static\/operator\.[a-f0-9]+\.js)"><\/script>/);
    assert.ok(jsPathMatch, 'Versioned script tag must exist');
    const versionedJsRes = await proxyRouter.request(`https://site.test${jsPathMatch[1]}`, {}, env);
    assert.equal(versionedJsRes.status, 200);
    assert.equal(versionedJsRes.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

    const cssPathMatch = entDevHtml.match(/<link rel="stylesheet" href="(\/operator-static\/operator\.[a-f0-9]+\.css)">/);
    assert.ok(cssPathMatch, 'Versioned stylesheet tag must exist');
    const versionedCssRes = await proxyRouter.request(`https://site.test${cssPathMatch[1]}`, {}, env);
    assert.equal(versionedCssRes.status, 200);
    assert.equal(versionedCssRes.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

    // 3. Invalid login credentials sent to device tunnel
    const invalidLoginRes = await proxyRouter.request('https://site.test/operator/login', {
      method: 'POST',
      headers: {
        Cookie: 'session=sess_test; last_ws_id=ws-ent; last_dash_id=dash-ent',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ login: 'admin', password: 'wrong_password' })
    }, env);
    assert.equal(invalidLoginRes.status, 401);
    const invalidBody = await invalidLoginRes.json();
    assert.equal(invalidBody.error, 'invalid_credentials');

    // 4. Valid login credentials: proxy returns 200 and device cookie is preserved
    const validLoginRes = await proxyRouter.request('https://site.test/operator/login', {
      method: 'POST',
      headers: {
        Cookie: 'session=sess_test; last_ws_id=ws-ent; last_dash_id=dash-ent',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ login: 'admin', password: 'enterprise_secret' })
    }, env);
    assert.equal(validLoginRes.status, 200);
    const cookies = validLoginRes.headers.getSetCookie();
    assert.ok(cookies.some(c => c.startsWith('mcrs_op_sess=token_enterprise_session_789')), 'Device session cookie must be preserved');
    const validBody = await validLoginRes.json();
    assert.equal(validBody.display_name, 'Главный инженер');

    // 5. User with viewer role is prohibited from executing commands
    currentMemberRole = 'viewer';
    const forbiddenCommand = await proxyRouter.request('https://site.test/operator/command', {
      method: 'POST',
      headers: {
        Cookie: 'session=sess_test; last_ws_id=ws-ent; last_dash_id=dash-ent',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ widget_id: 'w1', action: 'press' })
    }, env);
    assert.equal(forbiddenCommand.status, 403);

    // 6. User with admin role is permitted to execute commands
    currentMemberRole = 'admin';
    const allowedCommand = await proxyRouter.request('https://site.test/operator/command', {
      method: 'POST',
      headers: {
        Cookie: 'session=sess_test; last_ws_id=ws-ent; last_dash_id=dash-ent',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ widget_id: 'w1', action: 'press' })
    }, env);
    assert.equal(allowedCommand.status, 200);
    const cmdBody = await allowedCommand.json();
    assert.equal(cmdBody.executed, true);

    // 7. Logout is proxied and clears the cookie
    const logoutRes = await proxyRouter.request('https://site.test/operator/logout', {
      method: 'POST',
      headers: {
        Cookie: 'session=sess_test; last_ws_id=ws-ent; last_dash_id=dash-ent',
        'Content-Type': 'application/json'
      }
    }, env);
    assert.equal(logoutRes.status, 200);
    const logoutCookies = logoutRes.headers.getSetCookie();
    assert.ok(logoutCookies.some(c => c.startsWith('mcrs_op_sess=;') || c.includes('Max-Age=0')));
  } finally {
    server.close();
  }
});

test('dashboard probes a legacy backup device and pins operator requests to it', async () => {
  const tunnelCalls = [];
  let legacyEnterprise = true;
  const env = {
    DB: { prepare(sql) { return { bind(...params) { return {
      all: async () => ({ results: sql.includes('SELECT id, tunnel_url, is_online FROM devices')
        ? [
          { id: 'linked-offline', tunnel_url: null, is_online: 0 },
          { id: 'backup-enterprise', tunnel_url: null, is_online: 1 }
        ] : [] }),
      first: async () => {
        if (sql.includes('FROM user_sessions')) return { id: 'user-1' };
        if (sql.includes('FROM dashboards d')) return {
          dash_id: 'dash-1', dash_name: 'Panel', dash_path: '/operator',
          device_id: 'linked-offline', workspace_id: 'ws-1', member_role: 'admin'
        };
        if (sql.includes('SELECT id FROM devices WHERE id = ?')) {
          return params[0] === 'backup-enterprise' && params[1] === 'ws-1'
            ? { id: 'backup-enterprise' } : null;
        }
        return null;
      }
    }; } }; } },
    TUNNEL_DO: { idFromName: name => name, get: name => ({ fetch: async request => {
      const path = new URL(request.url).pathname;
      tunnelCalls.push([name, path]);
      if (name === 'linked-offline') return Response.json({ error: 'offline' }, { status: 503 });
      if (path === '/operator/mode') return Response.json({ error: 'not_found' }, { status: 404 });
      if (request.headers.get('Accept') === 'application/json') {
        return Response.json({ error: 'auth_failed', message: legacyEnterprise
          ? 'enterprise session is required' : 'operator web token is required' },
          { status: 401 });
      }
      return Response.json({ device: name });
    } }) }
  };

  const page = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test', 'Accept-Language': 'en;q=0,ru;q=1' }
  }, env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('id="enterpriseLogin"'));
  assert.ok(html.includes('lang="ru"'));
  assert.ok(html.includes('"dashboard_id":"dash-1"'));
  const pinnedCookie = page.headers.getSetCookie().find(cookie =>
    cookie.startsWith('operator_dev_dash-1='));
  assert.ok(pinnedCookie?.includes('backup-enterprise'));

  const beforeOperator = tunnelCalls.length;
  const view = await proxyRouter.request('https://site.test/operator/view', {
    headers: {
      Cookie: `session=sess_test; ${pinnedCookie.split(';')[0]}`,
      Referer: 'https://site.test/view/org/ws/dash-1'
    }
  }, env);
  assert.equal(view.status, 200);
  assert.deepEqual(await view.json(), { device: 'backup-enterprise' });
  assert.deepEqual(tunnelCalls.slice(beforeOperator), [['backup-enterprise', '/operator/view']]);

  const noReferer = await proxyRouter.request('https://site.test/operator/view?dash_id=dash-1', {
    headers: { Cookie: `session=sess_test; ${pinnedCookie.split(';')[0]}` }
  }, env);
  assert.equal(noReferer.status, 200);
  assert.deepEqual(await noReferer.json(), { device: 'backup-enterprise' });

  legacyEnterprise = false;
  const standardPage = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal(standardPage.status, 200);
  assert.ok(!(await standardPage.text()).includes('id="enterpriseLogin"'));
});

test('offline dashboard shows a trusted localized page without guessing the login mode', async () => {
  const env = { DB: { prepare(sql) { return { bind() { return {
    first: async () => sql.includes('FROM user_sessions') ? { id: 'user-1' }
      : sql.includes('FROM dashboards d') ? {
        dash_id: 'dash-1', dash_name: 'Panel', dash_path: '/operator',
        device_id: 'dev-1', workspace_id: 'ws-1', member_role: 'viewer'
      } : null,
    all: async () => ({ results: [] })
  }; } }; } } };
  const page = await proxyRouter.request('https://site.test/view/org/ws/dash-1', {
    headers: { Cookie: 'session=sess_test', 'Accept-Language': 'en-US,en;q=0.9' }
  }, env);
  assert.equal(page.status, 503);
  assert.equal(page.headers.get('Content-Type'), 'text/html; charset=utf-8');
  const html = await page.text();
  assert.ok(html.includes('The device panel is unavailable'));
  assert.ok(!html.includes('id="enterpriseLogin"'));
  assert.ok(!html.includes('id="operatorConfig"'));
});

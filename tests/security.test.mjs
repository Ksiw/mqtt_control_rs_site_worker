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
    types: 'src/types.ts'
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
  const deleteQuery = batched.find(s => s.sql.includes('DELETE FROM dashboards'));
  assert.ok(deleteQuery);
  assert.ok(!deleteQuery.sql.includes(maliciousId));
  assert.ok(deleteQuery.params.includes(`dev_test_${maliciousId}`));

  // Старые записи могли хранить более короткий префикс ключа.
  device.key_prefix = key.slice(0, 12);
  assert.equal((await request('heartbeat', body, headers)).status, 200);

  const unlinkBody = '{}';
  headers['X-Signature'] = createHmac('sha256', key).update(timestamp + unlinkBody).digest('hex');
  assert.equal((await request('unlink', unlinkBody, headers)).status, 200);
});

test('webhook не принимает неподписанное уведомление и учитывает платёж один раз', async () => {
  const secret = 'test-ipn-secret';
  const payload = { order_id: 'sub_org_test_month_1', payment_status: 'confirmed' };
  const body = JSON.stringify(payload);
  const payment = {
    id: 'pay_test', org_id: 'org_test', duration_days: 30,
    payment_status: 'waiting', applied_at: null
  };
  let applied = 0;
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            sql,
            first: async () => sql.includes('FROM payments WHERE order_id') ? { ...payment } :
              sql.includes('FROM subscriptions WHERE org_id') ? { plan_tier: 'free', current_period_end: 0 } : null
          };
        }
      };
    },
    batch: async statements => {
      assert.equal(statements.length, 2);
      assert.match(statements[0].sql, /applied_at IS NULL/);
      assert.match(statements[1].sql, /applied_at IS NULL/);
      applied++;
      payment.applied_at = Math.floor(Date.now() / 1000);
      return [];
    }
  };
  const request = (env, signature) => billingRouter.request('https://example.test/webhook', {
    method: 'POST', body,
    headers: signature ? { 'x-nowpayments-sig': signature } : {}
  }, env);

  assert.equal((await request({ DB: db }, null)).status, 503);
  assert.equal((await request({ DB: db, NOWPAYMENTS_IPN_SECRET: secret }, 'bad')).status, 403);
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal((await request({ DB: db, NOWPAYMENTS_IPN_SECRET: secret }, signature)).status, 200);
  assert.equal((await request({ DB: db, NOWPAYMENTS_IPN_SECRET: secret }, signature)).status, 200);
  assert.equal(applied, 1);
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
    dashboards: [{ id: 'dash_test', device_id: 'dev_test', ws_slug: 'main', org_slug: 'test', name: attack, slug: '/operator', is_online: 1 }],
    members: [], pendingInvites: [], planTier: 'free', maxDevices: 1,
    maxMembers: 5, isOwner: true
  });
  assert.ok(!html.includes(attack));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
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

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDir = await mkdtemp(join(tmpdir(), 'mcrs-panel-test-'));
after(() => rm(outputDir, { recursive: true, force: true }));
await build({ entryPoints: ['src/proxy.ts'], outfile: join(outputDir, 'proxy.mjs'),
  bundle: true, platform: 'node', format: 'esm' });
const { proxyRouter } = await import(join(outputDir, 'proxy.mjs'));

const panelOrigin = 'https://mqtt-control-rs-site-worker.stewhiki.workers.dev';
const dashboardId = 'dev-1_tab_7';
const assetName = '0123456789abcdef.js';

function mockEnvironment() {
  const tokens = new Map();
  const calls = [];
  let role = 'admin';
  let accountActive = true;
  let primaryOnline = true;
  return {
    calls,
    setRole(value) { role = value; },
    setAccountActive(value) { accountActive = value; },
    setPrimaryOnline(value) { primaryOnline = value; },
    env: {
      HUB_DOMAIN: 'https://mqtt-control-rs.pages.dev',
      DB: { prepare(sql) { return { bind(...params) { return {
        async run() {
          if (sql.includes('INSERT INTO dashboard_access_tokens')) {
            tokens.set(params[0], { user_id: params[1], dashboard_id: params[2],
              account_session_token: params[3],
              kind: sql.includes("'ticket'") ? 'ticket' : 'session', expires_at: params[4] });
          }
          return { success: true };
        },
        async first() {
          if (sql.includes('FROM user_sessions s')) return { id: 'user-1' };
          if (sql.includes('DELETE FROM dashboard_access_tokens')) {
            const row = tokens.get(params[0]);
            if (row?.kind !== 'ticket' || row.expires_at <= params[1]) return null;
            tokens.delete(params[0]);
            return row;
          }
          if (sql.includes('FROM dashboard_access_tokens')) {
            const row = tokens.get(params[0]);
            return accountActive && row?.kind === 'session' && row.dashboard_id === params[1] &&
              row.account_session_token === 'sess_test' && row.expires_at > params[2] ? row : null;
          }
          if (sql.includes('SELECT id FROM devices WHERE id = ?')) {
            return ['dev-1', 'dev-2'].includes(params[0]) ? { id: params[0] } : null;
          }
          if (sql.includes('FROM dashboards d')) {
            return { id: dashboardId, dash_id: dashboardId, dash_name: 'Panel',
              dash_path: '/operator?tab=7', device_id: 'dev-1', workspace_id: 'ws-1',
              member_role: role };
          }
          if (sql.includes('FROM devices')) return { id: 'dev-1', workspace_id: 'ws-1',
            tunnel_url: 'direct_ws' };
          return null;
        },
        async all() {
          if (sql.includes('SELECT id, tunnel_url, is_online FROM devices')) {
            return { results: [
              { id: 'dev-1', tunnel_url: null, is_online: primaryOnline ? 1 : 0 },
              { id: 'dev-2', tunnel_url: null, is_online: 1 }
            ] };
          }
          if (sql.includes('FROM devices dev')) {
            return { results: [{ id: dashboardId, org_slug: 'org', ws_slug: 'ws' }] };
          }
          return { results: [] };
        }
      }; } }; } },
      TUNNEL_DO: { idFromName: value => value, get: deviceId => ({ fetch: async request => {
        const path = new URL(request.url).pathname;
        calls.push({ deviceId, path, prefix: request.headers.get('X-Operator-Asset-Prefix'),
          cookie: request.headers.get('Cookie') });
        if (deviceId === 'dev-1' && !primaryOnline) return Response.json({ error: 'offline' }, { status: 503 });
        if (path === '/operator/mode') return Response.json({ enterprise_mode: false });
        if (path === '/operator') return new Response('<!doctype html><title>From device</title>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        if (path === `/operator/assets/${assetName}`) return new Response('console.log(1)',
          { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
        if (path === '/operator/view') return Response.json({ view: { tabs: [] } });
        return Response.json({ ok: true });
      } }) }
    }
  };
}

test('cabinet link opens the device page on an isolated origin and keeps assets cacheable', async () => {
  const { env, calls } = mockEnvironment();
  const unsignedQr = await proxyRouter.request('https://site.test/view/device/mcrs_live_abcdef/7', {}, env);
  assert.equal(unsignedQr.status, 302);
  assert.equal(unsignedQr.headers.get('Location'), '/cabinet');
  assert.ok(unsignedQr.headers.getSetCookie().some(cookie => cookie.startsWith('dashboard_return=')));
  const qr = await proxyRouter.request('https://site.test/view/device/mcrs_live_abcdef/7',
    { headers: { Cookie: 'session=sess_test' } }, env);
  assert.equal(qr.status, 302);
  assert.equal(qr.headers.get('Location'), `/view/org/ws/${dashboardId}`);

  const handoff = await proxyRouter.request(`https://site.test/view/org/ws/${dashboardId}`,
    { headers: { Cookie: 'session=sess_test' } }, env);
  assert.equal(handoff.status, 302);
  const ticketUrl = handoff.headers.get('Location');
  assert.ok(ticketUrl.startsWith(`${panelOrigin}/panel/open?ticket=`));
  assert.equal(handoff.headers.get('Referrer-Policy'), 'no-referrer');

  const opened = await proxyRouter.request(ticketUrl, {}, env);
  assert.equal(opened.status, 303);
  assert.equal(opened.headers.get('Location'), `/panel/${dashboardId}/?tab=7`);
  const panelCookie = opened.headers.getSetCookie().find(value =>
    value.startsWith(`dashboard_panel_${dashboardId}=`)).split(';')[0];
  assert.ok(opened.headers.getSetCookie().every(value => value.includes('HttpOnly')));
  assert.equal((await proxyRouter.request(ticketUrl, {}, env)).status, 403);

  const page = await proxyRouter.request(`${panelOrigin}/panel/${dashboardId}/?tab=7`,
    { headers: { Cookie: panelCookie } }, env);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('From device'));
  assert.ok(calls.some(call => call.path === '/operator' &&
    call.prefix === `/panel/${dashboardId}/assets/` && call.cookie === null));
  const cookies = page.headers.getSetCookie().map(value => value.split(';')[0]);
  const asset = await proxyRouter.request(`${panelOrigin}/panel/${dashboardId}/assets/${assetName}`,
    { headers: { Cookie: `${panelCookie}; ${cookies.join('; ')}` } }, env);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  assert.equal(await asset.text(), 'console.log(1)');
});

test('panel commands require the bound dashboard and current member role', async () => {
  const state = mockEnvironment();
  const { env } = state;
  const handoff = await proxyRouter.request(`https://site.test/view/org/ws/${dashboardId}`,
    { headers: { Cookie: 'session=sess_test' } }, env);
  const opened = await proxyRouter.request(handoff.headers.get('Location'), {}, env);
  const cookie = opened.headers.getSetCookie()[0].split(';')[0];
  const other = await proxyRouter.request(`${panelOrigin}/operator/command?dash_id=dev-2_tab_1`,
    { method: 'POST', headers: { Cookie: cookie }, body: '{}' }, env);
  assert.equal(other.status, 401);
  state.setRole('viewer');
  const denied = await proxyRouter.request(`${panelOrigin}/operator/command?dash_id=${dashboardId}`,
    { method: 'POST', headers: { Cookie: cookie }, body: '{}' }, env);
  assert.equal(denied.status, 403);
  const legacyView = await proxyRouter.request(`${panelOrigin}/operator/view`, {
    headers: { Cookie: cookie, Referer: `${panelOrigin}/panel/${dashboardId}/?tab=7` }
  }, env);
  assert.equal(legacyView.status, 200);
  state.setAccountActive(false);
  const afterLogout = await proxyRouter.request(`${panelOrigin}/operator/view?dash_id=${dashboardId}`,
    { headers: { Cookie: cookie } }, env);
  assert.equal(afterLogout.status, 401);
});

test('panel data requests switch to a live backup when the pinned device disconnects', async () => {
  const state = mockEnvironment();
  const { env } = state;
  const handoff = await proxyRouter.request(`https://site.test/view/org/ws/${dashboardId}`,
    { headers: { Cookie: 'session=sess_test' } }, env);
  const opened = await proxyRouter.request(handoff.headers.get('Location'), {}, env);
  const panelCookie = opened.headers.getSetCookie()[0].split(';')[0];
  state.setPrimaryOnline(false);
  const view = await proxyRouter.request(`${panelOrigin}/operator/view?dash_id=${dashboardId}`, {
    headers: { Cookie: `${panelCookie}; operator_dev_${dashboardId}=dev-1` }
  }, env);
  assert.equal(view.status, 200);
  assert.ok(view.headers.getSetCookie().some(cookie =>
    cookie.startsWith(`operator_dev_${dashboardId}=dev-2`)));
  assert.ok(state.calls.some(call => call.deviceId === 'dev-2' && call.path === '/operator/view'));
});

import { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { Env, Device } from '../types';
import { buildCleanHeaders, proxyResponse, tunnelTarget } from '../proxy/shared';
import { selectOperatorDevice } from '../proxy/operator_device';
import { dashboardSession, exchangeDashboardTicket, isPanelOrigin, PANEL_COOKIE } from './access';

type PanelContext = Context<{ Bindings: Env }>;
type Dashboard = { id: string; device_id: string | null; workspace_id: string };

export const panelRouter = new Hono<{ Bindings: Env }>();

async function authorizedDashboard(c: PanelContext, dashboardId: string): Promise<Dashboard | null> {
  const session = await dashboardSession(c, dashboardId);
  if (!session) return null;
  return c.env.DB.prepare(`
    SELECT d.id, d.device_id, w.id as workspace_id
    FROM dashboards d
    JOIN workspaces w ON w.id = d.workspace_id
    JOIN organization_members m ON m.org_id = w.org_id AND m.user_id = ?
    WHERE d.id = ? LIMIT 1
  `).bind(session.userId, dashboardId).first<Dashboard>();
}

async function activeDevice(c: PanelContext, dashboard: Dashboard, preferPinned: boolean): Promise<string | null> {
  const pinnedId = preferPinned ? getCookie(c, 'operator_dev_' + dashboard.id) : null;
  if (pinnedId) {
    const pinned = await c.env.DB.prepare(
      'SELECT id FROM devices WHERE id = ? AND workspace_id = ? LIMIT 1'
    ).bind(pinnedId, dashboard.workspace_id).first<{ id: string }>();
    if (pinned) return pinned.id;
  }
  const selected = await selectOperatorDevice(c.env, dashboard.workspace_id, dashboard.device_id);
  return selected?.id || null;
}

async function deviceResponse(c: PanelContext, dashboard: Dashboard, deviceId: string,
  path: string, accept: string): Promise<Response | null> {
  if (c.env.TUNNEL_DO) {
    try {
      const stub = c.env.TUNNEL_DO.get(c.env.TUNNEL_DO.idFromName(deviceId));
      const headers = buildCleanHeaders(c.req.raw.headers, 'tunnel.internal');
      headers.set('Accept', accept);
      if (path === '/operator') {
        headers.set('X-Operator-Asset-Prefix', `/panel/${dashboard.id}/assets/`);
      }
      const response = await stub.fetch(new Request(new URL(path, 'https://tunnel.internal'), { headers }));
      if (response.status !== 503) return response;
    } catch {}
  }
  const device = await c.env.DB.prepare(`
    SELECT * FROM devices WHERE id = ? AND workspace_id = ? LIMIT 1
  `).bind(deviceId, dashboard.workspace_id).first<Device>();
  if (!device?.tunnel_url || device.tunnel_url === 'direct_ws') return null;
  const target = tunnelTarget(device.tunnel_url, path);
  if (!target) return null;
  const headers = buildCleanHeaders(c.req.raw.headers, target.host);
  headers.set('Accept', accept);
  if (path === '/operator') {
    headers.set('X-Operator-Asset-Prefix', `/panel/${dashboard.id}/assets/`);
  }
  return fetch(new Request(target.toString(), { headers, redirect: 'manual' }));
}

panelRouter.get('/open', async c => {
  if (!isPanelOrigin(c)) return c.notFound();
  const result = await exchangeDashboardTicket(c, c.req.query('ticket') || '');
  if (!result) return c.text('Ссылка для открытия панели недействительна', 403);
  setCookie(c, PANEL_COOKIE + result.dashboardId, result.token, {
    path: '/', maxAge: 86400, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  const tab = result.dashboardId.match(/_tab_(\d+)$/)?.[1];
  const response = c.redirect(`/panel/${encodeURIComponent(result.dashboardId)}/${tab ? `?tab=${tab}` : ''}`, 303);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
});

panelRouter.get('/:dashboardId/', async c => {
  if (!isPanelOrigin(c)) return c.notFound();
  const dashboard = await authorizedDashboard(c, c.req.param('dashboardId'));
  if (!dashboard) return c.text('Доступ к панели истёк или отозван', 403);
  const deviceId = await activeDevice(c, dashboard, false);
  if (!deviceId) return c.text('Хост-программа не подключена к хабу', 503);
  setCookie(c, 'operator_dev_' + dashboard.id, deviceId, {
    path: '/', maxAge: 86400, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  const upstream = await deviceResponse(c, dashboard, deviceId, '/operator', 'text/html');
  if (!upstream || upstream.status !== 200 ||
      !(upstream.headers.get('content-type') || '').toLowerCase().startsWith('text/html')) {
    return c.text('Сервер ПО не вернул страницу дашборда', 502);
  }
  const response = proxyResponse(c, upstream);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  return response;
});

panelRouter.get('/:dashboardId/assets/:name', async c => {
  if (!isPanelOrigin(c)) return c.notFound();
  const dashboard = await authorizedDashboard(c, c.req.param('dashboardId'));
  if (!dashboard) return c.text('Доступ к ресурсу отозван', 403);
  const name = c.req.param('name');
  if (!/^[a-f0-9]{16}\.(js|css)$/.test(name)) return c.notFound();
  const deviceId = await activeDevice(c, dashboard, true);
  if (!deviceId) return c.text('Хост-программа не подключена к хабу', 503);
  const upstream = await deviceResponse(c, dashboard, deviceId,
    `/operator/assets/${name}`, name.endsWith('.js') ? 'application/javascript' : 'text/css');
  const expectedType = name.endsWith('.js') ? 'application/javascript' : 'text/css';
  if (!upstream || upstream.status !== 200 ||
      !(upstream.headers.get('content-type') || '').toLowerCase().startsWith(expectedType)) {
    return c.text('Ресурс дашборда недоступен', 502);
  }
  const response = proxyResponse(c, upstream);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  return response;
});

import { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { Env, Device } from './types';
import { buildCleanHeaders, storedOperatorToken, tunnelTarget, proxyResponse } from './proxy/shared';
import { selectOperatorDevice } from './proxy/operator_device';
import { getCurrentUser } from './core/session';
import { dashboardSession, isPanelOrigin, issueDashboardTicket, PANEL_ORIGIN } from './operator/access';
import { panelRouter } from './operator/panel';
import { safeAuthReturn } from './core/auth_return';

export const proxyRouter = new Hono<{ Bindings: Env }>();

const ALLOWED_OPERATOR_PATHS: Record<string, string[]> = {
  '/operator/view': ['GET', 'HEAD'],
  '/operator/events': ['GET', 'HEAD'],
  '/operator/command': ['GET', 'HEAD', 'POST'],
  '/operator/login': ['POST'],
  '/operator/logout': ['POST'],
};

function sanitizeOperatorResponse(c: Context<{ Bindings: Env }>, upstream: Response,
  asset = false): Response {
  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  const dangerousTypes = [
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'application/xml',
    'application/javascript',
    'text/javascript',
    'application/ecmascript',
  ];
  const expectedAsset = c.req.path.endsWith('.js') ? 'application/javascript' : 'text/css';
  if ((asset && !contentType.startsWith(expectedAsset)) ||
      (!asset && dangerousTypes.some((type) => contentType.includes(type)))) {
    console.error(`Blocked dangerous device content-type: ${contentType}`);
    return c.json({
      error: 'invalid_device_content_type',
      message: 'Устройство вернуло недопустимый формат данных'
    }, 502);
  }
  const res = proxyResponse(c, upstream);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  if (!asset) res.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  return res;
}

async function dashboardDevice(
  c: Context<{ Bindings: Env }>, dashboardId: string, workspaceId: string,
  linkedDeviceId: string | null,
): Promise<string | null | undefined> {
  const pinnedId = getCookie(c, 'operator_dev_' + dashboardId);
  if (!pinnedId) return linkedDeviceId;
  const pinned = await c.env.DB.prepare(
    'SELECT id FROM devices WHERE id = ? AND workspace_id = ? LIMIT 1'
  ).bind(pinnedId, workspaceId).first<{ id: string }>();
  return pinned?.id;
}

function rememberDashboardReturn(c: Context<{ Bindings: Env }>): Response {
  const path = new URL(c.req.url).pathname;
  if (safeAuthReturn(path)) setCookie(c, 'dashboard_return', path, {
    path: '/', maxAge: 900, httpOnly: true, secure: true, sameSite: 'Lax',
  });
  return c.redirect('/cabinet');
}

const handleDashboardPage = async (c: Context<{ Bindings: Env }>) => {
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    return c.text('Метод не поддерживается', 405);
  }

  const user = await getCurrentUser(c);
  if (!user) return rememberDashboardReturn(c);

  const { org_slug, ws_slug, dash_id } = c.req.param();

  const query = `
    SELECT d.id as dash_id, d.name as dash_name, d.slug as dash_path, linked_device.id as device_id,
           w.id as workspace_id, m.role as member_role
    FROM dashboards d
    JOIN workspaces w ON d.workspace_id = w.id
    LEFT JOIN devices linked_device ON linked_device.id = d.device_id
      AND linked_device.workspace_id = w.id
    JOIN organizations o ON w.org_id = o.id
    JOIN organization_members m ON m.org_id = o.id AND m.user_id = ?
    WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
    LIMIT 1
  `;
  const dashInfo = await c.env.DB.prepare(query)
    .bind(user.id, org_slug, ws_slug, dash_id, `%${dash_id}%`)
    .first<{ dash_id: string; dash_name: string; dash_path: string; device_id?: string;
      workspace_id: string; member_role: string }>();

  if (!dashInfo) {
    const exists = await c.env.DB.prepare(`
      SELECT 1 FROM dashboards d
      JOIN workspaces w ON d.workspace_id = w.id
      JOIN organizations o ON w.org_id = o.id
      WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
      LIMIT 1
    `).bind(org_slug, ws_slug, dash_id, `%${dash_id}%`).first();

    if (exists) {
      return c.html(`
        <!DOCTYPE html>
        <html lang="ru">
        <head><meta charset="utf-8"><title>Доступ ограничен</title>
        <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .card{background:#1e293b;padding:32px;border-radius:12px;border:1px solid #334155;text-align:center;max-width:440px;}
        h1{font-size:20px;color:#ef4444;margin:0 0 12px;}p{font-size:14px;color:#94a3b8;line-height:1.5;margin:0;}
        a{color:#38bdf8;text-decoration:none;margin-top:16px;display:inline-block;}
        </style></head>
        <body><div class="card"><h1>Доступ ограничен</h1><p>У вас нет доступа к этой организации или рабочему пространству. Войдите с аккаунта, приглашенного владельцем.</p><a href="/cabinet">Вернуться в кабинет</a></div></body></html>
      `, 403);
    }
    return c.text('Дашборд или рабочее пространство не найдено', 404);
  }

  if (dashInfo.dash_path) {
    const rawPath = dashInfo.dash_path;
    if (!rawPath.startsWith('/') || rawPath.startsWith('//')) {
      return c.text('Некорректный путь дашборда', 502);
    }
    try {
      const parsed = new URL(rawPath, 'https://tunnel.internal');
      if (parsed.origin !== 'https://tunnel.internal') {
        return c.text('Некорректный путь дашборда', 502);
      }
    } catch {
      return c.text('Некорректный путь дашборда', 502);
    }
  }

  const selectedDevice = await selectOperatorDevice(
    c.env, dashInfo.workspace_id, dashInfo.device_id || null,
  );
  if (!selectedDevice) {
    return c.text('Хост-программа не подключена к хабу', 503);
  }
  const ticket = await issueDashboardTicket(c, user.id, dashInfo.dash_id);
  const response = c.redirect(`${PANEL_ORIGIN}/panel/open?ticket=${ticket}`, 302);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
};

proxyRouter.get('/view/device/:prefix/:tab_id', async c => {
  const user = await getCurrentUser(c);
  if (!user) return rememberDashboardReturn(c);
  const { prefix, tab_id } = c.req.param();
  if (!/^mcrs_live_[a-f0-9]{6}$/.test(prefix) || !/^\d+$/.test(tab_id)) return c.notFound();
  const result = await c.env.DB.prepare(`
    SELECT d.id, o.slug as org_slug, w.slug as ws_slug
    FROM devices dev
    JOIN dashboards d ON d.device_id = dev.id AND d.id = dev.id || '_tab_' || ?
    JOIN workspaces w ON w.id = dev.workspace_id
    JOIN organizations o ON o.id = w.org_id
    JOIN organization_members m ON m.org_id = o.id AND m.user_id = ?
    WHERE dev.key_prefix = ? LIMIT 2
  `).bind(tab_id, user.id, prefix).all<{
    id: string; org_slug: string; ws_slug: string;
  }>();
  if (!result.results?.length) return c.notFound();
  if (result.results.length > 1) return c.text('Неоднозначная ссылка на дашборд', 409);
  const dashboard = result.results[0];
  return c.redirect(`/view/${encodeURIComponent(dashboard.org_slug)}/${encodeURIComponent(dashboard.ws_slug)}/${encodeURIComponent(dashboard.id)}`);
});
proxyRouter.get('/view/:org_slug/:ws_slug/:dash_id', handleDashboardPage);
proxyRouter.route('/panel', panelRouter);

// Прямая поддержка строго разрешённых подзапросов операторского интерфейса
proxyRouter.all('/operator/*', async (c) => {
  const asset = /^\/operator\/assets\/[a-f0-9]{16}\.(?:js|css)$/.test(c.req.path);
  const allowedMethods = asset ? ['GET', 'HEAD'] : ALLOWED_OPERATOR_PATHS[c.req.path];
  if (!allowedMethods) {
    return c.json({ error: 'not_found', message: 'Маршрут не найден' }, 404);
  }
  if (!allowedMethods.includes(c.req.method)) {
    return c.json({ error: 'method_not_allowed', message: 'Метод не поддерживается' }, 405);
  }

  const panelReferer = c.req.header('Referer');
  let refererPanelId = '';
  if (isPanelOrigin(c) && panelReferer) {
    try {
      const parsed = new URL(panelReferer);
      if (parsed.origin === PANEL_ORIGIN) {
        refererPanelId = parsed.pathname.match(/^\/panel\/([a-zA-Z0-9_-]+)\//)?.[1] || '';
      }
    } catch {}
  }
  const requestedPanelId = c.req.query('dash_id') || refererPanelId;
  const panel = isPanelOrigin(c) ? await dashboardSession(c, requestedPanelId) : null;
  const user = panel ? { id: panel.userId } : isPanelOrigin(c) ? null : await getCurrentUser(c);
  if (!user) {
    return c.json({ error: 'unauthorized', message: 'Требуется авторизация в аккаунте' }, 401);
  }

  let wsId: string | null = null;
  let devId: string | null | undefined = null;
  let memberRole: string | null = null;
  let dashboardPath: string | null = null;
  const requestedDashboardId = panel?.dashboardId || c.req.query('dash_id');
  if (requestedDashboardId) {
    const found = await c.env.DB.prepare(`
      SELECT d.id as dash_id, linked_device.id as device_id,
             w.id as workspace_id, d.slug as dash_path, m.role as member_role
      FROM dashboards d
      JOIN workspaces w ON d.workspace_id = w.id
      LEFT JOIN devices linked_device ON linked_device.id = d.device_id
        AND linked_device.workspace_id = w.id
      JOIN organization_members m ON m.org_id = w.org_id AND m.user_id = ?
      WHERE d.id = ? LIMIT 1
    `).bind(user.id, requestedDashboardId)
      .first<{ dash_id: string; device_id: string | null; workspace_id: string;
        dash_path: string | null; member_role: string }>();
    if (!found) return c.json({ error: 'not_found', message: 'Дашборд не найден' }, 404);
    wsId = found.workspace_id;
    devId = await dashboardDevice(c, found.dash_id, wsId, found.device_id);
    memberRole = found.member_role;
    dashboardPath = found.dash_path;
  }
  const referer = c.req.header('Referer');
  if (!panel && !wsId && referer) {
    const match = referer.match(/\/view\/([^\/]+)\/([^\/]+)\/([^\/?#]+)/);
    if (match) {
      const [_, org_slug, ws_slug, dash_id] = match;
      const query = `
        SELECT d.id as dash_id, linked_device.id as device_id,
               w.id as workspace_id, d.slug as dash_path,
               m.role as member_role
        FROM dashboards d
        JOIN workspaces w ON d.workspace_id = w.id
        LEFT JOIN devices linked_device ON linked_device.id = d.device_id
          AND linked_device.workspace_id = w.id
        JOIN organizations o ON w.org_id = o.id
        JOIN organization_members m ON m.org_id = o.id AND m.user_id = ?
        WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
        LIMIT 1
      `;
      const found = await c.env.DB.prepare(query)
        .bind(user.id, org_slug, ws_slug, dash_id, `%${dash_id}%`)
        .first<{ dash_id: string; device_id?: string; workspace_id: string; dash_path: string;
          member_role: string }>();
      if (found) {
        wsId = found.workspace_id;
        devId = await dashboardDevice(c, found.dash_id, wsId, found.device_id || null);
        memberRole = found.member_role;
        dashboardPath = found.dash_path;
      }
    }
  }

  if (!panel && !wsId) {
    const candidateWs = getCookie(c, 'last_ws_id');
    if (candidateWs) {
      const allowed = await c.env.DB.prepare(`
        SELECT w.id, linked_device.id as device_id, m.role as member_role,
               selected_dashboard.slug as dash_path
        FROM workspaces w
        JOIN organization_members m ON m.org_id = w.org_id
        LEFT JOIN devices linked_device ON linked_device.id = ?
          AND linked_device.workspace_id = w.id
        LEFT JOIN dashboards selected_dashboard ON selected_dashboard.id = ?
          AND selected_dashboard.workspace_id = w.id
        WHERE w.id = ? AND m.user_id = ?
        LIMIT 1
      `).bind(getCookie(c, 'last_dev_id') || '', getCookie(c, 'last_dash_id') || '',
        candidateWs, user.id)
        .first<{ id: string; device_id: string | null; member_role: string;
          dash_path: string | null }>();
      if (allowed) {
        wsId = candidateWs;
        devId = allowed.device_id;
        memberRole = allowed.member_role;
        dashboardPath = allowed.dash_path;
      }
    }
  }

  if (!wsId) {
    return c.json({ error: 'No active workspace found for operator request', message: 'Рабочее пространство не определено или нет доступа' }, 404);
  }
  if (devId === undefined) {
    return c.json({ error: 'device_offline', message: 'Выбранное устройство недоступно' }, 503);
  }

  const isAuthRoute = c.req.path === '/operator/login' || c.req.path === '/operator/logout';
  if (memberRole === 'viewer' && !isAuthRoute &&
      (!['GET', 'HEAD'].includes(c.req.method) ||
        c.req.header('Upgrade')?.toLowerCase() === 'websocket')) {
    return c.json({ error: 'forbidden', message: 'Недостаточно прав для управления дашбордом' }, 403);
  }

  let targetPath = c.req.path;
  const queryIdx = c.req.url.indexOf('?');
  if (queryIdx !== -1) {
    targetPath += c.req.url.slice(queryIdx);
  }

  // Проброс токена оператора
  let token = c.req.query('token') || c.req.header('X-Operator-Token');
  if (!token && dashboardPath) token = storedOperatorToken(dashboardPath);
  if (!token && wsId) token = getCookie(c, 'op_token_' + wsId) || undefined;

  const reqBody = ['GET', 'HEAD'].includes(c.req.method)
    ? undefined
    : await c.req.raw.arrayBuffer();

  // 1. Прямой защищенный канал через Durable Object
  const operatorTargets = [devId || wsId].filter(Boolean) as string[];
  if (c.env.TUNNEL_DO && operatorTargets.length > 0) {
    for (const targetId of operatorTargets) {
      try {
        const doId = c.env.TUNNEL_DO.idFromName(targetId);
        const stub = c.env.TUNNEL_DO.get(doId);
        const doRequestUrl = new URL(targetPath, 'https://tunnel.internal');
        if (token && !doRequestUrl.searchParams.has('token')) {
          doRequestUrl.searchParams.set('token', token);
        }
        const forwardHeaders = buildCleanHeaders(c.req.raw.headers, 'tunnel.internal');
        if (token) {
          forwardHeaders.set('X-Operator-Token', token);
        }
        const doResponse = await stub.fetch(new Request(doRequestUrl.toString(), {
          method: c.req.method,
          headers: forwardHeaders,
          body: reqBody,
        }));
        if (doResponse.status !== 503) {
          return sanitizeOperatorResponse(c, doResponse, asset);
        }
      } catch (_) {}
    }
  }

  if (panel && c.env.TUNNEL_DO && wsId && devId) {
    const replacement = await selectOperatorDevice(c.env, wsId, devId);
    if (replacement && replacement.id !== devId) {
      devId = replacement.id;
      setCookie(c, 'operator_dev_' + panel.dashboardId, devId, {
        path: '/', maxAge: 86400, httpOnly: true, secure: true, sameSite: 'Lax',
      });
      if (c.env.TUNNEL_DO) {
        try {
          const stub = c.env.TUNNEL_DO.get(c.env.TUNNEL_DO.idFromName(devId));
          const url = new URL(targetPath, 'https://tunnel.internal');
          if (token && !url.searchParams.has('token')) url.searchParams.set('token', token);
          const headers = buildCleanHeaders(c.req.raw.headers, 'tunnel.internal');
          if (token) headers.set('X-Operator-Token', token);
          const response = await stub.fetch(new Request(url, {
            method: c.req.method, headers, body: reqBody,
          }));
          if (response.status !== 503) return sanitizeOperatorResponse(c, response, asset);
        } catch {}
      }
    }
  }

  // 2. Fallback: поиск устройства со статическим туннелем
  const device = await c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND (? = '' OR id = ?)
      AND (? != '' OR is_online = 1)
      AND tunnel_url IS NOT NULL AND tunnel_url != 'direct_ws'
    ORDER BY CASE WHEN role = 'primary' THEN 1 ELSE 2 END ASC, priority DESC
    LIMIT 1
  `).bind(wsId, devId || '', devId || '', devId || '').first<Device>();

  if (!device || !device.tunnel_url) {
    return c.json({ error: 'Host device is offline', message: 'Хост-программа не подключена к хабу' }, 503);
  }

  const targetUrl = tunnelTarget(device.tunnel_url, targetPath);
  if (!targetUrl) {
    return c.json({ error: 'tunnel_error', message: 'Некорректный адрес туннеля' }, 502);
  }
  const forwardHeaders = buildCleanHeaders(c.req.raw.headers, targetUrl.host);
  if (token) {
    forwardHeaders.set('X-Operator-Token', token);
    if (!targetUrl.searchParams.has('token')) {
      targetUrl.searchParams.set('token', token);
    }
  }

  try {
    const upgradeHeader = c.req.header('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return sanitizeOperatorResponse(c, await fetch(targetUrl.toString(), {
        headers: forwardHeaders,
        // @ts-ignore
        cf: { websocketHandling: 'raw' }
      }), asset);
    }

    return sanitizeOperatorResponse(c, await fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardHeaders,
      body: reqBody,
      redirect: 'manual',
    })), asset);
  } catch (err) {
    console.error('Operator tunnel request failed', err);
    return c.json({ error: 'tunnel_error', message: 'Ошибка связи с туннелем' }, 502);
  }
});

import { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Env, Device } from './types';
import { buildCleanHeaders, storedOperatorToken, tunnelTarget, proxyResponse } from './proxy/shared';
import { getCurrentUser } from './core/session';

export const proxyRouter = new Hono<{ Bindings: Env }>();

const handleDashboardProxy = async (c: Context<{ Bindings: Env }>) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.redirect('/cabinet');
  }

  const { org_slug, ws_slug, dash_id } = c.req.param();

  // 1. Поиск рабочего пространства и дашборда с проверкой членства в организации
  const query = `
    SELECT d.id as dash_id, d.slug as dash_path, linked_device.id as device_id,
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
    .first<{ dash_id: string; dash_path: string; device_id?: string;
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

  if (dashInfo.member_role === 'viewer' &&
      (!['GET', 'HEAD'].includes(c.req.method) ||
        c.req.header('Upgrade')?.toLowerCase() === 'websocket')) {
    return c.text('Недостаточно прав для управления дашбордом', 403);
  }

  // Запоминаем текущее рабочее пространство и устройство в cookie
  setCookie(c, 'last_ws_id', dashInfo.workspace_id, {
    path: '/',
    maxAge: 86400,
    sameSite: 'Lax',
    secure: true,
  });
  setCookie(c, 'last_dash_id', dashInfo.dash_id, {
    path: '/', maxAge: 86400, sameSite: 'Lax', secure: true, httpOnly: true
  });
  deleteCookie(c, 'op_token_' + dashInfo.workspace_id, { path: '/', secure: true, sameSite: 'Lax' });
  if (dashInfo.device_id) {
    setCookie(c, 'last_dev_id', dashInfo.device_id, {
      path: '/',
      maxAge: 86400,
      sameSite: 'Lax',
      secure: true,
    });
  } else {
    deleteCookie(c, 'last_dev_id', { path: '/', secure: true, sameSite: 'Lax' });
  }

  // 2. Авторизация оператора (извлечение и проброс токена)
  let token = c.req.query('token') || c.req.header('X-Operator-Token');
  if (!token && dashInfo.dash_path) token = storedOperatorToken(dashInfo.dash_path);

  // 3. Вычисление целевого подпути (/operator, /operator/view, /operator/events и т.д.)
  const basePath = `/view/${org_slug}/${ws_slug}/${dash_id}`;
  let subPath = c.req.path.slice(basePath.length);
  if (!subPath || subPath === '/') {
    subPath = dashInfo.dash_path || '/operator';
  }
  if (!subPath.startsWith('/') || subPath.startsWith('//')) {
    return c.text('Некорректный путь дашборда', 502);
  }
  const dashboardTarget = new URL(subPath, 'https://tunnel.internal');
  if (dashboardTarget.origin !== 'https://tunnel.internal') {
    return c.text('Некорректный путь дашборда', 502);
  }
  subPath = dashboardTarget.pathname + dashboardTarget.search;

  const queryIdx = c.req.url.indexOf('?');
  if (queryIdx !== -1) {
    const search = c.req.url.slice(queryIdx);
    if (!subPath.includes('?')) {
      subPath += search;
    }
  }

  // 4. Прямой защищенный канал к хосту через Durable Object (без сторонних туннелей)
  const tunnelTargets = [dashInfo.device_id, dashInfo.workspace_id].filter(Boolean) as string[];
  if (c.env.TUNNEL_DO && tunnelTargets.length > 0) {
    for (const targetId of tunnelTargets) {
      try {
        const doId = c.env.TUNNEL_DO.idFromName(targetId);
        const stub = c.env.TUNNEL_DO.get(doId);
        const doRequestUrl = new URL(subPath, 'https://tunnel.internal');
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
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
        }));
        if (doResponse.status !== 503) {
          return proxyResponse(c, doResponse);
        }
      } catch (_) {}
    }
  }

  // 5. Fallback: поиск устройства с классическим URL туннеля (если задан)
  const device = await c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND is_online = 1 AND tunnel_url IS NOT NULL AND tunnel_url != 'direct_ws'
    ORDER BY CASE WHEN role = 'primary' THEN 1 ELSE 2 END ASC, priority DESC
    LIMIT 1
  `).bind(dashInfo.workspace_id).first<Device>();

  if (!device || !device.tunnel_url) {
    return c.html(`
      <!DOCTYPE html>
      <html lang="ru">
      <head>
        <meta charset="utf-8">
        <title>Оборудование не на связи</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #12151a; color: #e1e4ea; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1a1e26; border: 1px solid #2e3544; border-radius: 12px; padding: 32px; max-width: 480px; text-align: center; }
          h2 { color: #f59e0b; margin-top: 0; }
          p { color: #94a3b8; line-height: 1.5; margin-bottom: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚠️ Оборудование не на связи</h2>
          <p>Узел программы MQTT Control RS сейчас не в сети или связь с хабом не включена.</p>
          <p style="font-size: 13px; color: #64748b;">Убедитесь, что в программе включен сервер оператора и связь с хабом.</p>
        </div>
      </body>
      </html>
    `, 503);
  }

  const targetUrl = tunnelTarget(device.tunnel_url, subPath);
  if (!targetUrl) return c.text('Некорректный адрес туннеля', 502);
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
      return proxyResponse(c, await fetch(targetUrl.toString(), {
        headers: forwardHeaders,
        // @ts-ignore
        cf: { websocketHandling: 'raw' }
      }));
    }

    return proxyResponse(c, await fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: 'manual'
    })));
  } catch (err) {
    console.error('Dashboard tunnel request failed', err);
    return c.text('Ошибка связи с туннелем', 502);
  }
};

// Поддерживаем как URL без слэша, так и подресурсы дашборда
proxyRouter.all('/view/:org_slug/:ws_slug/:dash_id', handleDashboardProxy);
proxyRouter.all('/view/:org_slug/:ws_slug/:dash_id/*', handleDashboardProxy);

// Прямая поддержка подзапросов операторского интерфейса (/operator/view, /operator/events, /operator/command)
proxyRouter.all('/operator/*', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: 'unauthorized', message: 'Требуется авторизация в аккаунте' }, 401);
  }

  let wsId: string | null = null;
  let devId: string | null = null;
  let memberRole: string | null = null;
  let dashboardPath: string | null = null;
  const referer = c.req.header('Referer');
  if (referer) {
    const match = referer.match(/\/view\/([^\/]+)\/([^\/]+)\/([^\/?#]+)/);
    if (match) {
      const [_, org_slug, ws_slug, dash_id] = match;
      const query = `
        SELECT linked_device.id as device_id, w.id as workspace_id, d.slug as dash_path,
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
        .first<{ device_id?: string; workspace_id: string; dash_path: string;
          member_role: string }>();
      if (found) {
        wsId = found.workspace_id;
        devId = found.device_id || null;
        memberRole = found.member_role;
        dashboardPath = found.dash_path;
      }
    }
  }

  if (!wsId) {
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

  if (memberRole === 'viewer' &&
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

  // 1. Прямой защищенный канал через Durable Object
  const operatorTargets = [devId, wsId].filter(Boolean) as string[];
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
          body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
        }));
        if (doResponse.status !== 503) {
          return proxyResponse(c, doResponse);
        }
      } catch (_) {}
    }
  }

  // 2. Fallback: поиск устройства со статическим туннелем
  const device = await c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND is_online = 1 AND tunnel_url IS NOT NULL AND tunnel_url != 'direct_ws'
    ORDER BY CASE WHEN role = 'primary' THEN 1 ELSE 2 END ASC, priority DESC
    LIMIT 1
  `).bind(wsId).first<Device>();

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
      return proxyResponse(c, await fetch(targetUrl.toString(), {
        headers: forwardHeaders,
        // @ts-ignore
        cf: { websocketHandling: 'raw' }
      }));
    }

    return proxyResponse(c, await fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: 'manual',
    })));
  } catch (err) {
    console.error('Operator tunnel request failed', err);
    return c.json({ error: 'tunnel_error', message: 'Ошибка связи с туннелем' }, 502);
  }
});

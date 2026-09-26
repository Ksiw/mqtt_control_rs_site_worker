import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { Env, Device } from './types';

export const proxyRouter = new Hono<{ Bindings: Env }>();

/**
 * Очищает заголовки перед отправкой в туннель Cloudflare.
 * Удаление cf-*, cdn-loop предотвращает ошибку Error 1033 (петля Cloudflare Edge).
 */
function buildCleanHeaders(incoming: Headers, targetHost: string): Headers {
  const clean = new Headers();
  incoming.forEach((val, key) => {
    const k = key.toLowerCase();
    if (
      !k.startsWith('cf-') &&
      k !== 'cdn-loop' &&
      k !== 'host' &&
      k !== 'x-forwarded-for' &&
      k !== 'x-forwarded-proto' &&
      k !== 'x-forwarded-host'
    ) {
      clean.set(key, val);
    }
  });
  clean.set('Host', targetHost);
  return clean;
}


const handleDashboardProxy = async (c: any) => {
  const { org_slug, ws_slug, dash_id } = c.req.param();

  // 1. Поиск рабочего пространства и дашборда
  const query = `
    SELECT d.id as dash_id, d.slug as dash_path, d.device_id, w.id as workspace_id
    FROM dashboards d
    JOIN workspaces w ON d.workspace_id = w.id
    JOIN organizations o ON w.org_id = o.id
    WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
    LIMIT 1
  `;
  const dashInfo = (await (c.env.DB.prepare(query) as any)
    .bind(org_slug, ws_slug, dash_id, `%${dash_id}%`)
    .first()) as { dash_id: string; dash_path: string; device_id?: string; workspace_id: string } | null;

  if (!dashInfo) {
    return c.text('Дашборд или рабочее пространство не найдено', 404);
  }

  // Запоминаем текущее рабочее пространство и устройство в cookie
  setCookie(c, 'last_ws_id', dashInfo.workspace_id, {
    path: '/',
    maxAge: 86400,
    sameSite: 'Lax',
    secure: true,
  });
  if (dashInfo.device_id) {
    setCookie(c, 'last_dev_id', dashInfo.device_id, {
      path: '/',
      maxAge: 86400,
      sameSite: 'Lax',
      secure: true,
    });
  }

  // 2. Авторизация оператора (извлечение и проброс токена)
  let token = c.req.query('token') || c.req.header('X-Operator-Token');
  if (!token && dashInfo.dash_path && dashInfo.dash_path.includes('token=')) {
    const match = dashInfo.dash_path.match(/[?&]token=([^&]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }
  if (!token) {
    token = getCookie(c, 'op_token_' + dashInfo.workspace_id) || undefined;
  }
  if (token) {
    setCookie(c, 'op_token_' + dashInfo.workspace_id, token, {
      path: '/',
      maxAge: 86400,
      sameSite: 'Lax',
      secure: true,
    });
  }

  // 3. Вычисление целевого подпути (/operator, /operator/view, /operator/events и т.д.)
  const basePath = `/view/${org_slug}/${ws_slug}/${dash_id}`;
  let subPath = c.req.path.slice(basePath.length);
  if (!subPath || subPath === '/') {
    subPath = dashInfo.dash_path || '/operator';
  }

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
          return doResponse;
        }
      } catch (_) {}
    }
  }

  // 5. Fallback: поиск устройства с классическим URL туннеля (если задан)
  const device = (await (c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND is_online = 1 AND tunnel_url IS NOT NULL AND tunnel_url != 'direct_ws'
    ORDER BY CASE WHEN role = 'primary' THEN 1 ELSE 2 END ASC, priority DESC
    LIMIT 1
  `) as any).bind(dashInfo.workspace_id).first()) as Device | null;

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

  const tunnelBase = device.tunnel_url.replace(/\/$/, '');
  const targetUrl = new URL(subPath, tunnelBase);
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
      return await fetch(targetUrl.toString(), {
        headers: forwardHeaders,
        // @ts-ignore
        cf: { websocketHandling: 'raw' }
      });
    }

    return await fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: 'manual'
    }));
  } catch (err: any) {
    return c.text('Tunnel network error: ' + (err?.message || err), 502);
  }
};

// Поддерживаем как URL без слэша, так и подресурсы дашборда
proxyRouter.all('/view/:org_slug/:ws_slug/:dash_id', handleDashboardProxy);
proxyRouter.all('/view/:org_slug/:ws_slug/:dash_id/*', handleDashboardProxy);

// Прямая поддержка подзапросов операторского интерфейса (/operator/view, /operator/events, /operator/command)
proxyRouter.all('/operator/*', async (c) => {
  let wsId: string | null = null;
  let devId: string | null = null;
  const referer = c.req.header('Referer');
  if (referer) {
    const match = referer.match(/\/view\/([^\/]+)\/([^\/]+)\/([^\/?#]+)/);
    if (match) {
      const [_, org_slug, ws_slug, dash_id] = match;
      const query = `
        SELECT d.device_id, w.id as workspace_id
        FROM dashboards d
        JOIN workspaces w ON d.workspace_id = w.id
        JOIN organizations o ON w.org_id = o.id
        WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
        LIMIT 1
      `;
      const found = (await (c.env.DB.prepare(query) as any)
        .bind(org_slug, ws_slug, dash_id, `%${dash_id}%`)
        .first()) as { device_id?: string; workspace_id: string } | null;
      if (found) {
        wsId = found.workspace_id;
        devId = found.device_id || null;
      }
    }
  }

  if (!devId) {
    devId = getCookie(c, 'last_dev_id') || null;
  }
  if (!wsId) {
    wsId = getCookie(c, 'last_ws_id') || null;
  }

  if (!wsId) {
    return c.json({ error: 'No active workspace found for operator request', message: 'Рабочее пространство не определено' }, 404);
  }

  let targetPath = c.req.path;
  const queryIdx = c.req.url.indexOf('?');
  if (queryIdx !== -1) {
    targetPath += c.req.url.slice(queryIdx);
  }

  // Проброс токена оператора
  let token = c.req.query('token') || c.req.header('X-Operator-Token');
  if (!token && wsId) {
    token = getCookie(c, 'op_token_' + wsId) || undefined;
  }

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
          return doResponse;
        }
      } catch (_) {}
    }
  }

  // 2. Fallback: поиск устройства со статическим туннелем
  const device = (await (c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND is_online = 1 AND tunnel_url IS NOT NULL AND tunnel_url != 'direct_ws'
    ORDER BY CASE WHEN role = 'primary' THEN 1 ELSE 2 END ASC, priority DESC
    LIMIT 1
  `) as any).bind(wsId).first()) as Device | null;

  if (!device || !device.tunnel_url) {
    return c.json({ error: 'Host device is offline', message: 'Хост-программа не подключена к хабу' }, 503);
  }

  const tunnelBase = device.tunnel_url.replace(/\/$/, '');
  const targetUrl = new URL(targetPath, tunnelBase);
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
      return await fetch(targetUrl.toString(), {
        headers: forwardHeaders,
        // @ts-ignore
        cf: { websocketHandling: 'raw' }
      });
    }

    return await fetch(new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: 'manual',
    }));
  } catch (err: any) {
    return c.json({ error: 'tunnel_error', message: 'Ошибка связи с туннелем: ' + (err?.message || err) }, 502);
  }
});

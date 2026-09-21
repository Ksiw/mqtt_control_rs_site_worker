import { Hono } from 'hono';
import { Env, Device } from './types';

export const proxyRouter = new Hono<{ Bindings: Env }>();

/**
 * Шлюз доступа к дашборду:
 * GET /view/:org_slug/:ws_slug/:dash_id
 */
proxyRouter.all('/view/:org_slug/:ws_slug/:dash_id/*', async (c) => {
  const { org_slug, ws_slug, dash_id } = c.req.param();

  // 1. Поиск рабочего пространства и дашборда по человекочитаемым адресам (slug)
  const query = `
    SELECT d.id as dash_id, d.slug as dash_path, w.id as workspace_id
    FROM dashboards d
    JOIN workspaces w ON d.workspace_id = w.id
    JOIN organizations o ON w.org_id = o.id
    WHERE o.slug = ? AND w.slug = ? AND (d.id = ? OR d.slug LIKE ?)
    LIMIT 1
  `;
  const dashInfo = await c.env.DB.prepare(query)
    .bind(org_slug, ws_slug, dash_id, `%${dash_id}%`)
    .first<{ dash_id: string; dash_path: string; workspace_id: string }>();

  if (!dashInfo) {
    return c.text('Дашборд или рабочее пространство не найдено', 404);
  }

  // 2. Отказоустойчивый выбор активного онлайн-узла (Failover)
  // Сначала выбираем узел primary, затем standby с максимальным приоритетом
  const device = await c.env.DB.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND is_online = 1 AND tunnel_url IS NOT NULL
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
          p { color: #94a3b8; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>⚠️ Оборудование не на связи</h2>
          <p>Экземпляр программы mqtt_control_rs для этого пространства сейчас оффлайн или туннель Cloudflare не запущен.</p>
        </div>
      </body>
      </html>
    `, 503);
  }

  // 3. Формирование целевого URL к туннелю устройства
  const tunnelBase = device.tunnel_url.replace(/\/$/, '');
  const subPath = c.req.path.replace(`/view/${org_slug}/${ws_slug}/${dash_id}`, '') || dashInfo.dash_path;
  const targetUrl = new URL(subPath, tunnelBase);
  c.req.raw.headers.forEach((v, k) => {
    // Копируем query параметры
  });

  // 4. Проверка на запрос обновления WebSocket
  const upgradeHeader = c.req.header('Upgrade');
  if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
    // Прозрачное проксирование WebSocket
    return fetch(targetUrl.toString(), {
      headers: c.req.raw.headers,
      // @ts-ignore
      cf: { websocketHandling: 'raw' }
    });
  }

  // 5. Прозрачное проксирование стандартных HTTP-запросов (HTML, CSS, JS, API)
  const proxyRequest = new Request(targetUrl.toString(), {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
    redirect: 'manual'
  });

  return fetch(proxyRequest);
});

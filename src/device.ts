import { Hono, Context } from 'hono';
import { Env, HeartbeatPayload, Device } from './types';
import { sha256Hex, verifyHmacSha256 } from './crypto';

export const deviceRouter = new Hono<{ Bindings: Env }>();

function prefixMatches(supplied: string, stored: string): boolean {
  return supplied.startsWith(stored) || stored.startsWith(supplied);
}

function safeLocalPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  try {
    return new URL(path, 'https://tunnel.internal').origin === 'https://tunnel.internal';
  } catch {
    return false;
  }
}

function validDashboard(value: unknown): value is { id: string; name?: string; path?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dash = value as Record<string, unknown>;
  return typeof dash.id === 'string' && dash.id.length > 0 && dash.id.length <= 100 &&
    (dash.name === undefined || (typeof dash.name === 'string' && dash.name.length <= 200)) &&
    (dash.path === undefined || (typeof dash.path === 'string' &&
      dash.path.length <= 2048 && (!dash.path || safeLocalPath(dash.path))));
}

function validTunnelUrl(value: string): boolean {
  if (!value || value === 'direct_ws') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

async function authenticateSignedDevice(
  c: Context<{ Bindings: Env }>, body: string, missingStatus: 401 | 404 = 401
): Promise<{ device: Device; error?: never } | { device?: never; error: Response }> {
  const prefix = c.req.header('X-Device-Prefix');
  const deviceKey = c.req.header('X-Device-Key');
  const timestampStr = c.req.header('X-Timestamp');
  const signature = c.req.header('X-Signature');
  if (!prefix || !deviceKey || !timestampStr || !signature) {
    return { error: c.json({ status: 'error', message: 'Отсутствуют обязательные заголовки безопасности' }, 401) };
  }

  const timestamp = Number(timestampStr);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 120) {
    return { error: c.json({ status: 'error', message: 'Метка времени запроса устарела' }, 401) };
  }

  const keyHash = await sha256Hex(deviceKey);
  const device = await c.env.DB.prepare(
    'SELECT * FROM devices WHERE key_hash = ? LIMIT 1'
  ).bind(keyHash).first<Device>();
  if (!device || !prefixMatches(prefix, device.key_prefix)) {
    return { error: c.json({ status: 'error', message: 'Устройство не найдено или доступ отозван' }, missingStatus) };
  }

  if (!/^[a-f0-9]{64}$/i.test(signature) ||
      !await verifyHmacSha256(deviceKey, timestampStr + body, signature)) {
    return { error: c.json({ status: 'error', message: 'Недействительная подпись запроса' }, 401) };
  }
  return { device };
}

/**
 * Регулярное подтверждение связи от приложения mqtt_control_rs (Heartbeat)
 * POST /api/v1/device/heartbeat
 */
deviceRouter.post('/heartbeat', async (c) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const bodyText = await c.req.text();
    const auth = await authenticateSignedDevice(c, bodyText);
    if (auth.error) return auth.error;
    const device = auth.device;
    let payload: HeartbeatPayload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      return c.json({ status: 'error', message: 'Некорректный формат JSON' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        (payload.tunnel_url !== undefined && payload.tunnel_url !== null &&
          (typeof payload.tunnel_url !== 'string' || payload.tunnel_url.length > 2048 ||
            !validTunnelUrl(payload.tunnel_url))) ||
        (payload.app_version !== undefined &&
          (typeof payload.app_version !== 'string' || payload.app_version.length > 100)) ||
        (payload.os !== undefined &&
          (typeof payload.os !== 'string' || payload.os.length > 200)) ||
        (payload.device_role !== undefined &&
          payload.device_role !== 'primary' && payload.device_role !== 'standby') ||
        (payload.dashboards !== undefined && !Array.isArray(payload.dashboards))) {
      return c.json({ status: 'error', message: 'Некорректные данные устройства' }, 400);
    }

    // 2. Обновляем статус устройства в базе данных D1
    const batchQueries: any[] = [
      c.env.DB.prepare(`
        UPDATE devices 
        SET is_online = 1,
            tunnel_url = ?,
            last_heartbeat_at = ?,
            app_version = ?,
            os_info = ?,
            role = COALESCE(?, role)
        WHERE id = ?
      `).bind(
        payload.tunnel_url || null,
        now,
        payload.app_version || null,
        payload.os || null,
        payload.device_role || null,
        device.id
      )
    ];

    // 3. Автоматическая синхронизация дашбордов конкретного устройства
    if (Array.isArray(payload.dashboards)) {
      if (payload.dashboards.length > 500) {
        return c.json({ status: 'error', message: 'Слишком много дашбордов' }, 400);
      }
      if (!payload.dashboards.every(validDashboard)) {
        return c.json({ status: 'error', message: 'Некорректные данные дашбордов' }, 400);
      }
      const validDashboards = payload.dashboards;
      const activeIds = validDashboards.map(d => `${device.id}_${d.id}`);
      if (activeIds.length > 0) {
        const placeholders = activeIds.map(() => '?').join(',');
        batchQueries.push(
          c.env.DB.prepare(`
            DELETE FROM dashboards 
            WHERE device_id = ? AND id NOT IN (${placeholders})
          `).bind(device.id, ...activeIds)
        );
        for (const d of validDashboards) {
          const dashId = `${device.id}_${d.id}`;
          batchQueries.push(
            c.env.DB.prepare(`
              INSERT INTO dashboards (id, workspace_id, device_id, name, slug, is_public, created_at)
              VALUES (?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug, device_id = excluded.device_id
            `).bind(dashId, device.workspace_id, device.id, d.name || 'Дашборд', d.path || '/operator', now)
          );
        }
      } else {
        batchQueries.push(
          c.env.DB.prepare('DELETE FROM dashboards WHERE device_id = ?').bind(device.id)
        );
      }
    }

    await c.env.DB.batch(batchQueries);

    return c.json({
      status: 'ok',
      device_id: device.id,
      server_timestamp: now,
      pending_commands: []
    });
  } catch (err: any) {
    console.error('Ошибка в /api/v1/device/heartbeat:', err);
    return c.json({
      status: 'error',
      message: 'Внутренняя ошибка сервера'
    }, 500);
  }
});

/**
 * Запрос на отвязку устройства со стороны клиента
 * POST /api/v1/device/unlink
 */
deviceRouter.post('/unlink', async (c) => {
  try {
    const bodyText = await c.req.text();
    const auth = await authenticateSignedDevice(c, bodyText, 404);
    if (auth.error) return auth.error;
    const device = auth.device;

    // 2. Удаление связанных дашбордов и самого устройства из БД D1 (освобождает machine_id)
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM dashboards WHERE device_id = ?').bind(device.id),
      c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id)
    ]);

    return c.json({ status: 'ok', message: 'Устройство успешно отвязано' });
  } catch (err: any) {
    console.error('Ошибка в /api/v1/device/unlink:', err);
    return c.json({
      status: 'error',
      message: 'Внутренняя ошибка сервера'
    }, 500);
  }
});

/**
 * Постоянное защищенное WebSocket-соединение от десктопного приложения к хабу
 * GET /api/v1/device/tunnel-ws
 */
deviceRouter.get('/tunnel-ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  const prefix = c.req.header('X-Device-Prefix');
  const deviceKey = c.req.header('X-Device-Key');
  if (!prefix || !deviceKey) {
    return c.text('Не указаны обязательные параметры аутентификации (prefix и key)', 401);
  }

  const device = await c.env.DB.prepare(
    'SELECT * FROM devices WHERE key_hash = ? LIMIT 1'
  ).bind(await sha256Hex(deviceKey)).first<Device>();

  if (!device || !prefixMatches(prefix, device.key_prefix)) {
    return c.text('Устройство не найдено или доступ отозван', 404);
  }

  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    'UPDATE devices SET is_online = 1, last_heartbeat_at = ?, tunnel_url = ? WHERE id = ?'
  ).bind(now, 'direct_ws', device.id).run();

  const doId = c.env.TUNNEL_DO.idFromName(device.id);
  const stub = c.env.TUNNEL_DO.get(doId);
  const doUrl = new URL('/tunnel/device-ws', 'https://tunnel.internal');
  return stub.fetch(new Request(doUrl.toString(), c.req.raw));
});

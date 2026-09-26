import { Hono } from 'hono';
import { Env, HeartbeatPayload, Device } from './types';
import { sha256Hex } from './crypto';

export const deviceRouter = new Hono<{ Bindings: Env }>();

/**
 * Регулярное подтверждение связи от приложения mqtt_control_rs (Heartbeat)
 * POST /api/v1/device/heartbeat
 */
deviceRouter.post('/heartbeat', async (c) => {
  try {
    const prefix = c.req.header('X-Device-Prefix');
    const timestampStr = c.req.header('X-Timestamp');
    const signature = c.req.header('X-Signature');

    if (!prefix || !timestampStr || !signature) {
      return c.json({ status: 'error', message: 'Отсутствуют обязательные заголовки безопасности' }, 401);
    }

    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);

    // Защита от replay-атак: допускаем расхождение до 120 секунд на рассинхрон часов
    if (Math.abs(now - timestamp) > 120) {
      return c.json({ status: 'error', message: 'Метка времени запроса устарела' }, 401);
    }

    const bodyText = await c.req.text();
    let payload: HeartbeatPayload;
    try {
      payload = JSON.parse(bodyText);
    } catch (e) {
      return c.json({ status: 'error', message: 'Некорректный формат JSON' }, 400);
    }

    // 1. Быстрый поиск устройства по префиксу ключа
    const device = await c.env.DB.prepare(
      'SELECT * FROM devices WHERE key_prefix = ? OR key_prefix LIKE (? || \'%\') OR ? LIKE (key_prefix || \'%\') LIMIT 1'
    ).bind(prefix, prefix, prefix).first<Device>();

    if (!device) {
      return c.json({ status: 'error', message: 'Устройство не найдено или доступ отозван' }, 404);
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
      const activeIds = payload.dashboards.filter(d => d && d.id).map(d => `'${device.id}_${d.id}'`);
      if (activeIds.length > 0) {
        batchQueries.push(
          c.env.DB.prepare(`
            DELETE FROM dashboards 
            WHERE device_id = ? AND id NOT IN (${activeIds.join(',')})
          `).bind(device.id)
        );
        for (const d of payload.dashboards) {
          if (!d || !d.id) continue;
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
      message: `Внутренняя ошибка сервера: ${err?.message || err}`
    }, 500);
  }
});

/**
 * Запрос на отвязку устройства со стороны клиента
 * POST /api/v1/device/unlink
 */
deviceRouter.post('/unlink', async (c) => {
  try {
    const prefix = c.req.header('X-Device-Prefix');
    const timestampStr = c.req.header('X-Timestamp');
    const signature = c.req.header('X-Signature');

    if (!prefix || !timestampStr || !signature) {
      return c.json({ status: 'error', message: 'Отсутствуют обязательные заголовки безопасности' }, 401);
    }

    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);

    // Защита от replay-атак (допускаем расхождение до 120 секунд)
    if (Math.abs(now - timestamp) > 120) {
      return c.json({ status: 'error', message: 'Метка времени запроса устарела' }, 401);
    }

    // 1. Поиск устройства по префиксу ключа
    const device = await c.env.DB.prepare(
      'SELECT * FROM devices WHERE key_prefix = ? OR key_prefix LIKE (? || \'%\') OR ? LIKE (key_prefix || \'%\') LIMIT 1'
    ).bind(prefix, prefix, prefix).first<Device>();

    if (!device) {
      // Уже удалено или не существует — считаем успехом отвязки
      return c.json({ status: 'ok', message: 'Устройство уже отвязано или отсутствует' }, 200);
    }

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
      message: `Внутренняя ошибка сервера: ${err?.message || err}`
    }, 500);
  }
});

/**
 * Постоянное защищенное WebSocket-соединение от десктопного приложения к хабу
 * GET /api/v1/device/tunnel-ws
 */
deviceRouter.get('/tunnel-ws', async (c) => {
  const prefix = c.req.header('X-Device-Prefix') || c.req.query('prefix');
  if (!prefix) {
    return c.text('X-Device-Prefix required', 400);
  }

  const device = await c.env.DB.prepare(
    'SELECT * FROM devices WHERE key_prefix = ? OR key_prefix LIKE (? || \'%\') OR ? LIKE (key_prefix || \'%\') LIMIT 1'
  ).bind(prefix, prefix, prefix).first<Device>();

  if (!device) {
    return c.text('Device not found', 404);
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


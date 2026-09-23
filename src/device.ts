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
      'SELECT * FROM devices WHERE key_prefix = ? LIMIT 1'
    ).bind(prefix).first<Device>();

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

    // 3. Автоматическая синхронизация дашбордов устройства (с реальным workspace_id устройства)
    if (Array.isArray(payload.dashboards) && payload.dashboards.length > 0) {
      for (const d of payload.dashboards) {
        if (!d || !d.id) continue;
        const dashId = `${device.workspace_id}_${d.id}`;
        batchQueries.push(
          c.env.DB.prepare(`
            INSERT INTO dashboards (id, workspace_id, name, slug, is_public, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug
          `).bind(dashId, device.workspace_id, d.name || 'Дашборд', d.path || '/operator', now)
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

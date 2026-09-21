import { Hono } from 'hono';
import { Env, HeartbeatPayload, Device } from './types';
import { sha256Hex } from './crypto';

export const deviceRouter = new Hono<{ Bindings: Env }>();

/**
 * Регулярное подтверждение связи от приложения mqtt_control_rs (Heartbeat)
 * POST /api/v1/device/heartbeat
 */
deviceRouter.post('/heartbeat', async (c) => {
  const prefix = c.req.header('X-Device-Prefix');
  const timestampStr = c.req.header('X-Timestamp');
  const signature = c.req.header('X-Signature');

  if (!prefix || !timestampStr || !signature) {
    return c.json({ status: 'error', message: 'Отсутствуют обязательные заголовки безопасности' }, 401);
  }

  const timestamp = parseInt(timestampStr, 10);
  const now = Math.floor(Date.now() / 1000);

  // Защита от replay-атак: отклоняем запросы с расхождением более 60 секунд
  if (Math.abs(now - timestamp) > 60) {
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

  // 2. Обновляем статус устройства и время последнего ответа в базе данных D1
  await c.env.DB.batch([
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
      payload.tunnel_url,
      now,
      payload.app_version,
      payload.os,
      payload.device_role || null,
      device.id
    ),
    // Автоматическая регистрация/обновление дашбордов из списка
    ...payload.dashboards.map(d =>
      c.env.DB.prepare(`
        INSERT INTO dashboards (id, workspace_id, name, slug, is_public, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug
      `).bind(d.id, payload.workspace_id, d.name, d.path, now)
    )
  ]);

  return c.json({
    status: 'ok',
    device_id: device.id,
    server_timestamp: now,
    pending_commands: []
  });
});

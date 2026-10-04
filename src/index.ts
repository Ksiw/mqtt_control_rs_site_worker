import { Hono } from 'hono';
import { Env } from './types';
import { deviceRouter } from './device';
import { proxyRouter } from './proxy';
import { authRouter } from './auth';
import { cabinetRouter } from './cabinet';
import { familyRouter } from './family';
import { pairRouter } from './pairing';
import { billingRouter } from './billing';
import { adminRouter } from './admin';
import { licenseApiRouter } from './license_api';
import { wikiRouter } from './wiki';

const app = new Hono<{ Bindings: Env }>();

// Подключение подмодулей маршрутизации
app.route('/auth', authRouter);
app.route('/api/v1/device', deviceRouter);
app.route('/api/v1/family', familyRouter);
app.route('/api/v1/pair', pairRouter);
app.route('/api/v1/billing', billingRouter);
app.route('/api/v1/admin', adminRouter);
app.route('/api/v1', licenseApiRouter);
app.route('/api/v1/wiki', wikiRouter);
app.route('/', cabinetRouter);
app.route('/', proxyRouter);

export const APP_VERSION = '1.2.0';

// Проверка статуса сервиса
app.get('/api/v1/health', (c) => {
  return c.json({ status: 'ok', version: APP_VERSION, time: Math.floor(Date.now() / 1000) });
});

export { DeviceTunnel } from './device_tunnel';

// Экспорт обработчиков для Cloudflare Workers
export default {
  fetch: app.fetch,

  // Фоновый планировщик Cron Trigger (каждую 1 минуту)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const now = Math.floor(Date.now() / 1000);

    // 1. Поминутно: переводим в оффлайн устройства, от которых не было связи более 60 секунд
    await env.DB.prepare(`
      UPDATE devices 
      SET is_online = 0 
      WHERE is_online = 1 AND (? - last_heartbeat_at) > 60
    `).bind(now).run();

    // 2. Регламентная очистка устаревших сессий (старше 30 дней)
    await env.DB.prepare(`
      DELETE FROM user_sessions WHERE expires_at < ?
    `).bind(now).run();

    // 3. Очистка старых записей журнала аудита (хранение скользящим окном 90 дней)
    const ninetyDaysAgo = now - (90 * 86400);
    await env.DB.prepare(`
      DELETE FROM audit_logs WHERE created_at < ?
    `).bind(ninetyDaysAgo).run();

    // 4. Удаление «фантомных» узлов (созданы более 30 дней назад, но ни разу не прислали heartbeat)
    const thirtyDaysAgo = now - (30 * 86400);
    await env.DB.prepare(`
      DELETE FROM devices 
      WHERE last_heartbeat_at IS NULL AND created_at < ?
    `).bind(thirtyDaysAgo).run();

    // Удаляем завершённые и истёкшие запросы привязки вместе с выданными ключами.
    await env.DB.prepare('DELETE FROM device_pairings WHERE expires_at < ?')
      .bind(now - 86400).run();
  }
};

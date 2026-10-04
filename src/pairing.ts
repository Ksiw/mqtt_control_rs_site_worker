import { Hono } from 'hono';
import { Env, getTierDeviceLimit, getEffectivePlanTier } from './types';
import { getCurrentUser } from './core/session';
import { pairingApprovalRouter } from './pairing/approval';

export const pairRouter = new Hono<{ Bindings: Env }>();

/**
 * Инициализация связки от хост-программы
 * POST /api/v1/pair/request
 */
pairRouter.post('/request', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { device_name, os_info, app_version, machine_id } = body as {
    device_name?: string;
    os_info?: string;
    app_version?: string;
    machine_id?: string;
  };
  if ([device_name, os_info, app_version, machine_id].some(value =>
    value !== undefined && value !== null && typeof value !== 'string') ||
    (device_name?.length || 0) > 200 || (os_info?.length || 0) > 200 ||
    (app_version?.length || 0) > 100 || (machine_id?.length || 0) > 200) {
    return c.json({ status: 'error', message: 'Некорректные параметры устройства' }, 400);
  }

  const name = device_name?.trim() || 'Хост-программа';
  const cleanMachineId = machine_id?.trim() || null;

  // Защита: проверяем, не привязан ли этот machine_id к другому владельцу
  if (cleanMachineId) {
    const existingBinding = await c.env.DB.prepare(`
      SELECT d.id, u.email, o.name as org_name
      FROM devices d
      JOIN workspaces w ON d.workspace_id = w.id
      JOIN organizations o ON w.org_id = o.id
      JOIN users u ON o.owner_user_id = u.id
      WHERE d.machine_id = ?
      LIMIT 1
    `).bind(cleanMachineId).first<{ id: string; email: string; org_name: string }>();

    if (existingBinding) {
      const parts = existingBinding.email.split('@');
      const namePart = parts[0] || 'user';
      const domainPart = parts[1] || 'mail.com';
      const maskedEmail = namePart.length > 2
        ? `${namePart[0]}***${namePart[namePart.length - 1]}@${domainPart}`
        : `***@${domainPart}`;

      return c.json({
        status: 'error',
        message: `Этот хост уже привязан к аккаунту ${maskedEmail}. Чтобы перенести его, сначала удалите хост в прежнем аккаунте.`
      }, 409);
    }
  }

  // Код короткий для ручного ввода; при совпадении выбираем новый.
  const secretToken = `pair_sec_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300; // 5 минут на подтверждение
  let code = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const digits = String(100000 + random[0] % 900000);
    const candidate = `${digits.slice(0, 3)}-${digits.slice(3)}`;
    try {
      await c.env.DB.prepare(`
        INSERT INTO device_pairings (code, secret_token, device_name, os_info, app_version,
                                     machine_id, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind(candidate, secretToken, name, os_info || null, app_version || null,
        cleanMachineId, expiresAt, now).run();
      code = candidate;
      break;
    } catch (error) {
      const collision = await c.env.DB.prepare('SELECT 1 FROM device_pairings WHERE code = ?')
        .bind(candidate).first();
      if (!collision) throw error;
    }
  }
  if (!code) return c.json({ status: 'error', message: 'Не удалось создать код привязки' }, 503);

  const domain = c.env.HUB_DOMAIN || new URL(c.req.url).origin;
  const pairUrl = `${domain}/cabinet?pair=${code}`;

  return c.json({
    status: 'ok',
    code: code,
    secret_token: secretToken,
    pair_url: pairUrl,
    expires_in_seconds: 300
  });
});

/**
 * Опрос статуса связки программой
 * POST /api/v1/pair/poll
 */
pairRouter.post('/poll', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { code, secret_token } = body as {
    code?: string;
    secret_token?: string;
  };

  if (typeof code !== 'string' || !code || code.length > 50 ||
      typeof secret_token !== 'string' || !secret_token || secret_token.length > 200) {
    return c.json({ status: 'error', message: 'Не указан код или токен' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  const pairing = await c.env.DB.prepare(
    'SELECT * FROM device_pairings WHERE code = ? AND secret_token = ?'
  ).bind(code, secret_token).first<{
    code: string;
    status: string;
    expires_at: number;
    device_key: string | null;
    workspace_id: string | null;
  }>();

  if (!pairing || now > pairing.expires_at) {
    return c.json({ status: 'expired', message: 'Срок действия кода подтверждения истёк' });
  }

  if (pairing.status === 'approved' && pairing.device_key) {
    return c.json({
      status: 'approved',
      device_key: pairing.device_key,
      workspace_id: pairing.workspace_id
    });
  }

  if (pairing.status === 'rejected') {
    return c.json({ status: 'rejected', message: 'Запрос на привязку отклонён владельцем' });
  }

  return c.json({ status: 'pending' });
});

/**
 * Получение информации о коде связки для отображения в браузере
 * GET /api/v1/pair/info?code=...
 */
pairRouter.get('/info', async (c) => {
  const code = c.req.query('code');
  if (!code) {
    return c.json({ status: 'error', message: 'Код не указан' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const pairing = await c.env.DB.prepare(
    'SELECT code, device_name, os_info, app_version, status, expires_at FROM device_pairings WHERE code = ?'
  ).bind(code).first<{
    code: string;
    device_name: string;
    os_info: string | null;
    app_version: string | null;
    status: string;
    expires_at: number;
  }>();

  if (!pairing || now > pairing.expires_at) {
    return c.json({ status: 'error', message: 'Код не найден или истёк' }, 404);
  }

  // Данные об аккаунте текущего пользователя (если авторизован в браузере)
  const user = await getCurrentUser(c);
  let existingDevice: { id: string; name: string; is_online: boolean; last_seen: number | null } | null = null;
  let hasLimitReached = false;
  let transfersUsed = 0;
  let canTransfer = true;
  let canTrial = false;

  if (user) {
    const orgMember = await c.env.DB.prepare(`
      SELECT o.id as org_id, s.plan_tier, s.status, s.current_period_end, s.max_devices, s.trial_used
      FROM organization_members m
      JOIN organizations o ON m.org_id = o.id
      LEFT JOIN subscriptions s ON s.org_id = o.id
      WHERE m.user_id = ?
      LIMIT 1
    `).bind(user.id).first<{ org_id: string; plan_tier: string; status: string; current_period_end: number; max_devices: number; trial_used: number }>();

    if (orgMember) {
      const effectiveTier = getEffectivePlanTier(orgMember.plan_tier, orgMember.status, orgMember.current_period_end, now);
      const maxDevs = getTierDeviceLimit(effectiveTier, orgMember.max_devices);
      const devices = await c.env.DB.prepare(`
        SELECT d.id, d.name, d.is_online, d.last_heartbeat_at
        FROM devices d
        JOIN workspaces w ON d.workspace_id = w.id
        WHERE w.org_id = ?
      `).bind(orgMember.org_id).all<{ id: string; name: string; is_online: number; last_heartbeat_at: number | null }>();

      const count = devices.results?.length ?? 0;
      if (count >= maxDevs) {
        hasLimitReached = true;
        const firstDev = devices.results?.[0];
        if (firstDev) {
          existingDevice = {
            id: firstDev.id,
            name: firstDev.name,
            is_online: firstDev.is_online === 1,
            last_seen: firstDev.last_heartbeat_at
          };
        }

        // Подсчет переносов за последние 30 дней (30 * 86400 сек)
        const windowStart = now - (30 * 86400);
        const trRow = await c.env.DB.prepare(`
          SELECT COUNT(*) as count FROM host_transfers
          WHERE org_id = ? AND transferred_at > ?
        `).bind(orgMember.org_id, windowStart).first<{ count: number }>();

        transfersUsed = trRow?.count ?? 0;
        canTransfer = transfersUsed < 4;
        canTrial = (effectiveTier === 'free' && (!orgMember.trial_used || orgMember.trial_used === 0));
      }
    }
  }

  return c.json({
    status: 'ok',
    device_name: pairing.device_name,
    os_info: pairing.os_info,
    app_version: pairing.app_version,
    pairing_status: pairing.status,
    has_limit_reached: hasLimitReached,
    existing_device: existingDevice,
    transfers_used: transfersUsed,
    can_transfer: canTransfer,
    can_trial: canTrial
  });
});

pairRouter.route('/', pairingApprovalRouter);

import { Hono } from 'hono';
import { Env, getTierDeviceLimit, getEffectivePlanTier } from './types';
import { getCurrentUser, generateDeviceKey, sha256Hex } from './cabinet';

export const pairRouter = new Hono<{ Bindings: Env }>();

/**
 * Инициализация связки от хост-программы
 * POST /api/v1/pair/request
 */
pairRouter.post('/request', async (c) => {
  const { device_name, os_info, app_version, machine_id } = await c.req.json() as {
    device_name?: string;
    os_info?: string;
    app_version?: string;
    machine_id?: string;
  };

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

  // Генерируем читаемый 6-значный код: например 842-195
  const rawNum = Math.floor(100000 + Math.random() * 900000).toString();
  const code = `${rawNum.substring(0, 3)}-${rawNum.substring(3)}`;
  const secretToken = `pair_sec_${crypto.randomUUID().replace(/-/g, '')}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 300; // 5 минут на подтверждение

  await c.env.DB.prepare(`
    INSERT INTO device_pairings (code, secret_token, device_name, os_info, app_version, machine_id, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(code, secretToken, name, os_info || null, app_version || null, cleanMachineId, expiresAt, now).run();

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
  const { code, secret_token } = await c.req.json() as {
    code?: string;
    secret_token?: string;
  };

  if (!code || !secret_token) {
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

/**
 * Подтверждение связки владельцем в личном кабинете
 * POST /api/v1/pair/approve
 */
pairRouter.post('/approve', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const { code, action } = await c.req.json() as {
    code?: string;
    action?: 'standard' | 'transfer' | 'trial';
  };

  if (!code) {
    return c.json({ status: 'error', message: 'Код не указан' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const pairing = await c.env.DB.prepare(
    'SELECT * FROM device_pairings WHERE code = ?'
  ).bind(code).first<{
    code: string;
    device_name: string;
    os_info: string | null;
    app_version: string | null;
    machine_id: string | null;
    status: string;
    expires_at: number;
  }>();

  if (!pairing || now > pairing.expires_at) {
    return c.json({ status: 'error', message: 'Срок действия запроса истёк' }, 400);
  }

  if (pairing.status !== 'pending') {
    return c.json({ status: 'error', message: 'Запрос уже обработан' }, 400);
  }

  // Находим организацию и подписку пользователя
  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, m.role, s.plan_tier, s.status, s.current_period_end, s.max_devices, s.trial_used
    FROM organization_members m
    JOIN organizations o ON m.org_id = o.id
    LEFT JOIN subscriptions s ON s.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ org_id: string; role: string; plan_tier: string; status: string; current_period_end: number; max_devices: number; trial_used: number }>();

  if (!orgMember || orgMember.role !== 'owner') {
    return c.json({ status: 'error', message: 'Только владелец аккаунта может подтверждать привязку хоста' }, 403);
  }

  const workspace = await c.env.DB.prepare(
    'SELECT id FROM workspaces WHERE org_id = ? LIMIT 1'
  ).bind(orgMember.org_id).first<{ id: string }>();

  if (!workspace) {
    return c.json({ status: 'error', message: 'Рабочее пространство не найдено' }, 404);
  }

  // Повторная проверка machine_id: не зарегистрирован ли этот хост в другой организации
  if (pairing.machine_id) {
    const doubleCheck = await c.env.DB.prepare(`
      SELECT d.id FROM devices d
      JOIN workspaces w ON d.workspace_id = w.id
      WHERE d.machine_id = ? AND w.org_id != ?
      LIMIT 1
    `).bind(pairing.machine_id, orgMember.org_id).first();

    if (doubleCheck) {
      return c.json({
        status: 'error',
        message: 'Этот хост уже привязан к другому аккаунту. Сначала удалите его из прежнего аккаунта.'
      }, 409);
    }
  }

  const currentDevCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM devices d
    JOIN workspaces w ON d.workspace_id = w.id
    WHERE w.org_id = ?
  `).bind(orgMember.org_id).first<{ count: number }>();

  let count = currentDevCount?.count ?? 0;
  const effectiveTier = getEffectivePlanTier(orgMember.plan_tier, orgMember.status, orgMember.current_period_end, now);
  const maxDevs = getTierDeviceLimit(effectiveTier, orgMember.max_devices);

  let successMsg = `Хост «${pairing.device_name}» успешно привязан к аккаунту!`;
  let oldDeviceIdToRecord: string | null = null;

  if (count >= maxDevs) {
    if (action === 'transfer') {
      // Проверяем лимит переносов за 30 дней (максимум 4)
      const windowStart = now - (30 * 86400);
      const trRow = await c.env.DB.prepare(`
        SELECT COUNT(*) as count FROM host_transfers
        WHERE org_id = ? AND transferred_at > ?
      `).bind(orgMember.org_id, windowStart).first<{ count: number }>();

      const used = trRow?.count ?? 0;
      if (used >= 4) {
        return c.json({
          status: 'error',
          message: 'Исчерпан лимит переносов: не более 4 за последние 30 дней. Для подключения нескольких машин перейдите на тариф Pro.'
        }, 429);
      }

      // Находим старый хост для отключения
      const oldDev = await c.env.DB.prepare(`
        SELECT d.id, d.name FROM devices d
        JOIN workspaces w ON d.workspace_id = w.id
        WHERE w.org_id = ?
        ORDER BY d.created_at ASC
        LIMIT 1
      `).bind(orgMember.org_id).first<{ id: string; name: string }>();

      if (oldDev) {
        oldDeviceIdToRecord = oldDev.id;
        await c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(oldDev.id).run();
      }

      successMsg = `Привязка успешно перенесена на «${pairing.device_name}». Прежний компьютер отключен (использовано переносов: ${used + 1} из 4 за 30 дн.).`;
    } else if (action === 'trial') {
      if (effectiveTier !== 'free' || (orgMember.trial_used && orgMember.trial_used > 0)) {
        return c.json({ status: 'error', message: 'Пробный период Pro уже был использован ранее.' }, 400);
      }

      const trialEnd = now + (60 * 86400);
      await c.env.DB.prepare(`
        UPDATE subscriptions
        SET plan_tier = 'pro', status = 'trialing', max_devices = 3, trial_used = 1, current_period_end = ?
        WHERE org_id = ?
      `).bind(trialEnd, orgMember.org_id).run();

      successMsg = `Вам активирован ознакомительный период Pro на 60 дней (до 3 хостов)! Хост «${pairing.device_name}» успешно подключен.`;
    } else {
      return c.json({
        status: 'error',
        message: 'Достигнут лимит хостов на тарифе «Домашний (бесплатный)». Выберите перенос привязки на этот компьютер или включите пробный период Pro.'
      }, 400);
    }
  }

  // Выпускаем ключ устройства и регистрируем новый хост
  const devId = `dev_${crypto.randomUUID().replace(/-/g, '').substring(0, 10)}`;
  const { prefix, fullKey } = generateDeviceKey();
  const keyHash = await sha256Hex(fullKey);

  const batchQueries = [
    c.env.DB.prepare(`
      INSERT INTO devices (id, workspace_id, name, role, priority, key_hash, key_prefix, routing_mode, is_online, app_version, os_info, machine_id, created_at)
      VALUES (?, ?, ?, 'primary', 100, ?, ?, 'proxy', 0, ?, ?, ?, ?)
    `).bind(devId, workspace.id, pairing.device_name, keyHash, prefix, pairing.app_version, pairing.os_info, pairing.machine_id || null, now),

    c.env.DB.prepare(`
      UPDATE device_pairings
      SET status = 'approved', device_key = ?, workspace_id = ?
      WHERE code = ?
    `).bind(fullKey, workspace.id, code)
  ];

  if (action === 'transfer') {
    const trId = `tr_${crypto.randomUUID().replace(/-/g, '')}`;
    batchQueries.push(
      c.env.DB.prepare(`
        INSERT INTO host_transfers (id, org_id, old_device_id, new_device_id, transferred_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(trId, orgMember.org_id, oldDeviceIdToRecord, devId, now)
    );
  }

  await c.env.DB.batch(batchQueries);

  return c.json({
    status: 'ok',
    message: successMsg,
    device_id: devId
  });
});

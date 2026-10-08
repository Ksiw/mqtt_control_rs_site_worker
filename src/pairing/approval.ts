import { Hono } from 'hono';
import { Env, getTierDeviceLimit, getEffectivePlanTier } from '../types';
import { getCurrentUser } from '../core/session';
import { generateDeviceKey, sha256Hex } from '../crypto';

export const pairingApprovalRouter = new Hono<{ Bindings: Env }>();

/**
 * Подтверждение связки владельцем в личном кабинете
 * POST /api/v1/pair/approve
 */
pairingApprovalRouter.post('/approve', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { code, action } = body as {
    code?: string;
    action?: 'standard' | 'transfer' | 'trial';
  };

  if (typeof code !== 'string' || !code || code.length > 50 ||
      (action !== undefined && !['standard', 'transfer', 'trial'].includes(action))) {
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

  const count = currentDevCount?.count ?? 0;
  const effectiveTier = getEffectivePlanTier(orgMember.plan_tier, orgMember.status, orgMember.current_period_end, now);
  const maxDevs = getTierDeviceLimit(effectiveTier, orgMember.max_devices);

  const sameMachineDev = pairing.machine_id ? await c.env.DB.prepare(`
    SELECT d.id, d.name FROM devices d
    JOIN workspaces w ON d.workspace_id = w.id
    WHERE d.machine_id = ? AND w.org_id = ?
    LIMIT 1
  `).bind(pairing.machine_id, orgMember.org_id).first<{ id: string; name: string }>() : null;

  let successMsg = `Хост «${pairing.device_name}» успешно привязан к аккаунту!`;
  let oldDeviceIdToRecord: string | null = null;
  let startTrial = false;

  if (sameMachineDev) {
    oldDeviceIdToRecord = sameMachineDev.id;
    successMsg = `Привязка хоста «${pairing.device_name}» успешно обновлена!`;
  } else if (count >= maxDevs) {
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
      } else {
        return c.json({ status: 'error', message: 'Прежний хост не найден' }, 409);
      }

      successMsg = `Привязка успешно перенесена на «${pairing.device_name}». Прежний компьютер отключен (использовано переносов: ${used + 1} из 4 за 30 дн.).`;
    } else if (action === 'trial') {
      if (effectiveTier !== 'free' || (orgMember.trial_used && orgMember.trial_used > 0)) {
        return c.json({ status: 'error', message: 'Пробный период Pro уже был использован ранее.' }, 400);
      }

      startTrial = true;
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
  const transfer = oldDeviceIdToRecord !== null;
  const deviceCountSql = `
    SELECT COUNT(*) FROM devices d JOIN workspaces w ON w.id = d.workspace_id
    WHERE w.org_id = ?
  `;

  // Заявка закрепляется за одним подтверждением. Проверка лимита и все
  // изменения выполняются в одной транзакции D1.
  let claim;
  if (sameMachineDev) {
    claim = c.env.DB.prepare(`
      UPDATE device_pairings SET status = 'approved', device_key = ?, workspace_id = ?
      WHERE code = ? AND status = 'pending' AND expires_at >= ?
        AND EXISTS (SELECT 1 FROM devices d JOIN workspaces w ON w.id = d.workspace_id
          WHERE d.id = ? AND w.org_id = ?)
    `).bind(fullKey, workspace.id, code, now, oldDeviceIdToRecord, orgMember.org_id);
  } else if (transfer) {
    claim = c.env.DB.prepare(`
      UPDATE device_pairings SET status = 'approved', device_key = ?, workspace_id = ?
      WHERE code = ? AND status = 'pending' AND expires_at >= ?
        AND EXISTS (SELECT 1 FROM devices d JOIN workspaces w ON w.id = d.workspace_id
          WHERE d.id = ? AND w.org_id = ?)
        AND (${deviceCountSql}) <= ?
        AND (SELECT COUNT(*) FROM host_transfers WHERE org_id = ? AND transferred_at > ?) < 4
    `).bind(fullKey, workspace.id, code, now, oldDeviceIdToRecord, orgMember.org_id,
      orgMember.org_id, maxDevs, orgMember.org_id, now - 30 * 86400);
  } else if (startTrial) {
    claim = c.env.DB.prepare(`
      UPDATE device_pairings SET status = 'approved', device_key = ?, workspace_id = ?
      WHERE code = ? AND status = 'pending' AND expires_at >= ?
        AND EXISTS (SELECT 1 FROM subscriptions WHERE org_id = ?
          AND COALESCE(trial_used, 0) = 0
          AND NOT (plan_tier IN ('pro', 'enterprise')
            AND status IN ('active', 'trialing') AND current_period_end > ?))
        AND (${deviceCountSql}) < 3
    `).bind(fullKey, workspace.id, code, now, orgMember.org_id, now, orgMember.org_id);
  } else {
    claim = c.env.DB.prepare(`
      UPDATE device_pairings SET status = 'approved', device_key = ?, workspace_id = ?
      WHERE code = ? AND status = 'pending' AND expires_at >= ?
        AND (${deviceCountSql}) < ?
    `).bind(fullKey, workspace.id, code, now, orgMember.org_id, maxDevs);
  }

  const batchQueries = [
    claim,
    c.env.DB.prepare(`
      INSERT INTO devices (id, workspace_id, name, role, priority, key_hash, key_prefix, routing_mode, is_online, app_version, os_info, machine_id, created_at)
      SELECT ?, ?, ?, 'primary', 100, ?, ?, 'proxy', 0, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM device_pairings
        WHERE code = ? AND status = 'approved' AND device_key = ?)
    `).bind(devId, workspace.id, pairing.device_name, keyHash, prefix,
      pairing.app_version, pairing.os_info, pairing.machine_id || null, now, code, fullKey)
  ];

  if (startTrial) {
    batchQueries.push(c.env.DB.prepare(`
      UPDATE subscriptions
      SET plan_tier = 'pro', status = 'trialing', max_devices = 3,
          trial_used = 1, current_period_end = ?
      WHERE org_id = ? AND COALESCE(trial_used, 0) = 0
        AND EXISTS (SELECT 1 FROM devices WHERE id = ?)
    `).bind(now + 60 * 86400, orgMember.org_id, devId));
  }

  if (transfer) {
    batchQueries.push(c.env.DB.prepare(`
      DELETE FROM dashboards WHERE device_id = ?
        AND EXISTS (SELECT 1 FROM devices WHERE id = ?)
    `).bind(oldDeviceIdToRecord, devId));
    batchQueries.push(c.env.DB.prepare(`
      DELETE FROM devices WHERE id = ?
        AND EXISTS (SELECT 1 FROM devices WHERE id = ?)
    `).bind(oldDeviceIdToRecord, devId));
    if (!sameMachineDev) {
      const trId = `tr_${crypto.randomUUID().replace(/-/g, '')}`;
      batchQueries.push(
        c.env.DB.prepare(`
          INSERT INTO host_transfers (id, org_id, old_device_id, new_device_id, transferred_at)
          SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM devices WHERE id = ?)
        `).bind(trId, orgMember.org_id, oldDeviceIdToRecord, devId, now, devId)
      );
    }
  }

  const changes = await c.env.DB.batch(batchQueries);
  if (changes[0]?.meta.changes !== 1 || changes[1]?.meta.changes !== 1) {
    return c.json({ status: 'error', message: 'Запрос уже обработан или лимит хостов изменился' }, 409);
  }

  return c.json({
    status: 'ok',
    message: successMsg,
    device_id: devId
  });
});

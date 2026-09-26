import { Hono, Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { Env, User, Organization, Workspace, Device } from './types';
import { renderLoginHtml } from './login_view';
import { renderCabinetHtml } from './cabinet_views';
import { isSuperAdmin } from './admin';

export const cabinetRouter = new Hono<{ Bindings: Env }>();

/**
 * Получение текущего пользователя по токену сессии из Cookies
 */
export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  const token = getCookie(c, 'session');
  if (!token) return null;

  const now = Math.floor(Date.now() / 1000);
  const session = await c.env.DB.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, now).first<User>();

  return session || null;
}

/**
 * Генерация секретного ключа устройства
 */
export function generateDeviceKey(): { prefix: string; fullKey: string } {
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  const keyBody = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const fullKey = `mcrs_live_${keyBody}`;
  const prefix = fullKey.substring(0, 16);
  return { prefix, fullKey };
}

/**
 * Вычисление SHA-256 хеша для безопасного хранения ключей в D1
 */
export async function sha256Hex(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Главный экран личного кабинета / диспетчерской
 */
export const handleCabinet = async (c: Context<{ Bindings: Env }>) => {
  const user = await getCurrentUser(c);

  // 1. Если не авторизован — экран входа
  if (!user) {
    return c.html(renderLoginHtml());
  }

  // 2. Если авторизован — запрашиваем список организаций, пространств, устройств и дашбордов
  const orgs = await c.env.DB.prepare(`
    SELECT o.* FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ?
  `).bind(user.id).all<Organization>();

  const orgList = orgs.results || [];
  const currentOrg = orgList[0];

  let workspaces: Workspace[] = [];
  let devices: Device[] = [];
  let dashboards: any[] = [];
  let members: any[] = [];
  let pendingInvites: any[] = [];
  let planTier = 'free';
  let maxDevices = 1;
  let maxMembers = 5;
  let isOwner = false;

  if (currentOrg) {
    isOwner = currentOrg.owner_user_id === user.id;

    // Подписка и лимиты
    const sub = await c.env.DB.prepare(
      'SELECT * FROM subscriptions WHERE org_id = ?'
    ).bind(currentOrg.id).first<{ plan_tier: string; status: string; current_period_end: number; max_devices: number }>();

    let isTrial = false;
    let daysLeft = 0;
    if (sub) {
      planTier = sub.plan_tier || 'free';
      maxDevices = sub.max_devices || 1;
      maxMembers = planTier === 'pro' ? 15 : planTier === 'enterprise' ? 9999 : 5;
      if (sub.status === 'trialing') {
        isTrial = true;
        const now = Math.floor(Date.now() / 1000);
        daysLeft = Math.max(0, Math.ceil((sub.current_period_end - now) / 86400));
      }
    }

    // Члены семьи и организации
    const memRes = await c.env.DB.prepare(`
      SELECT u.id, u.name, u.email, m.role, (o.owner_user_id = u.id) as is_owner
      FROM organization_members m
      JOIN users u ON m.user_id = u.id
      JOIN organizations o ON m.org_id = o.id
      WHERE m.org_id = ?
    `).bind(currentOrg.id).all();
    members = memRes.results || [];

    // Ожидающие инвайты
    const invRes = await c.env.DB.prepare(
      'SELECT * FROM invites WHERE org_id = ?'
    ).bind(currentOrg.id).all();
    pendingInvites = invRes.results || [];

    // Пространства и связанные данные
    const wsRes = await c.env.DB.prepare(
      'SELECT * FROM workspaces WHERE org_id = ?'
    ).bind(currentOrg.id).all<Workspace>();
    workspaces = wsRes.results || [];

    if (workspaces.length > 0) {
      const wsIds = workspaces.map(w => `'${w.id}'`).join(',');
      const now = Math.floor(Date.now() / 1000);
      
      const devRes = await c.env.DB.prepare(
        `SELECT *, CASE WHEN is_online = 1 AND (? - COALESCE(last_heartbeat_at, 0)) <= 60 THEN 1 ELSE 0 END as is_online 
         FROM devices 
         WHERE workspace_id IN (${wsIds})`
      ).bind(now).all<Device>();
      devices = devRes.results || [];

      if (devices.length > 0) {
        const dashRes = await c.env.DB.prepare(
          `SELECT d.*, w.slug as ws_slug, o.slug as org_slug 
           FROM dashboards d 
           JOIN workspaces w ON d.workspace_id = w.id
           JOIN organizations o ON w.org_id = o.id
           WHERE d.workspace_id IN (${wsIds})`
        ).all();
        dashboards = (dashRes.results || []).map((d: any) => {
          let devOnline = 0;
          if (d.device_id) {
            const dev = devices.find(dev => dev.id === d.device_id);
            devOnline = dev && dev.is_online === 1 ? 1 : 0;
          } else {
            devOnline = devices.some(dev => dev.workspace_id === d.workspace_id && dev.is_online === 1) ? 1 : 0;
          }
          return {
            ...d,
            is_online: devOnline
          };
        });
      } else {
        dashboards = [];
        await c.env.DB.prepare(`DELETE FROM dashboards WHERE workspace_id IN (${wsIds})`).run();
      }
    }

    const paymentQuery = c.req.query('payment');
    let paymentNotification: string | undefined;
    if (paymentQuery === 'success') {
      paymentNotification = '✓ Оплата успешно принята! Ваш тариф Pro активирован.';
    } else if (paymentQuery === 'cancel') {
      paymentNotification = 'Оплата была отменена.';
    }

    return c.html(renderCabinetHtml({
      user,
      currentOrg,
      workspaces,
      devices,
      dashboards,
      members,
      pendingInvites,
      planTier,
      maxDevices,
      maxMembers,
      isOwner,
      isSuperAdmin: isSuperAdmin(user),
      isTrial,
      daysLeft,
      paymentNotification
    }));
  }

  const paymentQuery = c.req.query('payment');
  let paymentNotification: string | undefined;
  if (paymentQuery === 'success') {
    paymentNotification = '✓ Оплата успешно принята! Ваш тариф Pro активирован.';
  } else if (paymentQuery === 'cancel') {
    paymentNotification = 'Оплата была отменена.';
  }

  return c.html(renderCabinetHtml({
    user,
    currentOrg: currentOrg || { id: '', name: '', slug: '', owner_user_id: user.id },
    workspaces,
    devices,
    dashboards,
    members,
    pendingInvites,
    planTier,
    maxDevices,
    maxMembers,
    isOwner: true,
    isSuperAdmin: isSuperAdmin(user),
    paymentNotification
  }));
};

cabinetRouter.get('/', handleCabinet);
cabinetRouter.get('/cabinet', handleCabinet);

/**
 * API выпуска нового ключа хоста
 * POST /api/v1/devices/create
 */
cabinetRouter.post('/api/v1/devices/create', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const { workspace_id, name, role } = await c.req.json() as {
    workspace_id: string;
    name: string;
    role?: 'primary' | 'standby';
  };

  if (!workspace_id || !name) {
    return c.json({ status: 'error', message: 'Не указаны обязательные поля' }, 400);
  }

  // Проверяем организацию, подписку и лимит хостов
  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, s.plan_tier, s.status, s.max_devices, s.trial_used, m.role as user_role
    FROM workspaces w
    JOIN organizations o ON w.org_id = o.id
    JOIN organization_members m ON m.org_id = o.id AND m.user_id = ?
    LEFT JOIN subscriptions s ON s.org_id = o.id
    WHERE w.id = ?
  `).bind(user.id, workspace_id).first<{ org_id: string; plan_tier: string; status: string; max_devices: number; trial_used: number; user_role: string }>();

  if (!orgMember) {
    return c.json({ status: 'error', message: 'Рабочее пространство не найдено или у вас нет доступа к этой организации' }, 403);
  }

  if (orgMember.user_role !== 'owner' && orgMember.user_role !== 'admin') {
    return c.json({ status: 'error', message: 'Только владелец или администратор организации может создавать хосты' }, 403);
  }

  const maxDevices = orgMember?.max_devices ?? 1;
  const currentDevCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM devices d
    JOIN workspaces w ON d.workspace_id = w.id
    WHERE w.org_id = ?
  `).bind(orgMember?.org_id || '').first<{ count: number }>();

  const count = currentDevCount?.count ?? 0;
  const now = Math.floor(Date.now() / 1000);

  if (count >= maxDevices) {
    return c.json({
      status: 'error',
      message: orgMember?.trial_used === 1
        ? 'Пробный период Pro (60 дней) уже был использован. В бесплатном тарифе доступен 1 хост. Чтобы подключить дополнительный хост, оформите подписку Pro.'
        : 'В бесплатном тарифе доступен 1 хост. Чтобы перенести привязку на новый компьютер или подключить дополнительный хост, используйте кнопку связки в программе или оформите Pro.'
    }, 403);
  }

  const devId = `dev_${crypto.randomUUID().replace(/-/g, '').substring(0, 10)}`;
  const { prefix, fullKey } = generateDeviceKey();
  const keyHash = await sha256Hex(fullKey);

  await c.env.DB.prepare(`
    INSERT INTO devices (id, workspace_id, name, role, priority, key_hash, key_prefix, routing_mode, is_online, created_at)
    VALUES (?, ?, ?, ?, 100, ?, ?, 'proxy', 0, ?)
  `).bind(devId, workspace_id, name, role || 'primary', keyHash, prefix, now).run();

  return c.json({
    status: 'ok',
    device_id: devId,
    device_key: fullKey
  });
});

/**
 * API удаления хоста / устройства
 * POST /api/v1/devices/delete
 */
cabinetRouter.post('/api/v1/devices/delete', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const { device_id } = await c.req.json() as { device_id: string };
  if (!device_id) {
    return c.json({ status: 'error', message: 'Не указан идентификатор устройства' }, 400);
  }

  const device = await c.env.DB.prepare(`
    SELECT d.id, d.name, d.workspace_id, o.owner_user_id
    FROM devices d
    JOIN workspaces w ON d.workspace_id = w.id
    JOIN organizations o ON w.org_id = o.id
    WHERE d.id = ?
  `).bind(device_id).first<{ id: string; name: string; workspace_id: string; owner_user_id: string }>();

  if (!device) {
    return c.json({ status: 'error', message: 'Хост не найден' }, 404);
  }

  if (device.owner_user_id !== user.id) {
    return c.json({ status: 'error', message: 'Только владелец организации может удалять хосты' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device_id).run();
  await c.env.DB.prepare('DELETE FROM dashboards WHERE device_id = ?').bind(device_id).run();

  const remaining = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM devices WHERE workspace_id = ?'
  ).bind(device.workspace_id).first<{ count: number }>();
  if ((remaining?.count ?? 0) === 0) {
    await c.env.DB.prepare('DELETE FROM dashboards WHERE workspace_id = ?').bind(device.workspace_id).run();
  }

  return c.json({
    status: 'ok',
    message: `Хост "${device.name}" успешно удалён`
  });
});

/**
 * Легковесный API для опроса состояния личного кабинета (Live Updates)
 * GET /api/v1/cabinet/state
 */
cabinetRouter.get('/api/v1/cabinet/state', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'unauthorized' }, 401);
  }

  const org = await c.env.DB.prepare(`
    SELECT o.id FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ id: string }>();

  if (!org) {
    return c.json({ status: 'ok', devices: [], dashboards: [] });
  }

  const workspaces = await c.env.DB.prepare(
    'SELECT id FROM workspaces WHERE org_id = ?'
  ).bind(org.id).all<{ id: string }>();

  const wsList = workspaces.results || [];
  if (wsList.length === 0) {
    return c.json({ status: 'ok', devices: [], dashboards: [] });
  }

  const wsIds = wsList.map(w => `'${w.id}'`).join(',');
  const now = Math.floor(Date.now() / 1000);

  const devRes = await c.env.DB.prepare(
    `SELECT id, name, role, CASE WHEN is_online = 1 AND (? - COALESCE(last_heartbeat_at, 0)) <= 60 THEN 1 ELSE 0 END as is_online, app_version 
     FROM devices 
     WHERE workspace_id IN (${wsIds})`
  ).bind(now).all<any>();
  const devices = devRes.results || [];

  let dashboards: any[] = [];
  if (devices.length > 0) {
    const dashRes = await c.env.DB.prepare(
      `SELECT d.id, d.name, d.slug, d.device_id, w.slug as ws_slug,
              CASE 
                WHEN d.device_id IS NOT NULL THEN
                  EXISTS(SELECT 1 FROM devices dev WHERE dev.id = d.device_id AND dev.is_online = 1 AND (? - COALESCE(dev.last_heartbeat_at, 0)) <= 60)
                ELSE
                  EXISTS(SELECT 1 FROM devices dev WHERE dev.workspace_id = d.workspace_id AND dev.is_online = 1 AND (? - COALESCE(dev.last_heartbeat_at, 0)) <= 60)
              END as is_online
       FROM dashboards d 
       JOIN workspaces w ON d.workspace_id = w.id
       WHERE d.workspace_id IN (${wsIds})`
    ).bind(now, now).all<any>();
    dashboards = dashRes.results || [];
  }

  return c.json({
    status: 'ok',
    devices,
    dashboards
  });
});


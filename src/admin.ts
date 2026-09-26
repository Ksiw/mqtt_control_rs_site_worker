import { Hono } from 'hono';
import { Env, User } from './types';
import { getCurrentUser } from './cabinet';

export const adminRouter = new Hono<{ Bindings: Env }>();

/**
 * Список супер-администраторов системы
 */
export const SUPERADMIN_EMAILS = [
  '754marcus@gmail.com',
  'stewhiki@gmail.com'
];

/**
 * Проверка прав супер-администратора
 */
export function isSuperAdmin(user: User | null): boolean {
  if (!user || !user.email) return false;
  return SUPERADMIN_EMAILS.includes(user.email.toLowerCase().trim());
}

/**
 * Получить список всех пользователей с их подписками
 * GET /api/v1/admin/users
 */
adminRouter.get('/users', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const query = `
    SELECT 
      u.id as user_id,
      u.email,
      u.name,
      u.created_at as registered_at,
      o.id as org_id,
      o.name as org_name,
      s.id as subscription_id,
      COALESCE(s.plan_tier, 'free') as plan_tier,
      COALESCE(s.status, 'active') as status,
      COALESCE(s.current_period_end, 0) as current_period_end,
      COALESCE(s.max_devices, 1) as max_devices
    FROM users u
    LEFT JOIN organizations o ON o.owner_user_id = u.id
    LEFT JOIN subscriptions s ON s.org_id = o.id
    ORDER BY u.created_at DESC
  `;

  const { results } = await c.env.DB.prepare(query).all();
  return c.json({ status: 'ok', users: results || [] });
});

/**
 * Выдать или продлить Pro лицензию
 * POST /api/v1/admin/license/grant
 * Body: { email: string, duration: 'month' | 'year' | 'lifetime' }
 */
adminRouter.post('/license/grant', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const { email, duration } = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    duration?: 'month' | 'year' | 'lifetime';
  };

  if (!email) {
    return c.json({ status: 'error', message: 'Не указан email пользователя' }, 400);
  }

  const targetEmail = email.toLowerCase().trim();

  // Ищем пользователя
  const targetUser = await c.env.DB.prepare(
    'SELECT id, email FROM users WHERE LOWER(email) = ?'
  ).bind(targetEmail).first<{ id: string; email: string }>();

  if (!targetUser) {
    return c.json({ status: 'error', message: `Пользователь с email ${targetEmail} не найден в системе` }, 404);
  }

  // Находим организацию пользователя (или создаем, если отсутствует)
  let org = await c.env.DB.prepare(
    'SELECT id FROM organizations WHERE owner_user_id = ?'
  ).bind(targetUser.id).first<{ id: string }>();

  if (!org) {
    const orgId = `org_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(
      'INSERT INTO organizations (id, slug, name, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(orgId, `org-${orgId.slice(4)}`, `Организация ${targetUser.email}`, targetUser.id, now).run();
    org = { id: orgId };
  }

  // Расчет срока действия
  const now = Math.floor(Date.now() / 1000);
  const existingSub = await c.env.DB.prepare(
    'SELECT * FROM subscriptions WHERE org_id = ?'
  ).bind(org.id).first<{ id: string; current_period_end: number; plan_tier: string }>();

  let periodEnd = now;
  if (existingSub && existingSub.current_period_end > now && existingSub.plan_tier === 'pro') {
    periodEnd = existingSub.current_period_end;
  }

  if (duration === 'month') {
    periodEnd += 30 * 86400;
  } else if (duration === 'year') {
    periodEnd += 365 * 86400;
  } else if (duration === 'lifetime') {
    periodEnd = now + 50 * 365 * 86400; // 50 лет
  } else {
    periodEnd += 30 * 86400; // по умолчанию месяц
  }

  if (existingSub) {
    await c.env.DB.prepare(`
      UPDATE subscriptions
      SET plan_tier = 'pro', status = 'active', max_devices = 10, max_dashboards = 50, current_period_end = ?
      WHERE org_id = ?
    `).bind(periodEnd, org.id).run();
  } else {
    const subId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await c.env.DB.prepare(`
      INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces, max_devices, max_dashboards, current_period_end, created_at)
      VALUES (?, ?, 'pro', 'active', 5, 10, 50, ?, ?)
    `).bind(subId, org.id, periodEnd, now).run();
  }

  return c.json({
    status: 'ok',
    message: `Лицензия Pro успешно активирована для ${targetEmail}`,
    current_period_end: periodEnd
  });
});

/**
 * Отозвать Pro лицензию (сбросить на бесплатный тариф)
 * POST /api/v1/admin/license/revoke
 * Body: { email: string }
 */
adminRouter.post('/license/revoke', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const { email } = (await c.req.json().catch(() => ({}))) as { email?: string };
  if (!email) {
    return c.json({ status: 'error', message: 'Не указан email пользователя' }, 400);
  }

  const targetEmail = email.toLowerCase().trim();
  const targetUser = await c.env.DB.prepare(
    'SELECT id, email FROM users WHERE LOWER(email) = ?'
  ).bind(targetEmail).first<{ id: string; email: string }>();

  if (!targetUser) {
    return c.json({ status: 'error', message: `Пользователь ${targetEmail} не найден` }, 404);
  }

  const org = await c.env.DB.prepare(
    'SELECT id FROM organizations WHERE owner_user_id = ?'
  ).bind(targetUser.id).first<{ id: string }>();

  if (org) {
    const now = Math.floor(Date.now() / 1000);
    await c.env.DB.prepare(`
      UPDATE subscriptions
      SET plan_tier = 'free', status = 'active', max_devices = 1, max_dashboards = 10, current_period_end = ?
      WHERE org_id = ?
    `).bind(now, org.id).run();
  }

  return c.json({
    status: 'ok',
    message: `Лицензия Pro отозвана для ${targetEmail}. Тариф сброшен на Free.`
  });
});

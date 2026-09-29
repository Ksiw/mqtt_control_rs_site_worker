import { Hono } from 'hono';
import { Env, User } from './types';
import { getCurrentUser } from './cabinet';
import { addCalendarMonths, addCalendarYears } from './calendar';

export const adminRouter = new Hono<{ Bindings: Env }>();

/**
 * Список супер-администраторов системы (только Marcus)
 */
export const SUPERADMIN_EMAILS = [
  '754marcus@gmail.com'
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

  const now = Math.floor(Date.now() / 1000);
  const query = `
    SELECT
      u.id as user_id,
      u.email,
      u.name,
      u.created_at as registered_at,
      o.id as org_id,
      o.name as org_name,
      s.id as subscription_id,
      CASE WHEN s.plan_tier IN ('pro', 'enterprise')
             AND s.status IN ('active', 'trialing') AND s.current_period_end > ?
           THEN s.plan_tier ELSE 'free' END as plan_tier,
      COALESCE(s.status, 'active') as status,
      COALESCE(s.current_period_end, 0) as current_period_end,
      CASE
        WHEN s.plan_tier = 'pro' AND s.status IN ('active', 'trialing') AND s.current_period_end > ? THEN 3
        WHEN s.plan_tier = 'enterprise' AND s.status IN ('active', 'trialing') AND s.current_period_end > ? THEN COALESCE(s.max_devices, 50)
        ELSE 1
      END as max_devices
    FROM users u
    LEFT JOIN organizations o ON o.owner_user_id = u.id
    LEFT JOIN subscriptions s ON s.org_id = o.id
    ORDER BY u.created_at DESC
  `;

  const { results } = await c.env.DB.prepare(query).bind(now, now, now).all();
  return c.json({ status: 'ok', users: results || [] });
});

/**
 * Выдать или продлить Pro / Enterprise лицензию
 * POST /api/v1/admin/license/grant
 * Body: { email: string, tier?: 'pro' | 'enterprise', duration: 'month' | 'year' | 'lifetime', max_devices?: number }
 */
adminRouter.post('/license/grant', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const { email, tier, duration, max_devices } = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    tier?: 'pro' | 'enterprise';
    duration?: 'month' | 'year' | 'lifetime';
    max_devices?: number;
  };

  if (!email) {
    return c.json({ status: 'error', message: 'Не указан email пользователя' }, 400);
  }

  const targetEmail = email.toLowerCase().trim();
  const planTier = tier === 'enterprise' ? 'enterprise' : 'pro';

  // Для Enterprise лимит хостов задается администратором вручную, для Pro — строго 3
  const limitDevices = planTier === 'enterprise'
    ? (max_devices && max_devices > 0 ? Math.min(Math.max(1, Math.floor(max_devices)), 9999) : 50)
    : 3;
  const limitDashboards = planTier === 'enterprise' ? 500 : 50;
  const limitWorkspaces = planTier === 'enterprise' ? 100 : 5;

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
  if (existingSub && existingSub.current_period_end > now && existingSub.plan_tier === planTier) {
    periodEnd = existingSub.current_period_end;
  }

  if (duration === 'month') {
    periodEnd = addCalendarMonths(periodEnd, 1);
  } else if (duration === 'year') {
    periodEnd = addCalendarYears(periodEnd, 1);
  } else if (duration === 'lifetime') {
    periodEnd = addCalendarYears(now, 50); // 50 лет
  } else {
    periodEnd = addCalendarMonths(periodEnd, 1); // по умолчанию календарный месяц
  }

  if (existingSub) {
    await c.env.DB.prepare(`
      UPDATE subscriptions
      SET plan_tier = ?, status = 'active', max_devices = ?, max_dashboards = ?, max_workspaces = ?, current_period_end = ?
      WHERE org_id = ?
    `).bind(planTier, limitDevices, limitDashboards, limitWorkspaces, periodEnd, org.id).run();
  } else {
    const subId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await c.env.DB.prepare(`
      INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces, max_devices, max_dashboards, current_period_end, created_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).bind(subId, org.id, planTier, limitWorkspaces, limitDevices, limitDashboards, periodEnd, now).run();
  }

  const tierLabel = planTier === 'enterprise' ? 'Enterprise' : 'Pro';
  return c.json({
    status: 'ok',
    message: `Лицензия ${tierLabel} (до ${limitDevices} хостов) успешно активирована для ${targetEmail}`,
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
    message: `Лицензия Pro отозвана для ${targetEmail}. Тариф сброшен на Домашний (бесплатный).`
  });
});

/**
 * Получить системные цены на подписку
 */
export async function getPlanPrices(db: D1Database): Promise<{ month: number; year: number }> {
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM system_settings WHERE key IN ('price_month_usd', 'price_year_usd')"
    ).all<{ key: string; value: string }>();

    let month = 12.0;
    let year = 100.0;

    for (const r of rows.results || []) {
      if (r.key === 'price_month_usd') {
        const val = parseFloat(r.value);
        if (!isNaN(val) && val > 0) month = val;
      } else if (r.key === 'price_year_usd') {
        const val = parseFloat(r.value);
        if (!isNaN(val) && val > 0) year = val;
      }
    }
    return { month, year };
  } catch {
    return { month: 12.0, year: 100.0 };
  }
}

/**
 * Получить текущие цены (для админки)
 * GET /api/v1/admin/pricing
 */
adminRouter.get('/pricing', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const prices = await getPlanPrices(c.env.DB);
  return c.json({ status: 'ok', pricing: prices });
});

/**
 * Изменить цены подписки
 * POST /api/v1/admin/pricing
 * Body: { month: number, year: number }
 */
adminRouter.post('/pricing', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const { month, year } = (await c.req.json().catch(() => ({}))) as {
    month?: number;
    year?: number;
  };

  if (typeof month !== 'number' || typeof year !== 'number' || month <= 0 || year <= 0) {
    return c.json({ status: 'error', message: 'Некорректные цены' }, 400);
  }

  const now = Math.floor(Date.now() / 1000);

  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES ('price_month_usd', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(month.toFixed(2), now),
    c.env.DB.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES ('price_year_usd', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(year.toFixed(2), now),
  ]);

  return c.json({
    status: 'ok',
    message: `Цены успешно обновлены: $${month}/мес, $${year}/год`,
    pricing: { month, year }
  });
});

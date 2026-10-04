import { Hono } from 'hono';
import { Env, getEffectivePlanTier } from './types';
import { getCurrentUser } from './core/session';

export const familyRouter = new Hono<{ Bindings: Env }>();

/**
 * Пригласить члена семьи / оператора по Email
 * POST /api/v1/family/invite
 */
familyRouter.post('/invite', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { email, role } = body as { email?: string; role?: string };
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length < 5 || cleanEmail.length > 254) {
    return c.json({ status: 'error', message: 'Укажите корректный адрес электронной почты' }, 400);
  }

  // Получаем организацию текущего пользователя
  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, o.owner_user_id, m.role, s.plan_tier, s.status, s.current_period_end
    FROM organization_members m
    JOIN organizations o ON m.org_id = o.id
    LEFT JOIN subscriptions s ON s.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ org_id: string; owner_user_id: string; role: string; plan_tier: string; status: string; current_period_end: number }>();

  if (!orgMember || (orgMember.role !== 'owner' && orgMember.role !== 'admin')) {
    return c.json({ status: 'error', message: 'Только владелец может приглашать пользователей' }, 403);
  }

  if (cleanEmail === user.email.toLowerCase()) {
    return c.json({ status: 'error', message: 'Нельзя пригласить самого себя' }, 400);
  }

  // Проверяем лимит пользователей для тарифа (для free — 5)
  const effectiveTier = getEffectivePlanTier(orgMember.plan_tier, orgMember.status, orgMember.current_period_end, Math.floor(Date.now() / 1000));
  const maxAccounts = effectiveTier === 'pro' ? 15 : effectiveTier === 'enterprise' ? 9999 : 5;

  const currentMembers = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM organization_members WHERE org_id = ?'
  ).bind(orgMember.org_id).first<{ count: number }>();

  const pendingInvites = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM invites WHERE org_id = ?'
  ).bind(orgMember.org_id).first<{ count: number }>();

  const total = (currentMembers?.count ?? 0) + (pendingInvites?.count ?? 0);
  if (total >= maxAccounts) {
    return c.json({
      status: 'error',
      message: `Достигнут лимит тарифа «Домашний (бесплатный)» (${maxAccounts} аккаунтов). Чтобы добавить больше людей, необходим тариф Pro.`
    }, 403);
  }

  // Проверяем, не состоит ли пользователь уже в организации
  const alreadyMember = await c.env.DB.prepare(`
    SELECT m.user_id FROM organization_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.org_id = ? AND lower(u.email) = ?
  `).bind(orgMember.org_id, cleanEmail).first();

  if (alreadyMember) {
    return c.json({ status: 'error', message: 'Этот пользователь уже подключён к вашему пространству' }, 400);
  }

  // Проверяем, не выслано ли уже приглашение
  const alreadyInvited = await c.env.DB.prepare(
    'SELECT id FROM invites WHERE org_id = ? AND lower(email) = ?'
  ).bind(orgMember.org_id, cleanEmail).first();

  if (alreadyInvited) {
    return c.json({ status: 'error', message: 'Приглашение для этого адреса уже создано' }, 400);
  }

  // Если пользователь уже зарегистрирован в системе, привязываем его сразу
  const registeredUser = await c.env.DB.prepare(
    'SELECT id FROM users WHERE lower(email) = ?'
  ).bind(cleanEmail).first<{ id: string }>();

  const now = Math.floor(Date.now() / 1000);
  const quotaCondition = `
    (SELECT COUNT(*) FROM organization_members WHERE org_id = ?) +
    (SELECT COUNT(*) FROM invites WHERE org_id = ?) < ?
  `;

  if (registeredUser) {
    const inserted = await c.env.DB.prepare(`
      INSERT INTO organization_members (org_id, user_id, role, created_at)
      SELECT ?, ?, ?, ? WHERE ${quotaCondition}
        AND EXISTS (SELECT 1 FROM organization_members
          WHERE org_id = ? AND user_id = ? AND role IN ('owner', 'admin'))
        AND NOT EXISTS (SELECT 1 FROM organization_members
          WHERE org_id = ? AND user_id = ?)
    `).bind(orgMember.org_id, registeredUser.id, role === 'viewer' ? 'viewer' : 'operator', now,
      orgMember.org_id, orgMember.org_id, maxAccounts, orgMember.org_id, user.id,
      orgMember.org_id, registeredUser.id).run();
    if (inserted.meta.changes !== 1) {
      return c.json({ status: 'error', message: 'Лимит пользователей или права доступа изменились' }, 409);
    }

    return c.json({
      status: 'ok',
      message: `Пользователь ${cleanEmail} успешно подключён к пространству`
    });
  }

  // Иначе сохраняем приглашение — при первом входе через Google он подключится автоматически
  const inviteId = `inv_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const inserted = await c.env.DB.prepare(`
    INSERT INTO invites (id, org_id, email, role, created_at)
    SELECT ?, ?, ?, ?, ? WHERE ${quotaCondition}
      AND EXISTS (SELECT 1 FROM organization_members
        WHERE org_id = ? AND user_id = ? AND role IN ('owner', 'admin'))
      AND NOT EXISTS (SELECT 1 FROM invites
        WHERE org_id = ? AND lower(email) = ?)
  `).bind(inviteId, orgMember.org_id, cleanEmail, role === 'viewer' ? 'viewer' : 'operator', now,
    orgMember.org_id, orgMember.org_id, maxAccounts, orgMember.org_id, user.id,
    orgMember.org_id, cleanEmail).run();
  if (inserted.meta.changes !== 1) {
    return c.json({ status: 'error', message: 'Лимит пользователей или права доступа изменились' }, 409);
  }

  return c.json({
    status: 'ok',
    message: `Приглашение отправлено на ${cleanEmail}. При входе через Google доступ откроется автоматически.`
  });
});

/**
 * Удалить доступ или отменить приглашение
 * POST /api/v1/family/remove
 */
familyRouter.post('/remove', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { user_id, email } = body as { user_id?: string; email?: string };
  if ((user_id !== undefined && typeof user_id !== 'string') ||
      (email !== undefined && typeof email !== 'string') ||
      (!user_id && !email)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }

  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, o.owner_user_id, m.role
    FROM organization_members m
    JOIN organizations o ON m.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ org_id: string; owner_user_id: string; role: string }>();

  if (!orgMember || orgMember.role !== 'owner') {
    return c.json({ status: 'error', message: 'Только владелец может отзывать доступ' }, 403);
  }

  if (user_id) {
    if (user_id === orgMember.owner_user_id) {
      return c.json({ status: 'error', message: 'Нельзя отозвать доступ у владельца' }, 400);
    }
    await c.env.DB.prepare(
      'DELETE FROM organization_members WHERE org_id = ? AND user_id = ?'
    ).bind(orgMember.org_id, user_id).run();
  } else if (email) {
    await c.env.DB.prepare(
      'DELETE FROM invites WHERE org_id = ? AND lower(email) = lower(?)'
    ).bind(orgMember.org_id, email).run();
  }

  return c.json({ status: 'ok', message: 'Доступ успешно отозван' });
});

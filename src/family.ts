import { Hono } from 'hono';
import { Env, User } from './types';
import { getCurrentUser } from './cabinet';

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

  const { email, role } = await c.req.json() as { email?: string; role?: string };
  const cleanEmail = email?.trim().toLowerCase();

  if (!cleanEmail || !cleanEmail.includes('@') || cleanEmail.length < 5) {
    return c.json({ status: 'error', message: 'Укажите корректный адрес электронной почты' }, 400);
  }

  // Получаем организацию текущего пользователя
  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, o.owner_user_id, m.role, s.plan_tier
    FROM organization_members m
    JOIN organizations o ON m.org_id = o.id
    LEFT JOIN subscriptions s ON s.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ org_id: string; owner_user_id: string; role: string; plan_tier: string }>();

  if (!orgMember || (orgMember.role !== 'owner' && orgMember.role !== 'admin')) {
    return c.json({ status: 'error', message: 'Только владелец может приглашать пользователей' }, 403);
  }

  if (cleanEmail === user.email.toLowerCase()) {
    return c.json({ status: 'error', message: 'Нельзя пригласить самого себя' }, 400);
  }

  // Проверяем лимит пользователей для тарифа (для free — 5)
  const maxAccounts = orgMember.plan_tier === 'pro' ? 15 : orgMember.plan_tier === 'enterprise' ? 9999 : 5;

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

  if (registeredUser) {
    await c.env.DB.prepare(`
      INSERT INTO organization_members (org_id, user_id, role, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(orgMember.org_id, registeredUser.id, role === 'viewer' ? 'viewer' : 'operator', now).run();

    return c.json({
      status: 'ok',
      message: `Пользователь ${cleanEmail} успешно подключён к пространству`
    });
  }

  // Иначе сохраняем приглашение — при первом входе через Google он подключится автоматически
  const inviteId = `inv_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
  await c.env.DB.prepare(`
    INSERT INTO invites (id, org_id, email, role, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(inviteId, orgMember.org_id, cleanEmail, role === 'viewer' ? 'viewer' : 'operator', now).run();

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

  const { user_id, email } = await c.req.json() as { user_id?: string; email?: string };

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

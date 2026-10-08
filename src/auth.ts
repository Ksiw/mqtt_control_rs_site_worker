import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Env, User } from './types';
import { safeAuthReturn } from './core/auth_return';

export const authRouter = new Hono<{ Bindings: Env }>();

/**
 * Инициация входа через Google OAuth 2.0
 * GET /auth/google
 */
authRouter.get('/google', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return c.text('Google OAuth не настроен (отсутствует GOOGLE_CLIENT_ID в настройках Worker)', 500);
  }

  // Определяем URL колбэка
  const origin = c.env.HUB_DOMAIN || `${new URL(c.req.url).origin}`;
  const redirectUri = `${origin}/auth/callback`;

  const nonce = crypto.randomUUID().replace(/-/g, '');
  const state = nonce;

  // Сохраняем state в cookie на 15 минут
  setCookie(c, 'oauth_state', state, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 900
  });
  const requestedReturn = c.req.query('return') || getCookie(c, 'dashboard_return') || '';
  const returnTo = safeAuthReturn(requestedReturn) || '/cabinet';
  setCookie(c, 'oauth_return', returnTo, {
    path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 900
  });

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  googleAuthUrl.searchParams.set('client_id', clientId);
  googleAuthUrl.searchParams.set('redirect_uri', redirectUri);
  googleAuthUrl.searchParams.set('response_type', 'code');
  googleAuthUrl.searchParams.set('scope', 'openid email profile');
  googleAuthUrl.searchParams.set('state', state);
  googleAuthUrl.searchParams.set('prompt', 'select_account');

  return c.redirect(googleAuthUrl.toString());
});

/**
 * Обработка ответа от Google после авторизации
 * GET /auth/callback
 */
authRouter.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const savedState = getCookie(c, 'oauth_state');

  if (!code || !state || !savedState || state !== savedState) {
    return c.text('Ошибка проверки безопасности OAuth (неверный параметр state)', 400);
  }

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.text('Ошибка конфигурации Google OAuth на сервере', 500);
  }

  const origin = c.env.HUB_DOMAIN || `${new URL(c.req.url).origin}`;
  const redirectUri = `${origin}/auth/callback`;

  // 1. Обмен кода авторизации на токен доступа Google
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!tokenResponse.ok) {
    return c.text('Не удалось получить токен доступа от Google', 400);
  }

  const tokenData = await tokenResponse.json() as { access_token: string; id_token: string };

  // 2. Получение данных профиля пользователя от Google
  const userinfoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!userinfoResponse.ok) {
    return c.text('Не удалось получить профиль пользователя от Google', 400);
  }

  const profile = await userinfoResponse.json() as {
    sub: string;
    email: string;
    email_verified: boolean;
    name?: string;
    picture?: string;
  };
  if (!profile.sub || !profile.email || profile.email_verified !== true) {
    return c.text('Адрес электронной почты Google не подтверждён', 403);
  }

  let sessionToken: string;
  try {
    sessionToken = await createUserSession(c.env.DB, { id: profile.sub, email: profile.email,
      name: profile.name, picture: profile.picture });
  } catch (error) {
    if (error instanceof AccountIdentityConflictError) {
      return c.text('Этот адрес уже связан с другим аккаунтом Google', 409);
    }
    throw error;
  }
  setCookie(c, 'session', sessionToken, {
    path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 30 * 86400
  });
  deleteCookie(c, 'oauth_state');
  const returnTo = getCookie(c, 'oauth_return') || '/cabinet';
  deleteCookie(c, 'oauth_return');
  deleteCookie(c, 'dashboard_return');
  return c.redirect(safeAuthReturn(returnTo) || '/cabinet');
});

export class AccountIdentityConflictError extends Error {}

export async function createUserSession(db: D1Database, profile: {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const email = profile.email.toLowerCase().trim();

  // 3. Сохранение или обновление пользователя в D1
  const existingUser = await db.prepare(
    'SELECT * FROM users WHERE google_id = ? LIMIT 1'
  ).bind(profile.id).first<User>();
  const emailOwner = await db.prepare(
    'SELECT id, google_id FROM users WHERE lower(email) = ? LIMIT 1'
  ).bind(email).first<{ id: string; google_id: string }>();
  if (emailOwner && emailOwner.google_id !== profile.id) {
    throw new AccountIdentityConflictError('Email belongs to another Google account');
  }

  let userId = existingUser?.id;

  if (!existingUser) {
    userId = `usr_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const orgId = `org_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const slugBase = email.split('@')[0].replace(/[^a-z0-9]/g, '') || 'user';
    const defaultSlug = `${slugBase}-${orgId.slice(4)}`;
    const wsId = `ws_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;

    // Создаём пользователя, его персональную организацию, подписку Free и базовое пространство
    await db.batch([
      db.prepare(`
        INSERT INTO users (id, google_id, email, name, avatar_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(userId, profile.id, email, profile.name || null, profile.picture || null, now, now),

      db.prepare(`
        INSERT INTO organizations (id, slug, name, owner_user_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(orgId, defaultSlug, `Организация ${profile.name || email}`, userId, now),

      db.prepare(`
        INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces, max_devices, max_dashboards, current_period_end, created_at)
        VALUES (?, ?, 'free', 'active', 1, 1, 10, 0, ?)
      `).bind(`sub_${crypto.randomUUID().substring(0, 8)}`, orgId, now),

      db.prepare(`
        INSERT INTO organization_members (org_id, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).bind(orgId, userId, now),

      db.prepare(`
        INSERT INTO workspaces (id, org_id, slug, name, description, created_at)
        VALUES (?, ?, 'main', 'Основное пространство', 'Автоматически созданное рабочее пространство', ?)
      `).bind(wsId, orgId, now)
    ]);
  } else {
    // Обновляем время входа
    await db.prepare(
      'UPDATE users SET email = ?, last_login_at = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?'
    ).bind(email, now, profile.name || null, profile.picture || null, userId).run();
  }

  // Проверяем, есть ли для этого email приглашения в семью / организацию
  const pendingInvites = await db.prepare(
    'SELECT * FROM invites WHERE lower(email) = lower(?)'
  ).bind(email).all<{ id: string; org_id: string; role: string }>();

  if (pendingInvites.results && pendingInvites.results.length > 0) {
    for (const inv of pendingInvites.results) {
      await db.prepare(`
        INSERT OR IGNORE INTO organization_members (org_id, user_id, role, created_at)
        VALUES (?, ?, ?, ?)
      `).bind(inv.org_id, userId, inv.role || 'operator', now).run();
      await db.prepare('DELETE FROM invites WHERE id = ?').bind(inv.id).run();
    }
  }

  // 4. Выпуск сессии пользователя (30 дней)
  const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  const expiresAt = now + (30 * 86400);

  await db.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionToken, userId, expiresAt, now).run();

  return sessionToken;
}

/**
 * Выход из аккаунта
 * GET /auth/logout
 */
authRouter.get('/logout', async (c) => {
  const sessionToken = getCookie(c, 'session');
  if (sessionToken) {
    await c.env.DB.prepare('DELETE FROM user_sessions WHERE token = ?').bind(sessionToken).run();
  }
  deleteCookie(c, 'session');
  return c.redirect('/cabinet');
});

authRouter.get('/desktop', async (c) => {
  const ticket = c.req.query('ticket') || '';
  if (!/^link_[a-f0-9]{64}$/.test(ticket)) return c.text('Недействительная ссылка входа', 400);
  const pairCode = c.req.query('pair');
  if (pairCode && !/^\d{3}-\d{3}$/.test(pairCode)) return c.text('Недействительный код привязки', 400);

  const now = Math.floor(Date.now() / 1000);
  const consumed = await c.env.DB.prepare(`
    DELETE FROM user_sessions
    WHERE token = ? AND expires_at > ?
    RETURNING user_id
  `).bind(ticket, now).first<{ user_id: string }>();
  if (!consumed) return c.text('Ссылка входа истекла или уже использована', 401);

  const previousSession = getCookie(c, 'session');
  if (previousSession) {
    await c.env.DB.prepare('DELETE FROM user_sessions WHERE token = ?').bind(previousSession).run();
  }
  const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  await c.env.DB.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionToken, consumed.user_id, now + 30 * 86400, now).run();
  setCookie(c, 'session', sessionToken, {
    path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: 30 * 86400
  });
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(pairCode ? `/cabinet?pair=${pairCode}` : '/cabinet');
});

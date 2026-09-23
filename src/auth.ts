import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Env, User } from './types';

export const authRouter = new Hono<{ Bindings: Env }>();

/**
 * Инициация входа через Google OAuth 2.0
 * GET /auth/google
 */
authRouter.get('/google', (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return c.text('Google OAuth не настроен (отсутствует GOOGLE_CLIENT_ID в настройках Worker)', 500);
  }

  // Определяем URL колбэка
  const origin = c.env.HUB_DOMAIN || `${new URL(c.req.url).origin}`;
  const redirectUri = `${origin}/auth/callback`;
  const state = crypto.randomUUID();

  // Сохраняем state в cookie на 10 минут для защиты от CSRF
  setCookie(c, 'oauth_state', state, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 600
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

  if (!code || !state || state !== savedState) {
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
  const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!userinfoResponse.ok) {
    return c.text('Не удалось получить профиль пользователя от Google', 400);
  }

  const profile = await userinfoResponse.json() as {
    id: string;
    email: string;
    name?: string;
    picture?: string;
  };

  const now = Math.floor(Date.now() / 1000);

  // 3. Сохранение или обновление пользователя в D1
  const existingUser = await c.env.DB.prepare(
    'SELECT * FROM users WHERE google_id = ? OR email = ? LIMIT 1'
  ).bind(profile.id, profile.email).first<User>();

  let userId = existingUser?.id;

  if (!existingUser) {
    userId = `usr_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const orgId = `org_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
    const defaultSlug = profile.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const wsId = `ws_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;

    // Создаём пользователя, его персональную организацию, подписку Free и базовое пространство
    await c.env.DB.batch([
      c.env.DB.prepare(`
        INSERT INTO users (id, google_id, email, name, avatar_url, created_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(userId, profile.id, profile.email, profile.name || null, profile.picture || null, now, now),

      c.env.DB.prepare(`
        INSERT INTO organizations (id, slug, name, owner_user_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(orgId, defaultSlug, `Организация ${profile.name || profile.email}`, userId, now),

      c.env.DB.prepare(`
        INSERT INTO subscriptions (id, org_id, plan_tier, status, max_workspaces, max_devices, max_dashboards, current_period_end, created_at)
        VALUES (?, ?, 'free', 'active', 2, 3, 5, ?, ?)
      `).bind(`sub_${crypto.randomUUID().substring(0, 8)}`, orgId, now + (365 * 86400), now),

      c.env.DB.prepare(`
        INSERT INTO organization_members (org_id, user_id, role, created_at)
        VALUES (?, ?, 'owner', ?)
      `).bind(orgId, userId, now),

      c.env.DB.prepare(`
        INSERT INTO workspaces (id, org_id, slug, name, description, created_at)
        VALUES (?, ?, 'main', 'Основное пространство', 'Автоматически созданное рабочее пространство', ?)
      `).bind(wsId, orgId, now)
    ]);
  } else {
    // Обновляем время входа
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = ?, name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?'
    ).bind(now, profile.name || null, profile.picture || null, userId).run();
  }

  // 4. Выпуск сессии пользователя (30 дней)
  const sessionToken = `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  const expiresAt = now + (30 * 86400);

  await c.env.DB.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(sessionToken, userId, expiresAt, now).run();

  // Устанавливаем защищённую cookie сессии
  setCookie(c, 'session', sessionToken, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 30 * 86400
  });

  deleteCookie(c, 'oauth_state');

  // Перенаправляем в личный кабинет
  return c.redirect('/cabinet');
});

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

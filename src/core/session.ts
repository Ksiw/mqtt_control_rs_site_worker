import { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { Env, User } from '../types';

/** Получение пользователя по действующей сессии. */
export async function getCurrentUser(c: Context<{ Bindings: Env }>): Promise<User | null> {
  const token = getCookie(c, 'session');
  if (!token?.startsWith('sess_')) return null;

  const now = Math.floor(Date.now() / 1000);
  return c.env.DB.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, now).first<User>();
}

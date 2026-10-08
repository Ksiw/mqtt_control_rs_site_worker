import { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { sha256Hex } from '../crypto';
import { Env } from '../types';

export const PANEL_ORIGIN = 'https://mqtt-control-rs-site-worker.stewhiki.workers.dev';
export const PANEL_COOKIE = 'dashboard_panel_';

type PanelContext = Context<{ Bindings: Env }>;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function issueDashboardTicket(c: PanelContext, userId: string,
  dashboardId: string): Promise<string> {
  const token = randomToken();
  const accountSession = getCookie(c, 'session');
  if (!accountSession) throw new Error('Dashboard ticket requires an account session');
  await c.env.DB.prepare(`
    INSERT INTO dashboard_access_tokens
      (token_hash, user_id, dashboard_id, account_session_token, kind, expires_at)
    VALUES (?, ?, ?, ?, 'ticket', ?)
  `).bind(await sha256Hex(token), userId, dashboardId, accountSession,
    Math.floor(Date.now() / 1000) + 60).run();
  return token;
}

export async function exchangeDashboardTicket(c: PanelContext, ticket: string): Promise<{
  token: string; dashboardId: string;
} | null> {
  if (!/^[a-f0-9]{64}$/.test(ticket)) return null;
  const now = Math.floor(Date.now() / 1000);
  const row = await c.env.DB.prepare(`
    DELETE FROM dashboard_access_tokens
    WHERE token_hash = ? AND kind = 'ticket' AND expires_at > ?
    RETURNING user_id, dashboard_id, account_session_token
  `).bind(await sha256Hex(ticket), now)
    .first<{ user_id: string; dashboard_id: string; account_session_token: string }>();
  if (!row) return null;
  const session = randomToken();
  await c.env.DB.prepare(`
    INSERT INTO dashboard_access_tokens
      (token_hash, user_id, dashboard_id, account_session_token, kind, expires_at)
    VALUES (?, ?, ?, ?, 'session', ?)
  `).bind(await sha256Hex(session), row.user_id, row.dashboard_id,
    row.account_session_token, now + 86400).run();
  return { token: session, dashboardId: row.dashboard_id };
}

export async function dashboardSession(c: PanelContext, dashboardId: string): Promise<{
  userId: string; dashboardId: string;
} | null> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(dashboardId)) return null;
  const token = getCookie(c, PANEL_COOKIE + dashboardId);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await c.env.DB.prepare(`
    SELECT t.user_id, t.dashboard_id FROM dashboard_access_tokens t
    JOIN user_sessions s ON s.token = t.account_session_token AND s.user_id = t.user_id
    WHERE t.token_hash = ? AND t.dashboard_id = ? AND t.kind = 'session'
      AND t.expires_at > ? AND s.expires_at > ?
  `).bind(await sha256Hex(token), dashboardId,
    Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000))
    .first<{ user_id: string; dashboard_id: string }>();
  return row ? { userId: row.user_id, dashboardId: row.dashboard_id } : null;
}

export function isPanelOrigin(c: PanelContext): boolean {
  if (new URL(c.req.url).origin !== PANEL_ORIGIN) return false;
  const forwardedHost = c.req.header('X-Forwarded-Host');
  const cabinetHost = new URL(c.env.HUB_DOMAIN || 'https://mqtt-control-rs.pages.dev').host;
  return forwardedHost !== cabinetHost;
}

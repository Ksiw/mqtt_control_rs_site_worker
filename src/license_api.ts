import { Hono } from 'hono';
import { Env, User } from './types';
import { createUserSession } from './auth';

export const licenseApiRouter = new Hono<{ Bindings: Env }>();

async function sessionUser(db: D1Database, token: string, now: number): Promise<User | null> {
  if (!token.startsWith('sess_')) return null;
  return db.prepare(`
    SELECT u.* FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?
  `).bind(token, now).first<User>();
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signLicense(
  secret: string | undefined,
  email: string,
  edition: string,
  expiresAt: number,
  issuedAt: number
): Promise<string> {
  if (!secret) throw new Error('License signing key is not configured');
  const key = await crypto.subtle.importKey(
    'jwk', JSON.parse(secret), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const payload = new TextEncoder().encode(JSON.stringify({
    email: email.toLowerCase().trim(), edition, expires_at: expiresAt, issued_at: issuedAt
  }));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, payload);
  return `${encodeBase64Url(payload)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

licenseApiRouter.post('/auth/google', async (c) => {
  const { id_token } = await c.req.json<{ id_token?: string }>().catch(() => ({ id_token: undefined }));
  if (!id_token || id_token.length > 8192) {
    return c.json({ error: 'Invalid Google token' }, 400);
  }

  const allowedAudiences = [c.env.GOOGLE_DESKTOP_CLIENT_ID, c.env.GOOGLE_CLIENT_ID].filter(Boolean);
  if (allowedAudiences.length === 0) {
    return c.json({ error: 'Google OAuth is not configured' }, 503);
  }

  const googleResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(id_token)}`);
  if (!googleResponse.ok) {
    return c.json({ error: 'Google token verification failed' }, 401);
  }
  const identity = await googleResponse.json() as {
    aud?: string; sub?: string; email?: string; email_verified?: string | boolean;
    name?: string; picture?: string;
  };
  if (!identity.aud || !allowedAudiences.includes(identity.aud) || !identity.sub ||
      !identity.email || !['true', true].includes(identity.email_verified as string | boolean)) {
    return c.json({ error: 'Google identity is not valid for this application' }, 401);
  }

  const sessionToken = await createUserSession(c.env.DB, {
    id: identity.sub, email: identity.email, name: identity.name, picture: identity.picture
  });
  return c.json({ session_token: sessionToken });
});

licenseApiRouter.get('/me', async (c) => {
  const authorization = c.req.header('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) return c.json({ error: 'Missing session' }, 401);

  const now = Math.floor(Date.now() / 1000);
  const user = await sessionUser(c.env.DB, token, now);
  if (!user) return c.json({ error: 'Session expired' }, 401);
  await c.env.DB.prepare('UPDATE user_sessions SET expires_at = ? WHERE token = ?')
    .bind(now + 30 * 86400, token).run();

  const subscriptions = await c.env.DB.prepare(`
    SELECT s.plan_tier, s.status, s.current_period_end
    FROM organizations o
    JOIN subscriptions s ON s.org_id = o.id
    WHERE o.owner_user_id = ?
  `).bind(user.id).all<{ plan_tier: string; status: string; current_period_end: number }>();

  const licenses = (subscriptions.results || []).map((subscription) => {
    const paid = subscription.plan_tier === 'pro' || subscription.plan_tier === 'enterprise';
    const active = paid && (subscription.status === 'active' || subscription.status === 'trialing') &&
      subscription.current_period_end > now;
    return {
      edition: subscription.plan_tier,
      status: active ? 'active' : 'expired',
      expires_at: subscription.current_period_end
    };
  });
  const active = licenses.filter((license) => license.status === 'active')
    .sort((a, b) => b.expires_at - a.expires_at);
  const selected = active.find((license) => license.edition === 'enterprise') ||
    active.find((license) => license.edition === 'pro');
  const license_proof = selected
    ? await signLicense(c.env.LICENSE_SIGNING_KEY, user.email, selected.edition, selected.expires_at, now)
    : null;
  return c.json({ email: user.email, licenses, license_proof });
});

licenseApiRouter.post('/auth/cabinet-link', async (c) => {
  const authorization = c.req.header('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const now = Math.floor(Date.now() / 1000);
  const user = await sessionUser(c.env.DB, token, now);
  if (!user) return c.json({ error: 'Session expired' }, 401);

  const ticket = `link_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  await c.env.DB.prepare(`
    INSERT INTO user_sessions (token, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).bind(ticket, user.id, now + 60, now).run();
  return c.json({ ticket });
});

import { Context } from 'hono';
import { Env } from '../types';

/**
 * Очищает заголовки перед отправкой в туннель Cloudflare.
 * Удаление cf-*, cdn-loop предотвращает ошибку Error 1033 (петля Cloudflare Edge).
 */
export function buildCleanHeaders(incoming: Headers, targetHost: string): Headers {
  const clean = new Headers();
  incoming.forEach((val, key) => {
    const k = key.toLowerCase();
    if (k === 'cookie') {
      const forwarded = val.split(';').map(part => part.trim()).filter(part => {
        const separator = part.indexOf('=');
        if (separator <= 0) return false;
        const name = part.slice(0, separator).trim();
        return name && !['session', 'oauth_state', 'oauth_return', 'dashboard_return', 'last_ws_id', 'last_dev_id', 'last_dash_id'].includes(name) &&
          !name.startsWith('op_token_') && !name.startsWith('operator_dev_') &&
          !name.startsWith('dashboard_panel_') && !name.startsWith('oauth_state_') &&
          !name.startsWith('oauth_return_');
      });
      if (forwarded.length > 0) clean.set('Cookie', forwarded.join('; '));
      return;
    }
    if (
      !k.startsWith('cf-') &&
      k !== 'cdn-loop' &&
      k !== 'host' &&
      k !== 'x-forwarded-for' &&
      k !== 'x-forwarded-proto' &&
      k !== 'x-forwarded-host'
    ) {
      clean.set(key, val);
    }
  });
  clean.set('Host', targetHost);
  return clean;
}

function setCookieValues(headers: Headers): string[] {
  const workerHeaders = headers as Headers & {
    getAll?: (name: string) => string[];
    getSetCookie?: () => string[];
  };
  if (workerHeaders.getAll) return workerHeaders.getAll('Set-Cookie');
  if (workerHeaders.getSetCookie) return workerHeaders.getSetCookie();
  const value = headers.get('Set-Cookie');
  return value ? [value] : [];
}

function isHubCookie(cookie: string): boolean {
  const name = cookie.slice(0, cookie.indexOf('=')).trim();
  return ['session', 'oauth_state', 'oauth_return', 'dashboard_return', 'last_ws_id', 'last_dev_id', 'last_dash_id'].includes(name) ||
    name.startsWith('op_token_') || name.startsWith('operator_dev_') ||
    name.startsWith('dashboard_panel_') || name.startsWith('oauth_state_') ||
    name.startsWith('oauth_return_');
}

export function storedOperatorToken(path: string): string | undefined {
  try {
    const url = new URL(path, 'https://tunnel.internal');
    const queryToken = url.searchParams.get('token');
    if (queryToken) return queryToken;
    const fragment = url.hash.slice(1);
    return fragment && !fragment.includes('=') ? decodeURIComponent(fragment) : undefined;
  } catch {
    return undefined;
  }
}

export function tunnelTarget(tunnelUrl: string, path: string): URL | null {
  try {
    const base = new URL(tunnelUrl);
    if (!['http:', 'https:'].includes(base.protocol) ||
        base.username || base.password || base.hash) return null;
    const target = new URL(path, base);
    return target.origin === base.origin ? target : null;
  } catch {
    return null;
  }
}

/** Сохраняет cookie хаба и не даёт устройству подменять их в ответе. */
export function proxyResponse(c: Context<{ Bindings: Env }>, upstream: Response): Response {
  const upstreamCookies = setCookieValues(upstream.headers);
  const hubCookies = setCookieValues(c.res.headers);
  const headers = new Headers(upstream.headers);

  if (upstreamCookies.length > 0 || hubCookies.length > 0) {
    headers.delete('Set-Cookie');
    for (const cookie of upstreamCookies) {
      if (!isHubCookie(cookie)) headers.append('Set-Cookie', cookie);
    }
    for (const cookie of hubCookies) headers.append('Set-Cookie', cookie);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    webSocket: upstream.webSocket,
  });
}

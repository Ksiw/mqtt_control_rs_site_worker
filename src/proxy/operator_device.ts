import { Env } from '../types';
import { tunnelTarget } from './shared';

interface OperatorDevice {
  id: string;
  tunnel_url: string | null;
  is_online: number;
}

export interface ActiveOperatorDevice {
  id: string;
  enterpriseMode: boolean;
}

async function modeFromResponse(response: Response): Promise<boolean | null> {
  if (response.status !== 200) return null;
  try {
    const body = await response.json() as { enterprise_mode?: unknown };
    return typeof body.enterprise_mode === 'boolean' ? body.enterprise_mode : null;
  } catch {
    return null;
  }
}

async function legacyModeFromResponse(response: Response): Promise<boolean | null> {
  if (response.status === 200) return false;
  if (response.status !== 401 && response.status !== 503) return null;
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    if (body.error !== 'auth_failed') return null;
    if (body.message === 'enterprise session is required' ||
        body.message === 'enterprise session is invalid or expired' ||
        body.message === 'enterprise authentication is temporarily unavailable') return true;
    if (body.message === 'operator web token is required' ||
        body.message === 'operator web token is invalid') return false;
  } catch {}
  return null;
}

async function probeMode(fetchPath: (path: string) => Promise<Response>): Promise<boolean | null> {
  const current = await fetchPath('/operator/mode');
  const mode = await modeFromResponse(current);
  if (mode !== null) return mode;
  if (current.status !== 404) return null;
  return legacyModeFromResponse(await fetchPath('/operator/view'));
}

async function probeDevice(env: Env, device: OperatorDevice): Promise<boolean | null> {
  if (env.TUNNEL_DO) {
    try {
      const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName(device.id));
      const mode = await probeMode((path) => stub.fetch(new Request(
        new URL(path, 'https://tunnel.internal').toString(),
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) },
      )));
      if (mode !== null) return mode;
    } catch {}
  }
  if (!device.tunnel_url || device.tunnel_url === 'direct_ws') return null;
  try {
    return await probeMode((path) => {
      const target = tunnelTarget(device.tunnel_url!, path);
      if (!target) throw new Error('Invalid tunnel URL');
      return fetch(target.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
    });
  } catch {
    return null;
  }
}

// Режим берётся только у устройства, которое действительно отвечает через туннель.
export async function selectOperatorDevice(
  env: Env, workspaceId: string, linkedDeviceId: string | null,
): Promise<ActiveOperatorDevice | null> {
  const devices = await env.DB.prepare(`
    SELECT id, tunnel_url, is_online FROM devices
    WHERE workspace_id = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END,
             is_online DESC, CASE WHEN role = 'primary' THEN 0 ELSE 1 END,
             priority DESC, last_heartbeat_at DESC
  `).bind(workspaceId, linkedDeviceId || '').all<OperatorDevice>();
  for (const device of devices.results || []) {
    const enterpriseMode = await probeDevice(env, device);
    if (enterpriseMode !== null) return { id: device.id, enterpriseMode };
  }
  return null;
}

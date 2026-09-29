// Определение типов данных для Cloudflare Worker

export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  HUB_DOMAIN: string;
  TUNNEL_DO: DurableObjectNamespace;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_DESKTOP_CLIENT_ID?: string;
  LICENSE_SIGNING_KEY?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  NOWPAYMENTS_API_KEY?: string;
  NOWPAYMENTS_IPN_SECRET?: string;
}

export interface User {
  id: string;
  google_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number;
}

export interface Organization {
  id: string;
  slug: string;
  name: string;
  owner_user_id: string;
  created_at: number;
}

export interface Subscription {
  id: string;
  org_id: string;
  plan_tier: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  max_workspaces: number;
  max_devices: number;
  max_dashboards: number;
  current_period_end: number;
  created_at: number;
}

export interface Workspace {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
}

export interface Device {
  id: string;
  workspace_id: string;
  name: string;
  role: 'primary' | 'standby';
  priority: number;
  key_hash: string;
  key_prefix: string;
  tunnel_url: string | null;
  tunnel_mode: 'quick' | 'custom_domain';
  routing_mode: 'proxy' | 'redirect';
  is_online: number;
  app_version: string | null;
  os_info: string | null;
  last_heartbeat_at: number | null;
  created_at: number;
}

export interface DashboardItem {
  id: string;
  name: string;
  path: string;
}

export interface HeartbeatPayload {
  workspace_id: string;
  tunnel_url: string;
  tunnel_status: string;
  device_role?: 'primary' | 'standby';
  app_version: string;
  os: string;
  dashboards: DashboardItem[];
  metrics?: {
    uptime_seconds?: number;
    connected_brokers?: number;
    active_pilots?: number;
    ram_used_mb?: number;
  };
}

/**
 * Возвращает актуальный лимит хост-программ для тарифного плана.
 * Для Free — 1.
 * Для Pro — строго 3.
 * Для Enterprise — задается вручную (по умолчанию 50, если не указано).
 */
export function getTierDeviceLimit(
  planTier: string | null | undefined,
  customMaxDevices?: number | null
): number {
  if (planTier === 'enterprise') {
    return (customMaxDevices && customMaxDevices > 0) ? customMaxDevices : 50;
  }
  if (planTier === 'pro') {
    return 3;
  }
  return 1;
}

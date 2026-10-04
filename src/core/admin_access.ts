import { User } from '../types';

/** Список супер-администраторов системы. */
export const SUPERADMIN_EMAILS = ['754marcus@gmail.com'];

export function isSuperAdmin(user: User | null, configuredGoogleId?: string): boolean {
  if (!user) return false;
  if (configuredGoogleId) return user.google_id === configuredGoogleId;
  if (!user.email) return false;
  return SUPERADMIN_EMAILS.includes(user.email.toLowerCase().trim());
}

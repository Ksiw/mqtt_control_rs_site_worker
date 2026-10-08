import { calculateNextPeriodEnd } from './calendar';

export interface PendingPayment {
  id: string;
  org_id: string;
  amount_usd: number;
  duration_days: number;
  invoice_id: string | null;
  provider_payment_id: string | null;
  payment_status: string;
  reconciliation_status: string;
  applied_at: number | null;
}

/** Один подтверждённый счёт продлевает подписку ровно один раз. */
export async function applyFinishedPayment(
  db: D1Database,
  payment: PendingPayment,
  providerPaymentId: string,
  payCurrency: string,
  now: number
): Promise<'applied' | 'already_applied' | 'retry'> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const subscription = await db.prepare(`
      SELECT id, plan_tier, status, current_period_end,
             last_payment_id, billing_anchor_day
      FROM subscriptions WHERE org_id = ? LIMIT 1
    `).bind(payment.org_id).first<{
      id: string;
      plan_tier: string;
      status: string;
      current_period_end: number;
      last_payment_id: string | null;
      billing_anchor_day: number | null;
    }>();
    if (!subscription) throw new Error('Subscription not found');

    const activePlan = subscription.status === 'active' || subscription.status === 'trialing'
      ? subscription.plan_tier : 'free';
    const continuing = activePlan === 'pro' && subscription.current_period_end > now;
    const baseTime = continuing ? subscription.current_period_end : now;
    const savedAnchor = subscription.billing_anchor_day;
    const anchorDay = continuing && typeof savedAnchor === 'number' &&
      Number.isInteger(savedAnchor) && savedAnchor >= 1 && savedAnchor <= 31
      ? savedAnchor : new Date(baseTime * 1000).getUTCDate();
    // Уже созданные месячные счета могут быть оплачены после смены тарифа.
    const months = payment.duration_days === 30 ? 1
      : payment.duration_days === 60 ? 2
      : payment.duration_days === 365 ? 12 : null;
    if (months === null) throw new Error('Unsupported payment duration');
    const nextEnd = calculateNextPeriodEnd(
      subscription.current_period_end, activePlan, months, now, anchorDay
    );

    // Пачка D1 атомарна. Второй запрос меняет платёж только если первый
    // действительно записал этот счёт в подписку.
    const results = await db.batch([
      db.prepare(`
        UPDATE subscriptions
        SET plan_tier = 'pro', status = 'active', max_devices = 3,
            max_dashboards = 50, current_period_end = ?,
            last_payment_id = ?, billing_anchor_day = ?
        WHERE id = ? AND current_period_end = ? AND plan_tier = ? AND status = ?
          AND last_payment_id IS ? AND billing_anchor_day IS ?
          AND EXISTS (SELECT 1 FROM payments WHERE id = ? AND applied_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM payment_refunds WHERE provider_payment_id = ?)
      `).bind(nextEnd, payment.id, anchorDay, subscription.id, subscription.current_period_end,
        subscription.plan_tier, subscription.status, subscription.last_payment_id,
        subscription.billing_anchor_day, payment.id, providerPaymentId),
      db.prepare(`
        UPDATE payments
        SET payment_status = 'finished', provider_payment_id = ?, pay_currency = ?,
            reconciliation_status = 'none', applied_at = ?, updated_at = ?
        WHERE id = ? AND applied_at IS NULL
          AND EXISTS (
            SELECT 1 FROM subscriptions
            WHERE id = ? AND last_payment_id = ?
          )
      `).bind(providerPaymentId, payCurrency, now, now, payment.id, subscription.id, payment.id)
    ]);

    if (results[1]?.meta.changes === 1) return 'applied';
    const current = await db.prepare('SELECT applied_at FROM payments WHERE id = ?')
      .bind(payment.id).first<{ applied_at: number | null }>();
    if (current?.applied_at != null) return 'already_applied';
  }
  return 'retry';
}

import { Hono } from 'hono';
import { Env } from './types';
import { getCurrentUser } from './core/session';
import { isSuperAdmin } from './core/admin_access';
import { getPlanPrices } from './core/pricing';
import { billingWebhookRouter } from './billing/webhook';

export const billingRouter = new Hono<{ Bindings: Env }>();

function validInvoiceUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'nowpayments.io' || url.hostname.endsWith('.nowpayments.io'));
  } catch {
    return false;
  }
}

/**
 * Инициация платежа и создание счета NOWPayments
 * POST /api/v1/billing/create-invoice
 */
billingRouter.post('/create-invoice', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ status: 'error', message: 'Некорректный запрос' }, 400);
  }
  const { duration, org_id } = body as {
    duration?: 'two_months' | 'year';
    org_id?: string;
  };
  if ((duration !== 'two_months' && duration !== 'year') ||
      (org_id !== undefined && typeof org_id !== 'string')) {
    return c.json({ status: 'error', message: 'Некорректный период подписки' }, 400);
  }

  let prices: { twoMonth: number; year: number };
  try {
    prices = await getPlanPrices(c.env.DB, true);
  } catch (error) {
    console.error('Unable to read subscription prices', error);
    return c.json({ status: 'error', message: 'Не удалось проверить стоимость подписки' }, 503);
  }
  const isYear = duration === 'year';
  const amountUsd = isYear ? prices.year : prices.twoMonth;
  const durationDays = isYear ? 365 : 60;
  const planDescription = isYear
    ? `MQTT Control RS Pro (1 год, $${amountUsd})`
    : `MQTT Control RS Pro (2 месяца, $${amountUsd})`;

  // Находим организацию пользователя (требуются права владельца или админа)
  const orgMembers = await c.env.DB.prepare(`
    SELECT o.id as org_id, o.name as org_name, m.role
    FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ? AND m.role IN ('owner', 'admin')
  `).bind(user.id).all<{ org_id: string; org_name: string; role: string }>();
  const eligibleOrgs = orgMembers.results || [];
  const orgMember = typeof org_id === 'string'
    ? eligibleOrgs.find(org => org.org_id === org_id)
    : eligibleOrgs.length === 1 ? eligibleOrgs[0] : undefined;

  if (!orgMember) {
    return c.json({
      status: 'error',
      message: 'Только владелец или администратор организации может оплачивать подписку'
    }, 403);
  }

  const apiKey = c.env.NOWPAYMENTS_API_KEY;
  if (!apiKey || !c.env.NOWPAYMENTS_IPN_SECRET) {
    return c.json({
      status: 'error',
      message: 'Платежный шлюз временно не настроен на сервере.'
    }, 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const paymentId = `pay_${crypto.randomUUID()}`;
  const orderId = `sub_${crypto.randomUUID()}`;
  let origin: string;
  try {
    const hub = new URL(c.env.HUB_DOMAIN);
    if (hub.protocol !== 'https:') throw new Error('HUB_DOMAIN must use HTTPS');
    origin = hub.origin;
  } catch {
    return c.json({ status: 'error', message: 'Адрес платёжного сервиса не настроен' }, 503);
  }

  let invoiceRecordCreated = false;
  try {
    await c.env.DB.prepare(`
      INSERT INTO payments (id, org_id, user_id, order_id, amount_usd, plan_tier,
                            duration_days, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pro', ?, 'creating', ?, ?)
    `).bind(paymentId, orgMember.org_id, user.id, orderId, amountUsd, durationDays, now, now).run();
    invoiceRecordCreated = true;

    const res = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        price_amount: amountUsd,
        price_currency: 'usd',
        order_id: orderId,
        order_description: planDescription,
        ipn_callback_url: `${origin}/api/v1/billing/webhook`,
        success_url: `${origin}/cabinet?payment=success`,
        cancel_url: `${origin}/cabinet?payment=cancel`
      })
    });

    if (!res.ok) {
      console.error('NOWPayments invoice error:', res.status);
      await c.env.DB.prepare("UPDATE payments SET payment_status = 'creation_failed', updated_at = ? WHERE id = ?")
        .bind(now, paymentId).run();
      return c.json({ status: 'error', message: 'Платёжная система не создала счёт' }, 502);
    }

    const data = (await res.json()) as {
      id: string | number;
      invoice_url: string;
      order_id: string;
    };
    if ((typeof data.id !== 'string' && typeof data.id !== 'number') ||
        !validInvoiceUrl(data.invoice_url) || data.order_id !== orderId) {
      throw new Error('Invalid NOWPayments invoice response');
    }

    const saved = await c.env.DB.prepare(`
      UPDATE payments SET invoice_id = ?, payment_status = 'waiting', updated_at = ?
      WHERE id = ? AND payment_status = 'creating'
    `).bind(String(data.id), now, paymentId).run();
    if (saved.meta.changes !== 1) throw new Error('Unable to save invoice');

    return c.json({
      status: 'ok',
      invoice_url: data.invoice_url,
      order_id: orderId
    });
  } catch (err) {
    console.error('NOWPayments invoice request failed:', err);
    if (invoiceRecordCreated) {
      try {
        await c.env.DB.prepare(`
          UPDATE payments SET payment_status = 'creation_failed', updated_at = ?
          WHERE id = ? AND payment_status = 'creating'
        `).bind(now, paymentId).run();
      } catch (updateError) {
        console.error('Unable to mark failed invoice creation', paymentId, updateError);
      }
    }
    return c.json({
      status: 'error',
      message: 'Не удалось создать счёт. Повторите попытку позже.'
    }, 503);
  }
});

billingRouter.route('/', billingWebhookRouter);

/**
 * История оплат организации
 * GET /api/v1/billing/history
 */
billingRouter.get('/history', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const orgs = await c.env.DB.prepare(`
    SELECT o.id FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ?
  `).bind(user.id).all<{ id: string }>();
  const requestedOrgId = c.req.query('org_id');
  const organizations = orgs.results || [];
  if (organizations.length === 0) return c.json({ status: 'ok', payments: [] });
  const org = requestedOrgId
    ? organizations.find(item => item.id === requestedOrgId)
    : organizations.length === 1 ? organizations[0] : undefined;

  if (!org) {
    return c.json({ status: 'error', message: 'Укажите доступную организацию' }, 400);
  }

  const list = await c.env.DB.prepare(`
    SELECT id, order_id, amount_usd, plan_tier, duration_days,
           payment_status, reconciliation_status, pay_currency, created_at, applied_at
    FROM payments
    WHERE org_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(org.id).all();

  return c.json({ status: 'ok', payments: list.results || [] });
});

/** Платежи, требующие сверки оператором. */
billingRouter.get('/reviews', async (c) => {
  const user = await getCurrentUser(c);
  if (!isSuperAdmin(user, c.env.SUPERADMIN_GOOGLE_ID)) {
    return c.json({ status: 'error', message: 'Доступ запрещён' }, 403);
  }

  const list = await c.env.DB.prepare(`
    SELECT id, org_id, order_id, invoice_id, provider_payment_id,
           amount_usd, payment_status, reconciliation_status, updated_at, applied_at
    FROM payments WHERE reconciliation_status <> 'none'
    ORDER BY updated_at DESC LIMIT 100
  `).all();
  return c.json({ status: 'ok', payments: list.results || [] });
});

import { Hono } from 'hono';
import { Env } from './types';
import { getCurrentUser } from './cabinet';
import { getPlanPrices } from './admin';
import { calculateNextPeriodEnd } from './calendar';

export const billingRouter = new Hono<{ Bindings: Env }>();

/**
 * Вычисление HMAC-SHA512 подписи для проверки вебхуков NOWPayments
 */
async function hmacSha512Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Сортировка ключей объекта для сверки подписи NOWPayments IPN
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
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

  const { duration } = (await c.req.json().catch(() => ({}))) as {
    duration?: 'month' | 'year';
  };

  const prices = await getPlanPrices(c.env.DB);
  const isYear = duration === 'year';
  const amountUsd = isYear ? prices.year : prices.month;
  const durationDays = isYear ? 365 : 30;
  const planDescription = isYear
    ? `MQTT Control RS Pro (1 год, $${amountUsd})`
    : `MQTT Control RS Pro (1 месяц, $${amountUsd})`;

  // Находим организацию пользователя (требуются права владельца или админа)
  const orgMember = await c.env.DB.prepare(`
    SELECT o.id as org_id, o.name as org_name, m.role
    FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ? AND m.role IN ('owner', 'admin')
    LIMIT 1
  `).bind(user.id).first<{ org_id: string; org_name: string; role: string }>();

  if (!orgMember) {
    return c.json({
      status: 'error',
      message: 'Только владелец или администратор организации может оплачивать подписку'
    }, 403);
  }

  const apiKey = c.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    return c.json({
      status: 'error',
      message: 'Платежный шлюз временно не настроен на сервере (отсутствует NOWPAYMENTS_API_KEY).'
    }, 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const paymentId = `pay_${crypto.randomUUID().replace(/-/g, '').substring(0, 12)}`;
  const orderId = `sub_${orgMember.org_id}_${isYear ? 'year' : 'month'}_${now}`;
  const origin = c.env.HUB_DOMAIN || new URL(c.req.url).origin;

  try {
    const res = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      },
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
      const errText = await res.text();
      console.error('NOWPayments invoice error:', res.status, errText);
      return c.json({
        status: 'error',
        message: `Ошибка платежной системы: ${errText}`
      }, 502);
    }

    const data = (await res.json()) as {
      id: string;
      invoice_url: string;
      order_id: string;
    };

    // Записываем предварительный счет в базу данных D1
    await c.env.DB.prepare(`
      INSERT INTO payments (id, org_id, user_id, order_id, invoice_id, amount_usd, plan_tier, duration_days, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pro', ?, 'waiting', ?, ?)
    `).bind(paymentId, orgMember.org_id, user.id, orderId, data.id || null, amountUsd, durationDays, now, now).run();

    return c.json({
      status: 'ok',
      invoice_url: data.invoice_url,
      order_id: orderId
    });
  } catch (err: any) {
    console.error('NOWPayments invoice request failed:', err);
    return c.json({
      status: 'error',
      message: `Сетевая ошибка обращения к платежному шлюзу: ${err?.message || err}`
    }, 500);
  }
});

/**
 * Обработка входящего уведомления об оплате (WebHook IPN) от NOWPayments
 * POST /api/v1/billing/webhook
 */
billingRouter.post('/webhook', async (c) => {
  const signature = c.req.header('x-nowpayments-sig');
  const bodyText = await c.req.text();

  let payload: any;
  try {
    payload = JSON.parse(bodyText);
  } catch (_) {
    return c.text('Invalid JSON', 400);
  }

  // Проверка криптографической подписи IPN, если задан секрет
  const ipnSecret = c.env.NOWPAYMENTS_IPN_SECRET;
  if (ipnSecret) {
    if (!signature) {
      console.warn('[Billing WebHook] Missing x-nowpayments-sig header');
      return c.text('Signature required', 401);
    }

    const sortedJson = JSON.stringify(sortObjectKeys(payload));
    const expectedSigSorted = await hmacSha512Hex(ipnSecret, sortedJson);
    const expectedSigRaw = await hmacSha512Hex(ipnSecret, bodyText);

    if (signature !== expectedSigSorted && signature !== expectedSigRaw) {
      console.warn('[Billing WebHook] Invalid signature');
      return c.text('Invalid signature', 403);
    }
  }

  const { payment_status, order_id, actually_paid, pay_currency, payment_id } = payload;
  console.log(`[Billing WebHook] Order ${order_id}, status: ${payment_status}, paid: ${actually_paid} ${pay_currency}`);

  if (!order_id) {
    return c.text('order_id missing', 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // Ищем платеж в нашей таблице
  const payment = await c.env.DB.prepare(
    'SELECT * FROM payments WHERE order_id = ? LIMIT 1'
  ).bind(order_id).first<{
    id: string;
    org_id: string;
    duration_days: number;
    payment_status: string;
  }>();

  // Обновляем статус платежа
  if (payment) {
    await c.env.DB.prepare(`
      UPDATE payments
      SET payment_status = ?, pay_currency = COALESCE(?, pay_currency), updated_at = ?
      WHERE id = ?
    `).bind(payment_status, pay_currency || null, now, payment.id).run();
  }

  // Если оплата успешно завершена (finished или confirmed в блокчейне)
  if (payment_status === 'finished' || payment_status === 'confirmed') {
    const orgId = payment?.org_id || order_id.split('_')[1];

    if (orgId) {
      const isYear = (payment?.duration_days ?? 0) >= 365 || order_id.includes('year');

      // Запрашиваем текущую подписку, чтобы сохранить календарное число и не сжечь остаток
      const currentSub = await c.env.DB.prepare(
        'SELECT plan_tier, current_period_end FROM subscriptions WHERE org_id = ?'
      ).bind(orgId).first<{ plan_tier: string; current_period_end: number }>();

      const targetPeriodEnd = calculateNextPeriodEnd(
        currentSub?.current_period_end,
        currentSub?.plan_tier,
        isYear,
        now
      );

      await c.env.DB.prepare(`
        UPDATE subscriptions
        SET plan_tier = 'pro',
            status = 'active',
            max_devices = 3,
            max_dashboards = 50,
            current_period_end = ?
        WHERE org_id = ?
      `).bind(targetPeriodEnd, orgId).run();

      console.log(`[Billing] Pro plan successfully activated/extended for org ${orgId} until ${targetPeriodEnd} (calendar sync, isYear=${isYear})`);
    }
  }

  return c.json({ status: 'ok' });
});

/**
 * История оплат организации
 * GET /api/v1/billing/history
 */
billingRouter.get('/history', async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ status: 'error', message: 'Требуется авторизация' }, 401);
  }

  const org = await c.env.DB.prepare(`
    SELECT o.id FROM organizations o
    JOIN organization_members m ON m.org_id = o.id
    WHERE m.user_id = ?
    LIMIT 1
  `).bind(user.id).first<{ id: string }>();

  if (!org) {
    return c.json({ status: 'ok', payments: [] });
  }

  const list = await c.env.DB.prepare(`
    SELECT id, order_id, amount_usd, plan_tier, duration_days, payment_status, pay_currency, created_at
    FROM payments
    WHERE org_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(org.id).all();

  return c.json({ status: 'ok', payments: list.results || [] });
});

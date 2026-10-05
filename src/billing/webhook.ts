import { Hono } from 'hono';
import { Env } from '../types';
import { applyFinishedPayment, PendingPayment } from '../billing_application';

export const billingWebhookRouter = new Hono<{ Bindings: Env }>();

/**
 * Вычисление HMAC-SHA512 подписи для проверки вебхуков NOWPayments
 */
async function verifyIpnSignature(secret: string, data: string, signature: string): Promise<boolean> {
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['verify']
  );
  const bytes = new Uint8Array(signature.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  return crypto.subtle.verify('HMAC', key, bytes, enc.encode(data));
}

/**
 * Сортировка ключей объекта для сверки подписи NOWPayments IPN
 */
function sortObjectKeys(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  const sorted: Record<string, any> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObjectKeys(obj[key]);
  }
  return sorted;
}

function positiveAmount(value: unknown): number | null {
  if (typeof value !== 'number' &&
      !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/**
 * Обработка входящего уведомления об оплате (WebHook IPN) от NOWPayments
 * POST /api/v1/billing/webhook
 */
billingWebhookRouter.post('/webhook', async (c) => {
  const signature = c.req.header('x-nowpayments-sig');
  const bodyText = await c.req.text();
  if (bodyText.length > 65536) return c.text('Payload too large', 413);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(bodyText);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.text('Invalid payload', 400);
    }
  } catch (_) {
    return c.text('Invalid JSON', 400);
  }

  // Без секрета нельзя установить отправителя уведомления об оплате.
  const ipnSecret = c.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) return c.text('Payment webhook is not configured', 503);
  if (!signature) return c.text('Signature required', 401);

  const sortedJson = JSON.stringify(sortObjectKeys(payload));
  if (!await verifyIpnSignature(ipnSecret, sortedJson, signature)) {
    console.warn('[Billing WebHook] Invalid signature');
    return c.text('Invalid signature', 403);
  }

  const { payment_status, order_id, invoice_id, payment_id,
    price_amount, price_currency, pay_amount, actually_paid, pay_currency } = payload;
  if (typeof order_id !== 'string' || !order_id || typeof payment_status !== 'string' ||
      (typeof payment_id !== 'string' && typeof payment_id !== 'number') ||
      !String(payment_id) ||
      (typeof invoice_id !== 'string' && typeof invoice_id !== 'number')) {
    return c.text('Incomplete payment notification', 400);
  }

  const now = Math.floor(Date.now() / 1000);

  // Ищем платеж в нашей таблице
  const payment = await c.env.DB.prepare(
    'SELECT * FROM payments WHERE order_id = ? LIMIT 1'
  ).bind(order_id).first<PendingPayment>();
  if (!payment) return c.text('Unknown order', 404);
  if (!payment.invoice_id) return c.text('Invoice is not ready', 503);

  const quotedAmount = positiveAmount(price_amount);
  const expectedCents = Math.round(payment.amount_usd * 100);
  if (String(invoice_id) !== payment.invoice_id ||
      price_currency !== 'usd' || quotedAmount === null ||
      Math.round(quotedAmount * 100) !== expectedCents) {
    await c.env.DB.prepare(`
      UPDATE payments SET reconciliation_status = 'identity_mismatch', updated_at = ?
      WHERE id = ? AND applied_at IS NULL
    `).bind(now, payment.id).run();
    console.error('NOWPayments notification does not match invoice', order_id);
    return c.json({ status: 'review_required' });
  }

  const providerId = String(payment_id);


  if (payment_status === 'refunded') {
    const otherApplied = await c.env.DB.prepare(`
      SELECT id FROM payments WHERE provider_payment_id = ? AND id <> ? LIMIT 1
    `).bind(providerId, payment.id).first<{ id: string }>();
    if (otherApplied) {
      await c.env.DB.prepare(`
        UPDATE payments SET reconciliation_status = 'duplicate_provider_payment', updated_at = ?
        WHERE id = ? AND applied_at IS NULL
      `).bind(now, payment.id).run();
      return c.json({ status: 'review_required' });
    }

    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO payment_refunds (provider_payment_id, payment_id, refunded_at)
      VALUES (?, ?, ?)
    `).bind(providerId, payment.id, now).run();
    const refund = await c.env.DB.prepare(`
      SELECT payment_id FROM payment_refunds WHERE provider_payment_id = ?
    `).bind(providerId).first<{ payment_id: string }>();
    if (refund?.payment_id !== payment.id) {
      await c.env.DB.prepare(`
        UPDATE payments SET reconciliation_status = 'duplicate_provider_payment', updated_at = ?
        WHERE id = ? AND applied_at IS NULL
      `).bind(now, payment.id).run();
      return c.json({ status: 'review_required' });
    }

    if (payment.applied_at !== null) {
      if (providerId !== payment.provider_payment_id) return c.json({ status: 'ok' });
      await c.env.DB.prepare(`
        UPDATE payments SET payment_status = 'refunded',
                            reconciliation_status = 'refund_review', updated_at = ?
        WHERE id = ?
      `).bind(now, payment.id).run();
      return c.json({ status: 'review_required' });
    }

    await c.env.DB.prepare(`
      UPDATE payments SET payment_status = 'refunded', updated_at = ?
      WHERE id = ? AND applied_at IS NULL
    `).bind(now, payment.id).run();
    return c.json({ status: 'ok' });
  }

  const refundedAttempt = await c.env.DB.prepare(`
    SELECT payment_id FROM payment_refunds WHERE provider_payment_id = ?
  `).bind(providerId).first<{ payment_id: string }>();
  if (refundedAttempt) {
    if (payment_status === 'finished') {
      await c.env.DB.prepare(`
        UPDATE payments SET reconciliation_status = ?, updated_at = ?
        WHERE id = ? AND applied_at IS NULL
      `).bind(refundedAttempt.payment_id === payment.id
        ? 'refund_review' : 'duplicate_provider_payment', now, payment.id).run();
    }
    return c.json({ status: payment_status === 'finished' ? 'review_required' : 'ok' });
  }

  if (payment.provider_payment_id !== null &&
      providerId !== payment.provider_payment_id) {
    if (payment_status !== 'finished') return c.json({ status: 'ok' });
    await c.env.DB.prepare(`
      UPDATE payments SET reconciliation_status = 'extra_payment', updated_at = ?
      WHERE id = ?
    `).bind(now, payment.id).run();
    console.error('NOWPayments invoice was paid more than once', order_id);
    return c.json({ status: 'review_required' });
  }

  if (payment.applied_at !== null) return c.json({ status: 'ok' });

  if (payment_status !== 'finished') {
    await c.env.DB.prepare(`
      UPDATE payments
      SET payment_status = ?, pay_currency = COALESCE(?, pay_currency), updated_at = ?
      WHERE id = ? AND applied_at IS NULL
    `).bind(payment_status, typeof pay_currency === 'string' ? pay_currency : null,
      now, payment.id).run();
    return c.json({ status: 'ok' });
  }

  const expectedCrypto = positiveAmount(pay_amount);
  const receivedCrypto = positiveAmount(actually_paid);
  if (expectedCrypto === null || receivedCrypto === null ||
      receivedCrypto + expectedCrypto * 1e-10 < expectedCrypto ||
      typeof pay_currency !== 'string' || !pay_currency) {
    await c.env.DB.prepare(`
      UPDATE payments SET payment_status = 'finished',
                          reconciliation_status = 'amount_mismatch', updated_at = ?
      WHERE id = ? AND applied_at IS NULL
    `).bind(now, payment.id).run();
    console.error('Finished NOWPayments payment is underpaid', order_id);
    return c.json({ status: 'review_required' });
  }

  const otherPayment = await c.env.DB.prepare(`
    SELECT id FROM payments WHERE provider_payment_id = ? AND id <> ? LIMIT 1
  `).bind(providerId, payment.id).first<{ id: string }>();
  if (otherPayment) {
    await c.env.DB.prepare(`
      UPDATE payments SET reconciliation_status = 'duplicate_provider_payment', updated_at = ?
      WHERE id = ? AND applied_at IS NULL
    `).bind(now, payment.id).run();
    console.error('NOWPayments payment ID belongs to another invoice', order_id);
    return c.json({ status: 'review_required' });
  }

  try {
    const result = await applyFinishedPayment(c.env.DB, payment, providerId, pay_currency, now);
    if (result === 'retry') return c.text('Payment application is busy', 503);
  } catch (error) {
    const used = await c.env.DB.prepare(`
      SELECT id FROM payments WHERE provider_payment_id = ? AND id <> ? LIMIT 1
    `).bind(providerId, payment.id).first<{ id: string }>();
    if (used) {
      await c.env.DB.prepare(`
        UPDATE payments SET reconciliation_status = 'duplicate_provider_payment', updated_at = ?
        WHERE id = ? AND applied_at IS NULL
      `).bind(now, payment.id).run();
      return c.json({ status: 'review_required' });
    }
    console.error('Unable to apply finished payment', order_id, error);
    return c.text('Payment application failed', 503);
  }

  return c.json({ status: 'ok' });
});

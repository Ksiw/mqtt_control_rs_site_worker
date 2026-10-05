import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const outputDir = await mkdtemp(join(tmpdir(), 'mcrs-billing-test-'));
after(() => rm(outputDir, { recursive: true, force: true }));
await build({
  entryPoints: {
    billing: 'src/billing.ts', calendar: 'src/calendar.ts',
    billing_application: 'src/billing_application.ts'
  }, outdir: outputDir,
  outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm'
});
const { billingRouter } = await import(join(outputDir, 'billing.mjs'));
const { calculateNextPeriodEnd } = await import(join(outputDir, 'calendar.mjs'));
const { applyFinishedPayment } = await import(join(outputDir, 'billing_application.mjs'));

test('monthly renewal keeps the original billing day after February', () => {
  const jan31 = Date.parse('2026-01-31T12:00:00Z') / 1000;
  const feb28 = calculateNextPeriodEnd(0, 'free', false, jan31);
  const mar31 = calculateNextPeriodEnd(feb28, 'pro', false, jan31 + 86400, 31);
  assert.equal(new Date(feb28 * 1000).toISOString(), '2026-02-28T12:00:00.000Z');
  assert.equal(new Date(mar31 * 1000).toISOString(), '2026-03-31T12:00:00.000Z');
});

test('payment application persists the original billing day', async () => {
  const { db } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  seedPayment(db, 'pay-2', 'order-2', '1002');
  const jan31 = Date.parse('2026-01-31T12:00:00Z') / 1000;
  const feb01 = Date.parse('2026-02-01T12:00:00Z') / 1000;
  const first = db.sqlite.prepare('SELECT * FROM payments WHERE id = ?').get('pay-1');
  const second = db.sqlite.prepare('SELECT * FROM payments WHERE id = ?').get('pay-2');
  assert.equal(await applyFinishedPayment(db, first, '9001', 'btc', jan31), 'applied');
  assert.equal(await applyFinishedPayment(db, second, '9002', 'btc', feb01), 'applied');
  const subscription = db.sqlite.prepare('SELECT current_period_end, billing_anchor_day FROM subscriptions WHERE id = ?')
    .get('sub-1');
  assert.equal(subscription.billing_anchor_day, 31);
  assert.equal(new Date(subscription.current_period_end * 1000).toISOString(),
    '2026-03-31T12:00:00.000Z');
});

test('billing migration applies after the existing schema', async () => {
  const db = new DatabaseSync(':memory:');
  for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    if (file === '0011_payment_refunds.sql') {
      db.prepare(`
        INSERT INTO users (id, google_id, email, created_at, last_login_at)
        VALUES ('user', 'google-user', 'user@example.org', 1, 1)
      `).run();
      db.prepare(`
        INSERT INTO organizations (id, slug, name, owner_user_id, created_at)
        VALUES ('org', 'organization', 'Organization', 'user', 1)
      `).run();
    }
    db.exec(await readFile(join('migrations', file), 'utf8'));
  }
  const subscriptionColumns = db.prepare('PRAGMA table_info(subscriptions)').all().map(row => row.name);
  const paymentColumns = db.prepare('PRAGMA table_info(payments)').all().map(row => row.name);
  assert.ok(subscriptionColumns.includes('last_payment_id'));
  assert.ok(subscriptionColumns.includes('billing_anchor_day'));
  assert.ok(paymentColumns.includes('provider_payment_id'));
  assert.ok(paymentColumns.includes('reconciliation_status'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'payment_refunds'").get());
});

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);
      CREATE TABLE user_sessions (token TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE organization_members (org_id TEXT, user_id TEXT, role TEXT);
      CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY, org_id TEXT, plan_tier TEXT, status TEXT,
        current_period_end INTEGER, max_devices INTEGER, max_dashboards INTEGER,
        last_payment_id TEXT, billing_anchor_day INTEGER
      );
      CREATE TABLE payments (
        id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, order_id TEXT UNIQUE,
        invoice_id TEXT, amount_usd REAL, plan_tier TEXT, duration_days INTEGER,
        payment_status TEXT, pay_currency TEXT, created_at INTEGER,
        updated_at INTEGER, applied_at INTEGER, provider_payment_id TEXT UNIQUE,
        reconciliation_status TEXT NOT NULL DEFAULT 'none'
      );
      CREATE TABLE payment_refunds (
        provider_payment_id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, refunded_at INTEGER NOT NULL
      );
    `);
  }

  prepare(sql) {
    const db = this.sqlite;
    const owner = this;
    const unbound = db.prepare(sql);
    return {
      first: async () => unbound.get() ?? null,
      all: async () => ({ results: unbound.all() }),
      run: async () => ({ meta: { changes: unbound.run().changes } }),
      bind(...params) {
        const stmt = db.prepare(sql);
        return {
          first: async () => {
            const row = stmt.get(...params) ?? null;
            if (sql.includes('FROM subscriptions WHERE org_id') && owner.subscriptionReadBarrier) {
              await owner.subscriptionReadBarrier();
            }
            return row;
          },
          all: async () => ({ results: stmt.all(...params) }),
          run: async () => ({ meta: { changes: stmt.run(...params).changes } }),
          runSync: () => ({ meta: { changes: stmt.run(...params).changes } })
        };
      }
    };
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(stmt => stmt.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const db = new TestD1();
  const now = Math.floor(Date.now() / 1000);
  db.sqlite.prepare('INSERT INTO users VALUES (?, ?)').run('user-1', 'test@example.org');
  db.sqlite.prepare('INSERT INTO user_sessions VALUES (?, ?, ?)').run('sess_test', 'user-1', now + 3600);
  db.sqlite.prepare('INSERT INTO organizations VALUES (?, ?)').run('org-1', 'First organization');
  db.sqlite.prepare('INSERT INTO organizations VALUES (?, ?)').run('org-2', 'Second organization');
  db.sqlite.prepare('INSERT INTO organization_members VALUES (?, ?, ?)').run('org-1', 'user-1', 'owner');
  db.sqlite.prepare('INSERT INTO organization_members VALUES (?, ?, ?)').run('org-2', 'user-1', 'owner');
  db.sqlite.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sub-1', 'org-1', 'free', 'active', 0, 1, 10, null, null);
  db.sqlite.prepare('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sub-2', 'org-2', 'free', 'active', 0, 1, 10, null, null);
  const env = {
    DB: db, NOWPAYMENTS_IPN_SECRET: 'ipn-test-secret',
    NOWPAYMENTS_API_KEY: 'api-test-key', HUB_DOMAIN: 'https://site.test'
  };
  return { db, env, now };
}

function seedPayment(db, id, orderId, invoiceId = '1001', orgId = 'org-1') {
  db.sqlite.prepare(`
    INSERT INTO payments (id, org_id, user_id, order_id, invoice_id, amount_usd,
                          plan_tier, duration_days, payment_status, created_at, updated_at)
    VALUES (?, ?, 'user-1', ?, ?, 12, 'pro', 30, 'waiting', 1, 1)
  `).run(id, orgId, orderId, invoiceId);
}

function signedRequest(env, payload) {
  const body = JSON.stringify(payload);
  const sorted = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0)));
  const signature = createHmac('sha512', env.NOWPAYMENTS_IPN_SECRET).update(sorted).digest('hex');
  return billingRouter.request('https://site.test/webhook', {
    method: 'POST', body, headers: { 'x-nowpayments-sig': signature }
  }, env);
}

function notification(orderId, invoiceId, paymentId, overrides = {}) {
  return {
    actually_paid: 12, invoice_id: invoiceId, order_id: orderId,
    pay_amount: 12, pay_currency: 'usdttrc20', payment_id: paymentId,
    payment_status: 'finished', price_amount: 12, price_currency: 'usd',
    ...overrides
  };
}

function subscriptionEnd(db, orgId = 'org-1') {
  return db.sqlite.prepare('SELECT current_period_end FROM subscriptions WHERE org_id = ?')
    .get(orgId).current_period_end;
}

test('only matching, fully paid, finished invoice grants Pro once', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  const base = notification('order-1', '1001', 9001);

  assert.equal((await signedRequest(env, { ...base, payment_status: 'confirmed' })).status, 200);
  assert.equal(subscriptionEnd(db), 0);
  assert.equal((await signedRequest(env, { ...base, invoice_id: 'wrong' })).status, 200);
  assert.equal((await signedRequest(env, { ...base, price_amount: 1 })).status, 200);
  assert.equal((await signedRequest(env, { ...base, price_currency: 'eur' })).status, 200);
  assert.equal((await signedRequest(env, { ...base, actually_paid: 1 })).status, 200);
  assert.equal((await signedRequest(env, { ...base, payment_id: undefined })).status, 400);
  assert.equal(subscriptionEnd(db), 0);
  assert.equal((await signedRequest(env, base)).status, 200);
  const end = subscriptionEnd(db);
  assert.ok(end > 0);
  assert.equal((await signedRequest(env, base)).status, 200);
  assert.equal(subscriptionEnd(db), end);
  assert.equal(db.sqlite.prepare('SELECT provider_payment_id FROM payments WHERE id = ?')
    .get('pay-1').provider_payment_id, '9001');
});

test('parallel notifications for different invoices preserve both paid periods', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1', '1001');
  seedPayment(db, 'pay-2', 'order-2', '1002');
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  db.subscriptionReadBarrier = async () => {
    if (++reads === 2) release();
    if (reads <= 2) await bothRead;
  };

  const replies = await Promise.all([
    signedRequest(env, notification('order-1', '1001', 9001)),
    signedRequest(env, notification('order-2', '1002', 9002))
  ]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM payments WHERE applied_at IS NOT NULL')
    .get().count, 2);
  const end = subscriptionEnd(db);
  const firstMonth = new Date();
  firstMonth.setUTCMonth(firstMonth.getUTCMonth() + 1);
  assert.ok(end > Math.floor(firstMonth.getTime() / 1000));
});

test('parallel retries for one invoice extend the subscription only once', async () => {
  const { db, env, now } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  db.subscriptionReadBarrier = async () => {
    if (++reads === 2) release();
    if (reads <= 2) await bothRead;
  };
  const ipn = notification('order-1', '1001', 9001);
  const responses = await Promise.all([signedRequest(env, ipn), signedRequest(env, ipn)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM payments WHERE applied_at IS NOT NULL')
    .get().count, 1);
  assert.ok(subscriptionEnd(db) > now);
  assert.ok(subscriptionEnd(db) < now + 45 * 86400);
});

test('one provider payment cannot activate two invoices', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1', '1001');
  seedPayment(db, 'pay-2', 'order-2', '1002');
  assert.equal((await signedRequest(env, notification('order-1', '1001', 9001))).status, 200);
  const end = subscriptionEnd(db);
  assert.equal((await signedRequest(env, notification('order-2', '1002', 9001))).status, 200);
  assert.equal(subscriptionEnd(db), end);
  assert.equal(db.sqlite.prepare('SELECT applied_at FROM payments WHERE id = ?').get('pay-2').applied_at, null);
});

test('late finished notification cannot reactivate a refunded invoice', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  const finished = notification('order-1', '1001', 9001);
  assert.equal((await signedRequest(env, { ...finished, payment_status: 'refunded' })).status, 200);
  assert.equal((await signedRequest(env, finished)).status, 200);
  assert.equal(subscriptionEnd(db), 0);
  assert.equal(db.sqlite.prepare('SELECT payment_status FROM payments WHERE id = ?')
    .get('pay-1').payment_status, 'refunded');
  assert.equal(db.sqlite.prepare('SELECT provider_payment_id FROM payment_refunds').get()
    .provider_payment_id, '9001');
});

test('refund of one payment does not block a new payment on the same invoice', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  const first = notification('order-1', '1001', 9001);
  assert.equal((await signedRequest(env, { ...first, payment_status: 'refunded' })).status, 200);
  assert.equal(subscriptionEnd(db), 0);
  assert.equal((await signedRequest(env, notification('order-1', '1001', 9002))).status, 200);
  assert.ok(subscriptionEnd(db) > 0);
  assert.equal(db.sqlite.prepare('SELECT provider_payment_id FROM payments WHERE id = ?')
    .get('pay-1').provider_payment_id, '9002');
});

test('out-of-order notifications: refund before finished does not grant subscription and flags for review', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  const refund = { ...notification('order-1', '1001', 9001), payment_status: 'refunded' };
  assert.equal((await signedRequest(env, refund)).status, 200);
  assert.equal(subscriptionEnd(db), 0);
  const afterRefund = db.sqlite.prepare('SELECT payment_status, reconciliation_status FROM payments WHERE id = ?').get('pay-1');
  assert.equal(afterRefund.payment_status, 'refunded');

  const finished = notification('order-1', '1001', 9001);
  const response = await signedRequest(env, finished);
  assert.deepEqual(await response.json(), { status: 'review_required' });
  assert.equal(subscriptionEnd(db), 0);
  const afterFinished = db.sqlite.prepare('SELECT reconciliation_status FROM payments WHERE id = ?').get('pay-1');
  assert.equal(afterFinished.reconciliation_status, 'refund_review');
});

test('refund of another provider payment cannot change an applied invoice', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  const finished = notification('order-1', '1001', 9001);
  assert.equal((await signedRequest(env, finished)).status, 200);
  const end = subscriptionEnd(db);
  const refund = { ...finished, payment_status: 'refunded', payment_id: 9002 };
  assert.equal((await signedRequest(env, refund)).status, 200);
  assert.equal(subscriptionEnd(db), end);
  const payment = db.sqlite.prepare('SELECT payment_status, reconciliation_status FROM payments WHERE id = ?')
    .get('pay-1');
  assert.equal(payment.payment_status, 'finished');
  assert.equal(payment.reconciliation_status, 'none');
  assert.equal((await signedRequest(env, { ...finished, payment_status: 'refunded' })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT payment_status, reconciliation_status FROM payments WHERE id = ?')
    .get('pay-1').reconciliation_status, 'refund_review');
});

test('refund callback cannot claim the provider ID of another invoice', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1', '1001');
  seedPayment(db, 'pay-2', 'order-2', '1002');
  const first = notification('order-1', '1001', 9001);
  assert.equal((await signedRequest(env, first)).status, 200);
  assert.equal((await signedRequest(env, {
    ...notification('order-2', '1002', 9001), payment_status: 'refunded'
  })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM payment_refunds').get().count, 0);
  assert.equal((await signedRequest(env, { ...first, payment_status: 'refunded' })).status, 200);
  assert.equal(db.sqlite.prepare('SELECT payment_id FROM payment_refunds').get().payment_id, 'pay-1');
});

test('second completed payment of one invoice is recorded for review', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  assert.equal((await signedRequest(env, notification('order-1', '1001', 9001))).status, 200);
  const end = subscriptionEnd(db);
  const response = await signedRequest(env, notification('order-1', '1001', 9002));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'review_required' });
  assert.equal(subscriptionEnd(db), end);
  assert.equal(db.sqlite.prepare('SELECT reconciliation_status FROM payments').get()
    .reconciliation_status, 'extra_payment');
});

test('early callback waits until the invoice ID is stored', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  db.sqlite.prepare("UPDATE payments SET invoice_id = NULL, payment_status = 'creating' WHERE id = ?")
    .run('pay-1');
  const ipn = notification('order-1', '1001', 9001);
  assert.equal((await signedRequest(env, ipn)).status, 503);
  assert.equal(subscriptionEnd(db), 0);
  assert.equal(db.sqlite.prepare('SELECT reconciliation_status FROM payments').get()
    .reconciliation_status, 'none');
  db.sqlite.prepare("UPDATE payments SET invoice_id = ?, payment_status = 'waiting' WHERE id = ?")
    .run('1001', 'pay-1');
  assert.equal((await signedRequest(env, ipn)).status, 200);
  assert.ok(subscriptionEnd(db) > 0);
});

test('invoice creation targets the displayed organization and uses unique order IDs', async () => {
  const { db, env } = fixture();
  const originalFetch = globalThis.fetch;
  let invoice = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    invoice++;
    return new Response(JSON.stringify({
      id: invoice, order_id: request.order_id,
      invoice_url: `https://nowpayments.io/payment/?iid=${invoice}`
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const create = () => billingRouter.request('https://site.test/create-invoice', {
      method: 'POST', headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'month', org_id: 'org-2' })
    }, env);
    const responses = await Promise.all([create(), create()]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    const orders = (await Promise.all(responses.map(response => response.json())))
      .map(response => response.order_id);
    assert.equal(new Set(orders).size, 2);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM payments WHERE org_id = ?')
      .get('org-2').count, 2);
    assert.equal((await billingRouter.request('https://site.test/create-invoice', {
      method: 'POST', headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'month' })
    }, env)).status, 403);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('invalid configured price blocks invoice creation', async () => {
  const { db, env } = fixture();
  db.sqlite.prepare('INSERT INTO system_settings VALUES (?, ?)')
    .run('price_month_usd', 'Infinity');
  const originalFetch = globalThis.fetch;
  let providerCalled = false;
  globalThis.fetch = async () => { providerCalled = true; throw new Error('unexpected provider call'); };
  try {
    const response = await billingRouter.request('https://site.test/create-invoice', {
      method: 'POST', headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'month', org_id: 'org-1' })
    }, env);
    assert.equal(response.status, 503);
    assert.equal(providerCalled, false);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM payments').get().count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('provider failure is recorded without leaking its response to the customer', async () => {
  const { db, env } = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('provider internal detail', { status: 500 });
  try {
    const response = await billingRouter.request('https://site.test/create-invoice', {
      method: 'POST', headers: { Cookie: 'session=sess_test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 'month', org_id: 'org-1' })
    }, env);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('provider internal detail'));
    assert.equal(db.sqlite.prepare('SELECT payment_status FROM payments').get().payment_status,
      'creation_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('history requires explicit organization when a user belongs to several', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1', '1001', 'org-1');
  seedPayment(db, 'pay-2', 'order-2', '1002', 'org-2');
  const headers = { Cookie: 'session=sess_test' };
  assert.equal((await billingRouter.request('https://site.test/history', { headers }, env)).status, 400);
  const response = await billingRouter.request('https://site.test/history?org_id=org-2', { headers }, env);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.deepEqual(history.payments.map(payment => payment.id), ['pay-2']);
});

test('payment review queue is visible only to a super administrator', async () => {
  const { db, env } = fixture();
  seedPayment(db, 'pay-1', 'order-1');
  db.sqlite.prepare("UPDATE payments SET reconciliation_status = 'amount_mismatch' WHERE id = ?")
    .run('pay-1');
  const request = () => billingRouter.request('https://site.test/reviews', {
    headers: { Cookie: 'session=sess_test' }
  }, env);
  assert.equal((await request()).status, 403);
  db.sqlite.prepare('UPDATE users SET email = ? WHERE id = ?')
    .run('754marcus@gmail.com', 'user-1');
  const response = await request();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).payments.map(payment => payment.id), ['pay-1']);
});

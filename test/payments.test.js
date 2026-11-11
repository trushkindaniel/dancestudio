'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../server/config');
const { createYooKassa, paymentBody } = require('../server/payments');
const { createApp } = require('../server/app');
const { makeEnv, valid, NOW } = require('./helpers');

const online = () => makeEnv({ PAYMENT_PROVIDER: 'fake', HOLD_MINUTES: '30' });

test('config: yookassa без ключей и fake в production не запускаются', () => {
  assert.throws(() => buildConfig({ PAYMENT_PROVIDER: 'yookassa' }), /YOOKASSA_SHOP_ID/);
  assert.throws(() => buildConfig({ PAYMENT_PROVIDER: 'fake', NODE_ENV: 'production' }), /production/);
  assert.equal(buildConfig({ YOOKASSA_SHOP_ID: '1', YOOKASSA_SECRET_KEY: 'k' }).payment.provider, 'yookassa');
  assert.equal(buildConfig({}).payment.provider, 'fake');
});

test('тело платежа: сумма строкой с копейками, автосписание, виджет (embedded), чек по флагу', () => {
  const b = { code: 'AB23', total: 2400, date: '2026-11-13', hours: '18-19', hoursCount: 2, email: 'a@b.ru',
    dateLabel: 'пятница, 13 ноября', timeLabel: '18:00–20:00' };
  const plain = paymentBody(buildConfig({}), b);
  assert.deepEqual(plain.amount, { value: '2400.00', currency: 'RUB' });
  assert.equal(plain.capture, true);
  assert.deepEqual(plain.confirmation, { type: 'embedded' });
  assert.equal(plain.metadata.code, 'AB23');
  assert.ok(plain.description.length <= 128);
  assert.equal(plain.receipt, undefined);

  const withReceipt = paymentBody(buildConfig({ YOOKASSA_RECEIPT: '1', YOOKASSA_VAT_CODE: '1' }), b);
  assert.equal(withReceipt.receipt.customer.email, 'a@b.ru');
  assert.equal(withReceipt.receipt.items[0].vat_code, 1);
  assert.equal(withReceipt.receipt.items[0].amount.value, '2400.00');
  assert.equal(withReceipt.receipt.items[0].payment_subject, 'service');
});

test('клиент ЮKassa: Basic-авторизация, ключ идемпотентности, адреса API', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, ...opts });
    const body = url.endsWith('/refunds')
      ? { id: 'r1', status: 'succeeded' }
      : { id: '2a0b1c2d-000f-5000-9000-1a2b3c4d5e6f', status: 'pending', amount: { value: '2400.00' }, metadata: { code: 'AB23' }, confirmation: { type: 'embedded', confirmation_token: 'ct-2a0b1c2d-000f-5000-9000-1a2b3c4d5e6f' } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const yk = createYooKassa(buildConfig({ YOOKASSA_SHOP_ID: '123', YOOKASSA_SECRET_KEY: 'test_secret' }), { fetch: fakeFetch });

  const p = await yk.createPayment({ code: 'AB23', total: 2400, date: '2026-11-13', hours: '18-19', hoursCount: 2, email: 'a@b.ru', dateLabel: 'x', timeLabel: 'y', idempotenceKey: 'pay-AB23-1' });
  assert.equal(p.confirmationToken, 'ct-2a0b1c2d-000f-5000-9000-1a2b3c4d5e6f');
  assert.equal(JSON.parse(calls[0].body).confirmation.type, 'embedded');
  assert.equal(calls[0].url, 'https://api.yookassa.ru/v3/payments');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Basic ' + Buffer.from('123:test_secret').toString('base64'));
  assert.equal(calls[0].headers['Idempotence-Key'], 'pay-AB23-1');

  await yk.getPayment(p.id);
  assert.equal(calls[1].url, `https://api.yookassa.ru/v3/payments/${p.id}`);
  await assert.rejects(yk.getPayment('../../refunds'), /Некорректный/);

  await yk.refund(p.id, 2400, 'причина');
  assert.equal(calls[2].url, 'https://api.yookassa.ru/v3/refunds');
  assert.equal(calls[2].headers['Idempotence-Key'], `refund-${p.id}`);
  assert.equal(JSON.parse(calls[2].body).amount.value, '2400.00');
});

test('онлайн-бронь: токен для виджета вместо реквизитов, платёж привязан к событию', async () => {
  const { booking, calendar } = online();
  const r = await booking.book(valid());
  assert.equal(r.payment.provider, 'fake');
  assert.match(r.payment.confirmationToken, /^fake-/);
  assert.equal(r.requisites, undefined);
  const ev = await calendar.findByCode(r.code);
  assert.equal(ev.private.pay, 'fake');
  assert.match(ev.private.paymentId, /^fake-/);
  assert.equal(new Date(r.deadline) - NOW, 30 * 60000);
});

test('успешная оплата подтверждает бронь один раз, даже если сигнал пришёл дважды', async () => {
  const { booking, calendar, payments, sent, cfg } = online();
  const r = await booking.book(valid());
  const ev = await calendar.findByCode(r.code);
  payments._set(ev.private.paymentId, 'succeeded');

  assert.equal(await booking.syncPayment(ev.private.paymentId), 'paid');
  assert.equal(await booking.syncPayment(ev.private.paymentId), 'paid');
  const after = await calendar.findByCode(r.code);
  assert.equal(after.private.status, 'paid');
  assert.equal(after.colorId, cfg.paidColorId);
  assert.match(after.summary, /^✅/);
  assert.equal(sent.filter((x) => x[0] === 'paid').length, 1);
  assert.deepEqual(await booking.status(r.code, r.token), { status: 'paid', code: r.code, total: 2000, dateLabel: 'пятница, 13 ноября', timeLabel: '18:00–20:00', deadline: r.deadline });
});

test('отменённый платёж освобождает слот', async () => {
  const { booking, calendar, payments, sent } = online();
  const r = await booking.book(valid());
  const ev = await calendar.findByCode(r.code);
  payments._set(ev.private.paymentId, 'canceled');
  assert.equal(await booking.syncPayment(ev.private.paymentId), 'released');
  assert.equal(await calendar.findByCode(r.code), null);
  assert.equal(sent.find((x) => x[0] === 'expired')[1].reason, 'payment_canceled');
  assert.deepEqual(await booking.status(r.code, r.token), { status: 'gone' });
});

test('оплата пришла после снятия брони: автоматический возврат', async () => {
  const { booking, calendar, payments, clock, sent } = online();
  const r = await booking.book(valid());
  const pid = (await calendar.findByCode(r.code)).private.paymentId;

  clock.now = new Date(NOW.getTime() + 31 * 60000);
  const s = await booking.sweep();
  assert.equal(s.expired, 1);
  assert.equal(await calendar.findByCode(r.code), null);

  payments._set(pid, 'succeeded');
  assert.equal(await booking.syncPayment(pid), 'refunded');
  assert.deepEqual(payments._refunds.map((x) => [x.id, x.amount]), [[pid, 2000]]);
  assert.equal(sent.filter((x) => x[0] === 'refunded').length, 1);
});

test('фоновая проверка подтверждает оплату, если уведомление ЮKassa потерялось', async () => {
  const { booking, calendar, payments } = online();
  const r = await booking.book(valid());
  payments._set((await calendar.findByCode(r.code)).private.paymentId, 'succeeded');
  const s = await booking.sweep();
  assert.equal(s.paid, 1);
  assert.equal((await calendar.findByCode(r.code)).private.status, 'paid');
});

test('ЮKassa недоступна: 502, слот не остаётся занятым', async () => {
  const env = online();
  env.payments.createPayment = async () => { throw new Error('timeout'); };
  await assert.rejects(env.booking.book(valid()), (e) => e.status === 502);
  assert.equal(env.calendar._size(), 0);
});

test('HTTP: уведомление ЮKassa, статус брони, имитация оплаты в виджете', async () => {
  const env = online();
  const server = createApp({ ...env, now: () => NOW, log: { error() {}, log() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    const r = await (await post('/api/book', valid())).json();
    const pid = (await env.calendar.findByCode(r.code)).private.paymentId;

    // мусорное уведомление не трогает брони
    const junk = await (await post('/api/payments/yookassa', { object: { id: '<script>' } })).json();
    assert.equal(junk.ignored, true);

    // уведомление с настоящим id: статус всё равно спрашиваем у платёжки, а там ещё pending
    assert.equal((await (await post('/api/payments/yookassa', { event: 'payment.succeeded', object: { id: pid } })).json()).result, 'waiting');
    assert.equal((await (await fetch(`${base}/api/book/${r.code}?token=${r.token}`)).json()).status, 'pending');
    assert.equal((await (await fetch(`${base}/api/book/${r.code}?token=${'0'.repeat(24)}`)).json()).status, 'gone');

    const pay = await post(`/api/dev/pay/${r.payment.confirmationToken}?result=succeeded`, {});
    assert.equal(pay.status, 200);
    assert.equal((await pay.json()).result, 'paid');
    assert.equal((await (await fetch(`${base}/api/book/${r.code}?token=${r.token}`)).json()).status, 'paid');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

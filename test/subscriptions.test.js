'use strict';
/* Постоянная бронь «каждую неделю»: оформление, первая оплата с сохранением карты, автосписание,
   отказ банка, пауза, продление, отмена. Календарь в памяти, ЮKassa — имитация, часы управляемые. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../server/config');
const { createMemoryCalendar } = require('../server/calendar/memory');
const { createBookingService } = require('../server/booking');
const { createFakePayments } = require('../server/payments');
const { createJsonStore } = require('../server/store');
const { createSubscriptionService } = require('../server/subscriptions');
const T = require('../server/time');

const NOW = new Date('2026-11-09T07:00:00Z'); // понедельник, 10:00 МСК
const H = 3600000;

function env(extra = {}) {
  const cfg = buildConfig({
    CALENDAR_DRIVER: 'memory', PAYMENT_PROVIDER: 'fake', STUDIO_TZ: 'Europe/Moscow', SLOT_HOURS: '1', SUBSCRIPTIONS: '1', BASE_URL: 'https://site.test', ...extra,
  });
  const clock = { now: NOW };
  const now = () => clock.now;
  const calendar = createMemoryCalendar();
  const payments = createFakePayments(cfg);
  const sent = [];
  const notify = Object.fromEntries(['created', 'paid', 'expired', 'cancelled', 'refunded'].map((k) => [k, async (b) => sent.push([k, b])]));
  notify.subscription = async (kind, s) => sent.push(['sub:' + kind, s]);
  const log = { error() {}, log() {} };
  const booking = createBookingService({ calendar, cfg, notify, payments, now, log, releaseTimers: false });
  const store = createJsonStore(null);
  const subs = createSubscriptionService({ calendar, cfg, notify, payments, booking, store, now, log });
  booking.setSubscriptions(subs, subs.hooks);
  return { cfg, clock, calendar, payments, sent, booking, store, subs };
}

const form = (over = {}) => ({
  ranges: [{ date: '2026-11-11', hours: [12] }], recurring: true, autopayConsent: true,
  name: 'Ирина', phone: '+7 900 123-45-67', email: 'irina@example.com', note: '', consent: true, pdConsent: true, website: '', ...over,
});
const at = (date, hour) => T.zonedToUtc(date, hour, 'Europe/Moscow');
const kinds = (sent) => sent.map((x) => x[0]);

async function startActive(e) {
  const r = await e.booking.book(form());
  const [ev] = await e.calendar.findAllByCode(r.code);
  e.payments._set(ev.private.paymentId, 'succeeded');
  await e.booking.syncPayment(ev.private.paymentId);
  return { r, sub: e.store.get(r.subscription.id) };
}

test('оформление: первая неделя ждёт оплаты, следующие 7 закреплены 🔁 и заняты для других', async () => {
  const e = env();
  const r = await e.booking.book(form());
  assert.equal(r.subscription.weeks, 8);
  assert.match(r.subscription.schedule, /каждую среду 12:00–13:00/);
  assert.ok(r.payment.confirmationToken);
  const sub = e.store.get(r.subscription.id);
  assert.equal(sub.status, 'pending');
  assert.equal(sub.weeks.length, 8);
  assert.equal(sub.weeks.filter((w) => w.status === 'reserved').length, 7);
  // первая оплата сохраняет карту
  const [ev0] = await e.calendar.findAllByCode(r.code);
  assert.equal(e.payments._get(ev0.private.paymentId).body.save_payment_method, true);
  // через неделю время занято для разовой брони
  const busy = await e.booking.getBusy('2026-11-18', '2026-11-18');
  assert.ok(busy['2026-11-18'].includes(12));
  const w3 = await e.calendar.findAllByCode(sub.weeks[3].code);
  assert.match(w3[0].summary, /^🔁 .*постоянная/);
});

test('оформление: нужны почта, согласие на автосписание и время в пределах недели', async () => {
  const e = env();
  await assert.rejects(e.booking.book(form({ email: '' })), (x) => x.status === 400 && Boolean(x.fields.email));
  await assert.rejects(e.booking.book(form({ autopayConsent: false })), (x) => x.status === 400 && Boolean(x.fields.autopayConsent));
  await assert.rejects(e.booking.book(form({ ranges: [{ date: '2026-11-11', hours: [12] }, { date: '2026-11-18', hours: [12] }] })), (x) => x.status === 400 && Boolean(x.fields.hours));
});

test('оформление: если в какую-то неделю время занято — 409 со списком дат, ничего не создаётся', async () => {
  const e = env();
  await e.booking.book({ ranges: [{ date: '2026-12-02', hours: [12] }], name: 'Другой', phone: '+7 900 000-00-00', email: '', note: '', consent: true, pdConsent: true, website: '' });
  const before = e.calendar._size();
  await assert.rejects(e.booking.book(form()), (x) => x.status === 409 && /2 декабря/.test(x.message) && x.fields.conflicts.length === 1);
  assert.equal(e.calendar._size(), before);
  assert.equal(e.store.all().length, 0);
});

test('первая оплата прошла и карта сохранилась → постоянная бронь активна, письмо со ссылкой', async () => {
  const e = env();
  const { sub } = await startActive(e);
  assert.equal(sub.status, 'active');
  assert.ok(sub.paymentMethod.id);
  const started = e.sent.find((x) => x[0] === 'sub:started')[1];
  assert.match(started.url, /^https:\/\/site\.test\/subscription\?id=S[A-Z2-9]{6}&t=[0-9a-f]{24}$/);
  assert.equal(started.reserved.length, 7);
  // письмо об оплате первого занятия знает о постоянной брони
  assert.ok(e.sent.find((x) => x[0] === 'paid')[1].subUrl);
});

test('автосписание за 3 дня до занятия: 🔁 → ✅, письмо об оплате; раньше срока ничего не списывается', async () => {
  const e = env();
  const { sub } = await startActive(e);
  e.clock.now = new Date(at('2026-11-15', 11).getTime());          // за 3 дня минус час — рано
  await e.subs.tick();
  assert.equal(sub.weeks.find((w) => w.k === 1).status, 'reserved');
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);  // ровно за 3 дня — списываем
  e.sent.length = 0;
  await e.subs.tick();
  const w1 = sub.weeks.find((w) => w.k === 1);
  assert.equal(w1.status, 'paid');
  const evs = await e.calendar.findAllByCode(w1.code);
  assert.match(evs[0].summary, /^✅/);
  assert.equal(evs[0].private.status, 'paid');
  const p = e.payments._get(w1.paymentId);
  assert.equal(p.body.payment_method_id, sub.paymentMethod.id);
  assert.equal(p.body.confirmation, undefined);
  assert.deepEqual(kinds(e.sent), ['paid']);
});

test('банк отказал: письмо, повтор через сутки; не оплачено за сутки до занятия → пауза и время освобождено', async () => {
  const e = env();
  const { sub } = await startActive(e);
  e.payments._autopay('canceled');
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  e.sent.length = 0;
  await e.subs.tick();
  const w1 = () => sub.weeks.find((w) => w.k === 1);
  assert.equal(w1().status, 'reserved');
  assert.equal(w1().attempts, 1);
  assert.deepEqual(kinds(e.sent), ['sub:charge_failed']);
  assert.match(e.sent[0][1].reason, /insufficient_funds/);
  await e.subs.tick();                                                // повтор не раньше чем через сутки
  assert.equal(w1().attempts, 1);
  e.clock.now = new Date(e.clock.now.getTime() + 24 * H + 60000);   // 16.11, снова отказ
  await e.subs.tick();
  assert.equal(w1().attempts, 2);
  e.clock.now = new Date(at('2026-11-17', 12).getTime() + 60000);   // меньше суток до занятия
  e.sent.length = 0;
  await e.subs.tick();
  assert.equal(sub.status, 'paused');
  assert.ok(kinds(e.sent).includes('sub:paused'));
  assert.deepEqual((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'], []);
  assert.deepEqual((await e.booking.getBusy('2026-11-25', '2026-11-25'))['2026-11-25'], []);
  // оплаченная первая неделя остаётся
  assert.equal(sub.weeks.find((w) => w.k === 0).status, 'paid');
});

test('продление: когда неделя прошла, закрепляется следующая — всегда 8 недель вперёд', async () => {
  const e = env();
  const { sub } = await startActive(e);
  e.clock.now = new Date(at('2026-11-11', 14).getTime());           // первое занятие прошло
  await e.subs.tick();
  const k8 = sub.weeks.find((w) => w.k === 8);
  assert.equal(k8.status, 'reserved');
  const [ev] = await e.calendar.findAllByCode(k8.code);
  assert.equal(ev.private.date, '2027-01-06');
});

test('отмена по ссылке: будущие неоплаченные недели освобождаются, оплаченные остаются', async () => {
  const e = env();
  const { sub } = await startActive(e);
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  await e.subs.tick();                                                // неделя 1 оплачена
  await assert.rejects(e.subs.cancel(sub.id, '0'.repeat(24)), (x) => x.status === 404);
  const v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.status, 'active');
  assert.ok(v.weeks.some((w) => w.status === 'paid'));
  await e.subs.cancel(sub.id, sub.token);
  assert.equal(sub.status, 'cancelled');
  assert.ok((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'].includes(12)); // оплачено — остаётся
  assert.deepEqual((await e.booking.getBusy('2026-11-25', '2026-11-25'))['2026-11-25'], []);
  assert.ok(kinds(e.sent).includes('sub:cancelled'));
  e.clock.now = new Date(at('2026-11-22', 12).getTime() + 60000);
  e.sent.length = 0;
  await e.subs.tick();                                                // после отмены ничего не списывается
  assert.deepEqual(e.sent, []);
});

test('карта не сохранилась (автоплатежи не включены) → первое занятие оплачено, недели освобождены', async () => {
  const e = env();
  e.payments._noSave(true);
  const { sub } = await startActive(e);
  assert.equal(sub.status, 'cancelled');
  assert.equal(sub.endReason, 'card_not_saved');
  assert.ok(kinds(e.sent).includes('sub:card_not_saved'));
  assert.deepEqual((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'], []);
  assert.ok((await e.booking.getBusy('2026-11-11', '2026-11-11'))['2026-11-11'].includes(12));
});

test('первую неделю не оплатили → бронь снята по таймеру, закреплённые недели освобождены', async () => {
  const e = env();
  const r = await e.booking.book(form());
  e.clock.now = new Date(NOW.getTime() + 2 * H);
  await e.booking.sweep();
  assert.equal(e.store.get(r.subscription.id).status, 'cancelled');
  assert.deepEqual((await e.booking.getBusy('2026-11-25', '2026-11-25'))['2026-11-25'], []);
});

test('постоянная бронь выключена (SUBSCRIPTIONS не задан) → понятная ошибка', async () => {
  const e = env({ SUBSCRIPTIONS: '' });
  e.booking.setSubscriptions(null, e.subs.hooks);
  await assert.rejects(e.booking.book(form()), (x) => x.status === 400 && x.code === 'subs_off');
});

test('автосписание «в обработке», потом уведомление ЮKassa об успехе → занятие оплачено, денег не возвращаем', async () => {
  const e = env();
  const { sub } = await startActive(e);
  e.payments._autopay('pending');
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  await e.subs.tick();
  const w1 = sub.weeks.find((w) => w.k === 1);
  assert.equal(w1.status, 'charging');
  e.payments._set(w1.paymentId, 'succeeded');
  assert.equal(await e.booking.syncPayment(w1.paymentId), 'paid');   // как уведомление от ЮKassa
  assert.equal(w1.status, 'paid');
  assert.equal(e.payments._refunds.length, 0);
  await e.subs.tick();
  assert.equal(w1.status, 'paid');
});

test('личный кабинет: дата оформления, следующее списание, карта, история платежей', async () => {
  const e = env();
  const { sub } = await startActive(e);
  let v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.createdAt, '09.11.2026');
  assert.equal(v.nextChargeAt, '15.11.2026');        // за 3 дня до занятия 18.11
  assert.equal(v.nextChargeAmount, 800);
  assert.equal(v.card, 'Bank card *4444');
  assert.equal(v.payments.length, 1);
  assert.equal(v.payments[0].amount, 800);
  assert.match(v.payments[0].lesson, /11 ноября/);
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  await e.subs.tick();
  v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.payments.length, 2);
  assert.equal(v.payments[0].date, '15.11.2026');     // свежие сверху
  assert.equal(v.paidUntil, '18.11.2026');
  await e.subs.cancel(sub.id, sub.token);
  v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.status, 'cancelled');
  assert.equal(v.nextChargeAt, null);
  assert.equal(v.paidUntil, '18.11.2026');
});

test('карта: отвязать — автосписаний нет, неоплаченные недели освобождены, бронь на паузе', async () => {
  const e = env();
  const { sub } = await startActive(e);
  await assert.rejects(e.subs.unbindCard(sub.id, '0'.repeat(24)), (x) => x.status === 404);
  await e.subs.unbindCard(sub.id, sub.token);
  assert.equal(sub.paymentMethod, null);
  assert.equal(sub.status, 'paused');
  assert.ok(kinds(e.sent).includes('sub:card_unbound'));
  assert.deepEqual((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'], []);
  assert.ok((await e.booking.getBusy('2026-11-11', '2026-11-11'))['2026-11-11'].includes(12)); // оплаченное остаётся
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  e.sent.length = 0;
  await e.subs.tick();
  assert.deepEqual(e.sent, []);                                      // списаний нет
});

test('карта: привязать новую — проверочный 1 ₽ с сохранением карты, рубль вернули, бронь снова активна', async () => {
  const e = env();
  const { sub } = await startActive(e);
  await e.subs.unbindCard(sub.id, sub.token);
  const r = await e.subs.startBind(sub.id, sub.token);
  assert.ok(r.confirmationToken);
  const p = e.payments._get(sub.bindPaymentId);
  assert.equal(p.amount.value, '1.00');
  assert.equal(p.body.save_payment_method, true);
  assert.match(p.body.description, /Проверка карты/);
  assert.equal((await e.subs.bindStatus(sub.id, sub.token)).status, 'pending');
  e.payments._set(sub.bindPaymentId, 'succeeded');
  const done = await e.subs.bindStatus(sub.id, sub.token);
  assert.equal(done.status, 'bound');
  assert.equal(sub.status, 'active');
  assert.ok(sub.paymentMethod.id);
  assert.equal(e.payments._refunds.length, 1);
  assert.equal(e.payments._refunds[0].amount, 1);
  assert.ok(kinds(e.sent).includes('sub:card_bound'));
  // освобождённые недели снова закреплены
  assert.ok((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'].includes(12));
  // и списание снова работает
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  await e.subs.tick();
  assert.equal(sub.weeks.find((w) => w.k === 1).status, 'paid');
});

test('карта: привязка не прошла — карта прежняя, можно попробовать снова', async () => {
  const e = env();
  const { sub } = await startActive(e);
  const before = sub.paymentMethod.id;
  await e.subs.startBind(sub.id, sub.token);
  e.payments._set(sub.bindPaymentId, 'canceled');
  const r = await e.subs.bindStatus(sub.id, sub.token);
  assert.equal(r.status, 'failed');
  assert.equal(sub.paymentMethod.id, before);
  assert.equal(sub.status, 'active');
});

test('ЮKassa ещё не включила автоплатежи: постоянная бронь оформляется, карта видна в кабинете', async () => {
  const e = env();
  e.payments._noRecurring(true);
  const { r, sub } = await startActive(e);
  assert.equal(r.subscription.weeks, 8);
  assert.equal(sub.linkMode, true);
  const first = e.payments._get(sub.weeks.find((w) => w.k === 0).paymentId);
  assert.equal(first.body.save_payment_method, undefined);          // ЮKassa отклонила бы такой платёж
  assert.equal(sub.status, 'active');
  assert.equal(sub.paymentMethod.id, null);
  assert.equal(sub.paymentMethod.title, 'Bank card *4444');
  const started = e.sent.find((x) => x[0] === 'sub:started')[1];
  assert.equal(started.autopay, false);
  const v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.card, 'Bank card *4444');
  assert.equal(v.payDue, null);
  assert.ok(v.nextChargeAt);
  // время закреплено на 8 недель
  assert.ok((await e.booking.getBusy('2026-12-30', '2026-12-30'))['2026-12-30'].includes(12));
});

test('без автоплатежей: за 3 дня до занятия письмо об оплате, оплата в кабинете по ссылке → ✅', async () => {
  const e = env();
  e.payments._noRecurring(true);
  const { sub } = await startActive(e);
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  e.sent.length = 0;
  await e.subs.tick();
  const w1 = () => sub.weeks.find((w) => w.k === 1);
  assert.equal(w1().status, 'awaiting');
  assert.deepEqual(kinds(e.sent), ['sub:pay_due']);
  assert.equal(e.sent[0][1].amount, sub.weekTotal);
  assert.ok(e.sent[0][1].url.includes(sub.token));
  await e.subs.tick();
  assert.equal(e.sent.length, 1);                                    // письмо одно, не каждую минуту
  let v = await e.subs.view(sub.id, sub.token);
  assert.match(v.payDue.lesson, /18 ноября/);
  assert.equal(v.payDue.amount, sub.weekTotal);
  // клиент нажал «Оплатить»: страница ЮKassa, возврат в кабинет
  const pay = await e.subs.payNow(sub.id, sub.token);
  assert.ok(pay.confirmationUrl);
  const p = e.payments._get(w1().paymentId);
  assert.equal(p.body.confirmation.type, 'redirect');
  assert.ok(p.body.confirmation.return_url.startsWith(`https://site.test/subscription?id=${sub.id}&t=${sub.token}`));
  assert.equal(p.body.metadata.sub, sub.id);
  // повторное нажатие не создаёт второй платёж
  assert.equal((await e.subs.payNow(sub.id, sub.token)).confirmationUrl, pay.confirmationUrl);
  e.payments._set(w1().paymentId, 'succeeded');
  v = await e.subs.view(sub.id, sub.token);                          // кабинет узнаёт итог у ЮKassa
  assert.equal(w1().status, 'paid');
  assert.equal(v.payDue, null);
  assert.equal(v.payments.length, 2);
  const evs = await e.calendar.findAllByCode(w1().code);
  assert.match(evs[0].summary, /^✅/);
});

test('без автоплатежей: не оплатил по ссылке — снова ждём оплату; за сутки до занятия пауза', async () => {
  const e = env();
  e.payments._noRecurring(true);
  const { sub } = await startActive(e);
  e.clock.now = new Date(at('2026-11-15', 12).getTime() + 60000);
  await e.subs.tick();
  await e.subs.payNow(sub.id, sub.token);
  const w1 = () => sub.weeks.find((w) => w.k === 1);
  e.payments._set(w1().paymentId, 'canceled');
  e.sent.length = 0;
  await e.subs.view(sub.id, sub.token);
  assert.equal(w1().status, 'awaiting');
  assert.deepEqual(e.sent, []);                                      // «не удалось списать» тут не к месту
  e.clock.now = new Date(at('2026-11-17', 12).getTime() + 60000);    // меньше суток до занятия
  await e.subs.tick();
  assert.equal(sub.status, 'paused');
  assert.equal(w1().status, 'released');
  assert.ok(kinds(e.sent).includes('sub:paused'));
});

test('без автоплатежей: отвязать и привязать карту в кабинете (1 ₽ без сохранения карты, вернули)', async () => {
  const e = env();
  e.payments._noRecurring(true);
  const { sub } = await startActive(e);
  await e.subs.unbindCard(sub.id, sub.token);
  assert.equal(sub.paymentMethod, null);
  assert.equal(sub.status, 'paused');
  assert.equal((await e.subs.view(sub.id, sub.token)).card, '');
  const r = await e.subs.startBind(sub.id, sub.token);
  assert.ok(r.confirmationToken);
  const p = e.payments._get(sub.bindPaymentId);
  assert.equal(p.amount.value, '1.00');
  assert.equal(p.body.save_payment_method, undefined);
  e.payments._set(sub.bindPaymentId, 'succeeded');
  const done = await e.subs.bindStatus(sub.id, sub.token);
  assert.equal(done.status, 'bound');
  assert.equal(done.card, 'Bank card *4444');
  assert.equal(sub.status, 'active');
  assert.equal(e.payments._refunds.length, 1);
  assert.equal(e.sent.find((x) => x[0] === 'sub:card_bound')[1].autopay, false);
  assert.ok((await e.booking.getBusy('2026-11-18', '2026-11-18'))['2026-11-18'].includes(12));
});

test('ЮKassa 403 «can\'t make recurring payments» → платёж без сохранения карты, saveDeferred', async () => {
  const { createYooKassa } = require('../server/payments');
  const cfg = buildConfig({ PAYMENT_PROVIDER: 'yookassa', YOOKASSA_SHOP_ID: '1', YOOKASSA_SECRET_KEY: 'k', CALENDAR_DRIVER: 'memory' });
  const calls = [];
  const fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    calls.push({ body, key: o.headers['Idempotence-Key'] });
    if (body.save_payment_method) return { ok: false, status: 403, text: async () => '{"type":"error","code":"forbidden","description":"This store can\'t make recurring payments"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: '2f0e0d2a-000f-5000-8000-1a2b3c4d5e6f', status: 'pending', amount: body.amount, confirmation: { type: 'embedded', confirmation_token: 'ct-1' } }) };
  };
  const yk = createYooKassa(cfg, { fetch });
  const b = { code: 'ABCD', total: 1000, hoursCount: 1, dateLabel: 'среда', timeLabel: '12:00–13:00', savePaymentMethod: true, idempotenceKey: 'pay-ABCD-1' };
  const p = await yk.createPayment(b);
  assert.equal(p.saveDeferred, true);
  assert.equal(p.confirmationToken, 'ct-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.save_payment_method, undefined);
  assert.equal(calls[1].key, 'pay-ABCD-1-n');
  // следующие полчаса сразу без сохранения карты, лишнего запроса нет
  await yk.createPayment({ ...b, idempotenceKey: 'pay-ABCD-2' });
  assert.equal(calls.length, 3);
  // обычный платёж не трогаем
  const plain = await yk.createPayment({ ...b, savePaymentMethod: false, idempotenceKey: 'pay-X' });
  assert.equal(plain.saveDeferred, undefined);
});

test('тестовая запись для показа кабинета: отвязка и привязка карты работают, календарь не трогается, списаний нет', async () => {
  const e = env();
  e.payments._noRecurring(true);
  const sub = {
    id: 'STESTAA', token: 'a'.repeat(24), status: 'active', createdAt: NOW.toISOString(), test: true, linkMode: true,
    name: 'Проверка ЮKassa', phone: '', email: 'admin@example.com', purpose: '', people: '', note: '',
    slots: [{ date: '2026-11-18', first: 19, last: 19, total: 1000 }], weekTotal: 1000,
    weeks: Array.from({ length: 8 }, (_, k) => ({ k, code: `T00${k}`, status: 'reserved', paymentId: null, attempts: 0, nextTryAt: null })),
    paymentMethod: { id: null, title: 'Bank card *4444' },
  };
  e.store.put(sub);
  const size = e.calendar._size();
  let v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.card, 'Bank card *4444');
  assert.ok(v.nextChargeAt);
  await e.subs.unbindCard(sub.id, sub.token);
  v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.card, '');
  assert.equal(v.status, 'paused');
  await e.subs.startBind(sub.id, sub.token);
  e.payments._set(sub.bindPaymentId, 'succeeded');
  assert.equal((await e.subs.bindStatus(sub.id, sub.token)).status, 'bound');
  v = await e.subs.view(sub.id, sub.token);
  assert.equal(v.status, 'active');
  assert.equal(v.weeks.filter((w) => w.status === 'reserved').length, 8);
  e.clock.now = new Date(at('2026-11-15', 20).getTime());            // окно «списания» — у тестовой записи ничего не происходит
  await e.subs.tick();
  assert.equal(sub.weeks.filter((w) => w.status === 'reserved').length, 8);
  assert.equal(e.calendar._size(), size);
  await e.subs.cancel(sub.id, sub.token);
  assert.equal((await e.subs.view(sub.id, sub.token)).status, 'cancelled');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, valid, NOW } = require('./helpers');
const { validateOrder } = require('../server/validate');
const { buildConfig } = require('../server/config');

const two = () => makeEnv({ SLOT_HOURS: '2' });
const order = (ranges, over = {}) => ({ ...valid(), date: undefined, hours: undefined, ranges, ...over });

test('блоки по 2 часа: принимаются 09–11 и 17–21, не принимаются 10–12 и один час', () => {
  const cfg = buildConfig({ SLOT_HOURS: '2', STUDIO_TZ: 'Europe/Moscow' });
  assert.ok(validateOrder(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-14', hours: [17, 18, 19, 20] }]), cfg, NOW));
  assert.throws(() => validateOrder(order([{ date: '2026-11-13', hours: [10, 11] }]), cfg, NOW), (e) => /блоками по 2/.test(e.fields.hours));
  assert.throws(() => validateOrder(order([{ date: '2026-11-13', hours: [9] }]), cfg, NOW), (e) => /блоками по 2/.test(e.fields.hours));
});

test('несколько промежутков в разные дни: одна бронь, одна сумма, событие на каждый промежуток', async () => {
  const { booking, calendar, sent } = two();
  const r = await booking.book(order([{ date: '2026-11-14', hours: [17, 18] }, { date: '2026-11-13', hours: [9, 10, 11, 12, 13, 14] }]));
  assert.equal(r.total, 6 * 800 + 2 * 1000);
  assert.equal(r.ranges.length, 2);
  assert.equal(r.ranges[0].date, '2026-11-13');                       // отсортировано по времени
  assert.equal(r.dateLabel, '2 промежутка');
  assert.match(r.whenLabel, /пятница, 13 ноября, 09:00–15:00; суббота, 14 ноября, 17:00–19:00/);
  const evs = await calendar.findAllByCode(r.code);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.private.part).sort(), ['1/2', '2/2']);
  assert.equal(sent.filter((x) => x[0] === 'created').length, 1);   // одно письмо на всю бронь
  const slots = await booking.getBusy('2026-11-13', '2026-11-14');
  assert.deepEqual(slots['2026-11-13'], [9, 10, 11, 12, 13, 14]);
  assert.deepEqual(slots['2026-11-14'], [17, 18]);
});

test('если занят хотя бы один промежуток, не создаётся ни одного события', async () => {
  const { booking, calendar } = two();
  await booking.book(order([{ date: '2026-11-14', hours: [17, 18] }]));
  const before = calendar._size();
  await assert.rejects(booking.book(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-14', hours: [17, 18] }], { email: 'b@example.com' })), (e) => e.status === 409);
  assert.equal(calendar._size(), before);
});

test('пересекающиеся промежутки одного дня отклоняются', () => {
  const cfg = buildConfig({ SLOT_HOURS: '1', STUDIO_TZ: 'Europe/Moscow' });
  assert.throws(() => validateOrder(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-13', hours: [10, 11] }]), cfg, NOW), /пересекаются/);
});

test('отмена удаляет все промежутки брони', async () => {
  const { booking, calendar } = two();
  const r = await booking.book(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-15', hours: [19, 20] }]));
  await booking.cancel(r.code, r.token);
  assert.equal((await calendar.findAllByCode(r.code)).length, 0);
});

test('онлайн-оплата: одна сумма за все промежутки, после оплаты зелёные все события, письмо одно', async () => {
  const { booking, calendar, payments, sent } = makeEnv({ SLOT_HOURS: '2', PAYMENT_PROVIDER: 'fake' });
  const r = await booking.book(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-14', hours: [19, 20] }]));
  const pid = (await calendar.findAllByCode(r.code))[0].private.paymentId;
  assert.equal(payments._get(pid).amount.value, '3600.00');
  payments._set(pid, 'succeeded');
  assert.equal(await booking.syncPayment(pid), 'paid');
  const evs = await calendar.findAllByCode(r.code);
  assert.ok(evs.every((e) => e.private.status === 'paid' && e.summary.startsWith('✅')));
  const paid = sent.filter((x) => x[0] === 'paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0][1].ranges.length, 2);
  assert.equal((await booking.status(r.code, r.token)).status, 'paid');
});

test('просрочка снимает все промежутки брони разом', async () => {
  const { booking, calendar, clock, sent } = two();
  const r = await booking.book(order([{ date: '2026-11-13', hours: [9, 10] }, { date: '2026-11-14', hours: [9, 10] }]));
  clock.now = new Date(NOW.getTime() + 3 * 3600 * 1000);
  const s = await booking.sweep();
  assert.equal(s.expired, 1);
  assert.equal((await calendar.findAllByCode(r.code)).length, 0);
  assert.equal(sent.filter((x) => x[0] === 'expired').length, 1);
});

test('платёж потерялся (перезапуск, сбой ЮKassa) — просроченная бронь всё равно снимается', async () => {
  const { booking, calendar, clock, payments } = makeEnv({ PAYMENT_PROVIDER: 'fake' });
  const r = await booking.book(order([{ date: '2026-11-13', hours: [18] }]));
  const [ev] = await calendar.findAllByCode(r.code);
  payments.getPayment = async () => { throw new Error('Платёж не найден'); };
  let s = await booking.sweep();
  assert.equal(s.expired, 0);                                  // ещё не просрочена — ждём
  assert.equal((await calendar.findAllByCode(r.code)).length, 1);
  clock.now = new Date(NOW.getTime() + 3 * 3600 * 1000);
  s = await booking.sweep();
  assert.equal(s.expired, 1);
  assert.equal((await calendar.findAllByCode(r.code)).length, 0, 'событие ' + ev.id + ' должно удалиться');
});

test('152-ФЗ: в брони записано, когда и на какую редакцию дано согласие', async () => {
  const { booking, calendar } = makeEnv();
  const r = await booking.book(order([{ date: '2026-11-13', hours: [12] }]));
  const [ev] = await calendar.findAllByCode(r.code);
  assert.equal(ev.private.pdConsentAt, NOW.toISOString());
  assert.equal(ev.private.pdConsentDoc, '2026-11-17');
  assert.match(ev.description, /Согласие на обработку персональных данных: дано/);
});

test('круглосуточно (OPEN_HOUR=0, CLOSE_HOUR=24): брони 00–01 и 23–24, конец в полночь следующего дня', async () => {
  const { booking, calendar, cfg } = makeEnv({ OPEN_HOUR: '0', CLOSE_HOUR: '24' });
  assert.equal(cfg.openHour, 0);
  assert.equal(cfg.closeHour, 24);
  const r = await booking.book(order([{ date: '2026-11-13', hours: [23] }, { date: '2026-11-14', hours: [0, 1] }]));
  assert.deepEqual(r.ranges.map((x) => x.timeLabel), ['23:00–24:00', '00:00–02:00']);
  const evs = await calendar.findAllByCode(r.code);
  const late = evs.find((e) => e.private.date === '2026-11-13');
  assert.equal(late.end, '2026-11-13T21:00:00.000Z'); // 24:00 МСК = 00:00 следующего дня
  assert.equal(r.total, 1000 + 800 * 2);              // 23:00 — вечерний тариф, ночь — дневной
  const busy = await booking.getBusy('2026-11-13', '2026-11-14');
  assert.ok(busy['2026-11-13'].includes(23) && busy['2026-11-14'].includes(0));
});

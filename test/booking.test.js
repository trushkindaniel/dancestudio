'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv, valid } = require('./helpers');

test('бронь: создаёт жёлтое событие, считает цену на сервере, занимает слот', async () => {
  const { booking, calendar, cfg, sent } = makeEnv();
  const r = await booking.book(valid());
  assert.equal(r.total, 2000);
  assert.match(r.code, /^[A-Z2-9]{4}$/);
  assert.equal(r.timeLabel, '18:00–20:00');
  assert.equal(calendar._size(), 1);

  const ev = await calendar.findByCode(r.code);
  assert.equal(ev.colorId, cfg.pendingColorId);
  assert.equal(ev.private.status, 'pending');
  assert.match(ev.summary, /^⏳ /);
  assert.equal(sent[0][0], 'created');

  const busy = (await booking.getBusy('2026-11-13', '2026-11-13'))['2026-11-13'];
  assert.deepEqual(busy, [18, 19]);
});

test('бронь: цена из браузера игнорируется', async () => {
  const { booking } = makeEnv();
  const r = await booking.book({ ...valid(), total: 1, price: 1 });
  assert.equal(r.total, 2000);
});

test('бронь: второй клиент на то же время получает 409', async () => {
  const { booking } = makeEnv();
  await booking.book(valid());
  await assert.rejects(booking.book(valid({ hours: [19, 20], name: 'Борис' })), (e) => e.status === 409 && e.code === 'slot_taken');
});

test('бронь: одновременные заявки на один слот, проходит ровно одна', async () => {
  const { booking, calendar } = makeEnv();
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => booking.book(valid({ name: `Клиент ${i + 1}` }))));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length, 4);
  assert.equal(calendar._size(), 1);
});

test('бронь: соседние часы разных клиентов не мешают друг другу', async () => {
  const { booking } = makeEnv();
  await booking.book(valid({ hours: [18] }));
  await assert.doesNotReject(booking.book(valid({ hours: [19], name: 'Борис' })));
});

test('слоты: диапазон проверяется', async () => {
  const { booking } = makeEnv();
  await assert.rejects(booking.getBusy('bad', '2026-11-13'), (e) => e.status === 400);
  await assert.rejects(booking.getBusy('2026-11-13', '2026-11-01'), (e) => e.status === 400);
  await assert.rejects(booking.getBusy('2026-11-01', '2026-12-31'), (e) => e.status === 400);
});

test('отмена: по коду и секрету, чужой секрет не подходит', async () => {
  const { booking, calendar, sent } = makeEnv();
  const r = await booking.book(valid());
  await assert.rejects(booking.cancel(r.code, 'a'.repeat(24)), (e) => e.status === 404);
  await assert.rejects(booking.cancel(r.code, 'x'), (e) => e.status === 404);
  assert.equal(calendar._size(), 1);
  assert.deepEqual(await booking.cancel(r.code, r.token), { ok: true });
  assert.equal(calendar._size(), 0);
  assert.equal(sent.at(-1)[0], 'cancelled');
});

test('отмена: оплаченную бронь клиент отменить не может', async () => {
  const { booking, calendar, cfg } = makeEnv();
  const r = await booking.book(valid());
  calendar._paint((await calendar.findByCode(r.code)).id, cfg.paidColorId);
  await booking.sweep();
  await assert.rejects(booking.cancel(r.code, r.token), (e) => e.status === 409);
});

test('проверка: зелёное событие становится оплаченным, клиенту уходит письмо', async () => {
  const { booking, calendar, cfg, sent } = makeEnv();
  const r = await booking.book(valid());
  assert.deepEqual(await booking.sweep(), { paid: 0, expired: 0, released: 0, refunded: 0, errors: 0 });

  calendar._paint((await calendar.findByCode(r.code)).id, cfg.paidColorId);
  assert.deepEqual(await booking.sweep(), { paid: 1, expired: 0, released: 0, refunded: 0, errors: 0 });

  const ev = await calendar.findByCode(r.code);
  assert.equal(ev.private.status, 'paid');
  assert.match(ev.summary, /^✅ /);
  assert.equal(sent.at(-1)[0], 'paid');
  assert.equal(sent.at(-1)[1].email, 'anna@example.com');

  // повторная проверка ничего не делает
  assert.deepEqual(await booking.sweep(), { paid: 0, expired: 0, released: 0, refunded: 0, errors: 0 });
});

test('проверка: просроченная бронь удаляется, слот свободен', async () => {
  const { booking, calendar, clock, sent } = makeEnv();
  await booking.book(valid());
  clock.now = new Date(clock.now.getTime() + 119 * 60000);
  assert.equal((await booking.sweep()).expired, 0);

  clock.now = new Date(clock.now.getTime() + 2 * 60000);
  assert.deepEqual(await booking.sweep(), { paid: 0, expired: 1, released: 0, refunded: 0, errors: 0 });
  assert.equal(calendar._size(), 0);
  assert.equal(sent.at(-1)[0], 'expired');
  assert.deepEqual((await booking.getBusy('2026-11-13', '2026-11-13'))['2026-11-13'], []);
});

test('проверка: если админ успел покрасить после срока, бронь оплачена, а не удалена', async () => {
  const { booking, calendar, clock, cfg } = makeEnv();
  const r = await booking.book(valid());
  clock.now = new Date(clock.now.getTime() + 300 * 60000);
  calendar._paint((await calendar.findByCode(r.code)).id, cfg.paidColorId);
  assert.deepEqual(await booking.sweep(), { paid: 1, expired: 0, released: 0, refunded: 0, errors: 0 });
});

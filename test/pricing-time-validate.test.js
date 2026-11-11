'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../server/config');
const { priceFor } = require('../server/pricing');
const T = require('../server/time');
const { validateBooking } = require('../server/validate');
const { NOW, valid } = require('./helpers');

// часы в тестах по Москве (NOW = 10:00 МСК)
const cfg = buildConfig({ STUDIO_TZ: 'Europe/Moscow' });

test('цена: день 800, вечер 1000, граница 17:00 считается по часам', () => {
  assert.deepEqual(priceFor([10, 11], cfg), { dayHours: 2, peakHours: 0, total: 1600 });
  assert.equal(priceFor([18, 19], cfg).total, 2000);
  assert.equal(priceFor([16, 17, 18], cfg).total, 800 + 1000 + 1000);
});

test('время: Москва это UTC+3', () => {
  assert.equal(T.zonedToUtc('2026-11-13', 18, 'Europe/Moscow').toISOString(), '2026-11-13T15:00:00.000Z');
  assert.deepEqual(T.nowInTz(NOW, 'Europe/Moscow'), { date: '2026-11-09', minutes: 600 });
});

test('время: другой пояс и переход через полночь', () => {
  assert.equal(T.zonedToUtc('2026-07-01', 1, 'Asia/Yekaterinburg').toISOString(), '2026-06-30T20:00:00.000Z');
  assert.deepEqual(T.nowInTz(new Date('2026-11-09T22:30:00Z'), 'Europe/Moscow'), { date: '2026-11-10', minutes: 90 });
});

test('даты: проверка и арифметика', () => {
  assert.equal(T.isDateKey('2026-02-30'), false);
  assert.equal(T.isDateKey('2026-11-13'), true);
  assert.equal(T.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(T.daysBetween('2026-11-09', '2026-11-13'), 4);
});

test('заявка: нормальная проходит, часы сортируются', () => {
  const v = validateBooking(valid({ hours: [19, 18] }), cfg, NOW);
  assert.deepEqual(v.hours, [18, 19]);
  assert.equal(v.name, 'Анна');
});

test('заявка: ошибки по полям', () => {
  assert.throws(() => validateBooking(valid({ name: '', phone: '123', email: 'x', consent: false }), cfg, NOW), (e) => {
    assert.equal(e.status, 400);
    assert.deepEqual(Object.keys(e.fields).sort(), ['consent', 'email', 'name', 'phone']);
    return true;
  });
});

test('заявка: нельзя часы не подряд, вне графика, слишком много, в прошлом, далеко вперёд', () => {
  const bad = (over) => assert.throws(() => validateBooking(valid(over), cfg, NOW), (e) => e.status === 400);
  bad({ hours: [10, 12] });
  bad({ hours: [8] });
  bad({ hours: [21] });
  bad({ hours: [9, 10, 11, 12, 13, 14, 15, 16, 17] });
  bad({ hours: [] });
  bad({ hours: ['10'] });
  bad({ date: '2026-11-08' });
  bad({ date: '2026-11-09', hours: [10] });      // ближайший час закрыт (сейчас 10:00)
  bad({ date: '2027-03-01' });
});

test('заявка: на сегодня позже, чем через час, можно', () => {
  assert.doesNotThrow(() => validateBooking(valid({ date: '2026-11-09', hours: [12] }), cfg, NOW));
});

test('заявка: заполненная ловушка для ботов отклоняется', () => {
  assert.throws(() => validateBooking(valid({ website: 'http://spam' }), cfg, NOW), (e) => e.code === 'spam');
});

test('заявка: формат аренды и число людей необязательны, мусор отбрасывается', () => {
  const v = validateBooking(valid({ purpose: 'shoot', people: 12 }), cfg, NOW);
  assert.equal(v.purposeLabel, 'фото- или видеосъёмка');
  assert.equal(v.people, 12);
  const empty = validateBooking(valid({ purpose: 'hack', people: null }), cfg, NOW);
  assert.equal(empty.purpose, '');
  assert.equal(empty.people, null);
  assert.throws(() => validateBooking(valid({ people: 500 }), cfg, NOW), (e) => Boolean(e.fields && e.fields.people));
});

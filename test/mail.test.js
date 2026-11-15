'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../server/config');
const { templates, pickupTime, icsEvent } = require('../server/mail');
const { createNotifier } = require('../server/notify');

const cfg = buildConfig({ STUDIO_TZ: 'Asia/Omsk', SMTP_HOST: 'smtp.test', SMTP_USER: 'box@test.ru', MAIL_FROM: 'I love stretch <box@test.ru>' });
const booking = {
  code: 'AB23', name: 'Анна <script>', email: 'anna@example.com', phone: '+7 900 123-45-67', total: 2000,
  date: '2026-11-13', startHour: 18, endHour: 20, purpose: 'репетиция', people: '8',
  start: new Date('2026-11-13T12:00:00Z'), end: new Date('2026-11-13T14:00:00Z'),
  dateLabel: 'пятница, 13 ноября', timeLabel: '18:00–20:00',
};

test('ключ забирают за 15 минут до начала', () => {
  assert.equal(pickupTime(18, 15), '17:45');
  assert.equal(pickupTime(9, 15), '08:45');
});

test('письмо после оплаты: время, адрес, где взять и куда вернуть ключ, закрыть всё', () => {
  const m = templates.clientPaid(cfg, booking);
  assert.match(m.subject, /AB23 подтверждена/);
  for (const part of ['пятница, 13 ноября, 18:00–20:00', 'Фрунзе, 1 корпус 4', '11 этаж, помещение 1131', '17:45', 'офис ITB, 3 этаж, офис 307', 'стойку ресепшена', 'окна, свет, дверь зала']) {
    assert.ok(m.text.includes(part), `в тексте нет «${part}»`);
    assert.ok(m.html.includes(part), `в HTML нет «${part}»`);
  }
  assert.equal(m.attachments[0].filename, 'bron-AB23.ics');
});

test('имя клиента экранируется в HTML', () => {
  const m = templates.clientPaid(cfg, booking);
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('Анна &lt;script&gt;'));
});

test('событие для календаря: время в UTC, место, напоминание', () => {
  const ics = icsEvent(cfg, booking);
  assert.match(ics, /DTSTART:20261113T120000Z/);
  assert.match(ics, /DTEND:20261113T140000Z/);
  assert.match(ics, /LOCATION:Омск\\, ул\. Фрунзе/);
  assert.match(ics, /TRIGGER:-PT60M/);
});

test('администратору: оплата прошла, клиент, формат, когда выдать ключ', () => {
  const m = templates.adminPaid(cfg, booking);
  assert.match(m.subject, /^Оплата прошла: бронь AB23/);
  for (const part of ['+7 900 123-45-67', 'anna@example.com', 'репетиция', 'Человек: 8', '17:45']) assert.ok(m.text.includes(part), part);
});

test('после оплаты уходят два письма: клиенту с инструкцией и администратору', async () => {
  const sent = [];
  const n = createNotifier(cfg, { transport: { sendMail: async (o) => sent.push(o) }, log: { log() {}, error() {}, warn() {} } });
  await n.paid(booking);
  assert.deepEqual(sent.map((o) => o.to).sort(), ['anna@example.com', 'box@test.ru']);
  const client = sent.find((o) => o.to === 'anna@example.com');
  assert.ok(client.html && client.text && client.attachments.length === 1);
  assert.equal(client.from, 'I love stretch <box@test.ru>');
  assert.match(sent.find((o) => o.to === 'box@test.ru').subject, /Оплата прошла/);
});

test('ADMIN_EMAIL важнее ящика отправителя', () => {
  assert.equal(buildConfig({ SMTP_USER: 'box@test.ru', ADMIN_EMAIL: 'owner@test.ru' }).adminEmail, 'owner@test.ru');
  assert.equal(buildConfig({ SMTP_USER: 'box@test.ru' }).adminEmail, 'box@test.ru');
});

test('сбой SMTP не ломает подтверждение брони', async () => {
  const n = createNotifier(cfg, { transport: { sendMail: async () => { throw new Error('535 auth'); } }, log: { log() {}, error() {}, warn() {} } });
  await assert.doesNotReject(n.paid(booking));
});

test('бронь из нескольких промежутков: все даты, ключ к каждому, событие календаря на каждый', () => {
  const multi = { ...booking, total: 3600, dateLabel: '2 промежутка', ranges: [
    { date: '2026-11-13', startHour: 9, endHour: 11, dateLabel: 'пятница, 13 ноября', timeLabel: '09:00–11:00', start: new Date('2026-11-13T03:00:00Z'), end: new Date('2026-11-13T05:00:00Z') },
    { date: '2026-11-14', startHour: 19, endHour: 21, dateLabel: 'суббота, 14 ноября', timeLabel: '19:00–21:00', start: new Date('2026-11-14T13:00:00Z'), end: new Date('2026-11-14T15:00:00Z') },
  ] };
  const m = templates.clientPaid(cfg, multi);
  for (const part of ['пятница, 13 ноября, 09:00–11:00', 'суббота, 14 ноября, 19:00–21:00', 'в 08:45', 'в 18:45']) assert.ok(m.text.includes(part), part);
  assert.equal((m.attachments[0].content.match(/BEGIN:VEVENT/g) || []).length, 2);
  const a = templates.adminPaid(cfg, multi);
  assert.match(a.subject, /2 промежутка/);
  assert.ok(a.text.includes('суббота, 14 ноября в 18:45'));
});

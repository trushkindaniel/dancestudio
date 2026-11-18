'use strict';
/* Яндекс Календарь (CalDAV): разбор iCalendar и полный путь брони на поддельном CalDAV-сервере в памяти. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConfig } = require('../server/config');
const { buildEvent, parseEvents } = require('../server/calendar/ical');
const { createCalDavCalendar } = require('../server/calendar/caldav');
const { createBookingService } = require('../server/booking');
const { createFakePayments } = require('../server/payments');

const NOW = new Date('2026-11-09T07:00:00Z'); // понедельник, 10:00 МСК

/** Поддельный CalDAV-сервер в духе caldav.yandex.ru */
function fakeCalDav({ calendars = [{ path: '/calendars/user@yandex.ru/events-1/', name: 'Мои события' }, { path: '/calendars/user@yandex.ru/events-2/', name: 'Зал' }], dropXProps = true, lag = false } = {}) {
  const store = new Map(); // path → { text, etag }
  // lag: как Яндекс — после записи событие пару запросов «не видно», после удаления пару запросов «ещё видно»
  const hidden = new Map(); // path → сколько чтений ещё прятать
  const ghosts = new Map(); // path → { text, etag, left }
  let etagN = 0;
  const calls = [];
  const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const reply = (status, body = '', headers = {}) => ({
    ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, text: async () => body,
  });
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const h = init.headers || {};
    calls.push({ method, path: u.pathname, headers: h, body: init.body });
    if (h.Authorization !== 'Basic ' + Buffer.from('user@yandex.ru:app-pass').toString('base64')) return reply(401, 'unauthorized');
    if (method === 'PROPFIND') {
      if (u.pathname === '/') return reply(207, '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/user%40yandex.ru/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>');
      if (u.pathname.startsWith('/principals/')) return reply(207, '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/principals/users/user%40yandex.ru/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/calendars/user%40yandex.ru/</D:href></C:calendar-home-set></D:prop></D:propstat></D:response></D:multistatus>');
      const rows = [`<D:response><D:href>/calendars/user%40yandex.ru/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>`]
        .concat(calendars.map((c) => `<D:response><D:href>${c.path}</D:href><D:propstat><D:prop><D:displayname>${c.name}</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:propstat></D:response>`));
      return reply(207, `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${rows.join('')}</D:multistatus>`);
    }
    if (method === 'PUT') {
      // как Яндекс: событие сохраняется под именем из UID, а не по адресу запроса
      const uid = /\r\nUID:([^\r\n]+)/.exec(init.body)[1];
      const key = u.pathname.replace(/[^/]+$/, '') + encodeURIComponent(uid) + '.ics';
      const cur = store.get(key);
      if (h['If-None-Match'] === '*' && cur) return reply(412, 'exists');
      if (h['If-Match'] && (!cur || cur.etag !== h['If-Match'])) return reply(412, 'etag');
      let text = init.body;
      if (dropXProps) text = text.split('\r\n').filter((l) => !l.startsWith('X-')).join('\r\n');
      const etag = `"${++etagN}"`;
      store.set(key, { text, etag });
      if (lag) hidden.set(key, 2);
      return reply(cur ? 204 : 201, '');
    }
    if (method === 'GET') {
      if (hidden.get(u.pathname) > 0) { hidden.set(u.pathname, hidden.get(u.pathname) - 1); return reply(404, 'not found'); }
      const g = ghosts.get(u.pathname);
      if (g && g.left > 0) { g.left--; return reply(200, g.text, { etag: g.etag }); }
      const cur = store.get(u.pathname);
      return cur ? reply(200, cur.text, { etag: cur.etag + '--gzip' }) : reply(404, 'not found');
    }
    if (method === 'DELETE') {
      const cur = store.get(u.pathname);
      if (lag && cur) ghosts.set(u.pathname, { ...cur, left: 2 });
      return reply(store.delete(u.pathname) ? 204 : 404);
    }
    if (method === 'REPORT') {
      const [, s, e] = /time-range start="(\w+)" end="(\w+)"/.exec(init.body);
      const p = (x) => new Date(`${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6, 8)}T${x.slice(9, 11)}:${x.slice(11, 13)}:${x.slice(13, 15)}Z`);
      const from = p(s); const to = p(e);
      const rows = [];
      const all = new Map([...store, ...[...ghosts].filter(([, g]) => g.left > 0)]);
      for (const [path, v] of all) {
        if (!path.startsWith(u.pathname)) continue;
        if (hidden.get(path) > 0) { hidden.set(path, hidden.get(path) - 1); continue; }
        if (ghosts.has(path) && !store.has(path)) ghosts.get(path).left--;
        const ev = parseEvents(v.text, 'UTC')[0];
        if (ev.end > from && ev.start < to) rows.push(`<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:getetag>${v.etag}</d:getetag><cal:calendar-data>${xml(v.text)}</cal:calendar-data></d:prop></d:propstat></d:response>`);
      }
      return reply(207, `<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${rows.join('')}</d:multistatus>`);
    }
    return reply(405);
  };
  fn.store = store; fn.calls = calls;
  return fn;
}

const env = (extra = {}) => buildConfig({
  CALENDAR_DRIVER: 'yandex', YANDEX_LOGIN: 'user@yandex.ru', YANDEX_APP_PASSWORD: 'app-pass', YANDEX_CALENDAR: 'Зал',
  PAYMENT_PROVIDER: 'fake', STUDIO_TZ: 'Europe/Moscow', SLOT_HOURS: '1', ...extra,
});

function service(fetch, extra) {
  const cfg = env(extra);
  const calendar = createCalDavCalendar(cfg, { fetch, now: () => clock.now });
  const clock = { now: NOW };
  const sent = [];
  const notify = Object.fromEntries(['created', 'paid', 'expired', 'cancelled', 'refunded'].map((k) => [k, async (b) => sent.push([k, b])]));
  const payments = createFakePayments(cfg);
  const booking = createBookingService({ calendar, cfg, notify, payments, now: () => clock.now, log: { error() {}, log() {} } });
  return { cfg, calendar, booking, payments, sent, clock };
}

const order = (over = {}) => ({
  ranges: [{ date: '2026-11-13', hours: [18, 19] }, { date: '2026-11-14', hours: [10] }],
  name: 'Анна, «Тест»; с запятой', phone: '+7 900 123-45-67', email: 'anna@example.com', note: '', consent: true, pdConsent: true, website: '', ...over,
});

test('ical: событие собирается и разбирается обратно без потерь', () => {
  const data = { code: 'AB23', status: 'pending', name: 'Анна; «Тест», \\', long: 'х'.repeat(300) };
  const text = buildEvent({ uid: 'u1', summary: '⏳ AB23 · Анна, 18:00–20:00; тест', description: 'строка 1\nстрока 2', start: new Date('2026-11-13T15:00:00Z'), end: new Date('2026-11-13T17:00:00Z'), data });
  for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'строка длиннее 75 байт: ' + line);
  const [ev] = parseEvents(text, 'Asia/Omsk');
  assert.equal(ev.summary, '⏳ AB23 · Анна, 18:00–20:00; тест');
  assert.equal(ev.description, 'строка 1\nстрока 2');
  assert.deepEqual(ev.data, data);
  assert.equal(ev.start.toISOString(), '2026-11-13T15:00:00.000Z');
});

test('ical: время с TZID, целый день и длительность', () => {
  const text = [
    'BEGIN:VCALENDAR', 'BEGIN:VTIMEZONE', 'TZID:Asia/Omsk', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Asia/Omsk:20261113T090000', 'DURATION:PT1H30M', 'SUMMARY:Ремонт', 'BEGIN:VALARM', 'SUMMARY:напоминание', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART;VALUE=DATE:20261114', 'SUMMARY:Выходной', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const [a, b] = parseEvents(text, 'Europe/Moscow');
  assert.equal(a.start.toISOString(), '2026-11-13T03:00:00.000Z'); // Омск UTC+6
  assert.equal(a.end.toISOString(), '2026-11-13T04:30:00.000Z');
  assert.equal(a.summary, 'Ремонт');
  assert.equal(b.start.toISOString(), '2026-11-13T21:00:00.000Z'); // полночь по Москве
  assert.equal(b.end.getTime() - b.start.getTime(), 86400000);
});

test('caldav: календарь находится по названию, неверный пароль — понятная ошибка', async () => {
  const f = fakeCalDav();
  const cal = createCalDavCalendar(env(), { fetch: f });
  assert.equal(await cal.calendarUrl(), 'https://caldav.yandex.ru/calendars/user@yandex.ru/events-2/');
  const list = await cal.discover();
  assert.deepEqual(list.map((c) => c.name), ['Мои события', 'Зал']);

  const bad = createCalDavCalendar(env({ YANDEX_APP_PASSWORD: 'wrong' }), { fetch: f });
  await assert.rejects(bad.listBusy(NOW, new Date(NOW.getTime() + 86400000)), /пароль приложения/);
  await assert.rejects(createCalDavCalendar(env({ YANDEX_CALENDAR: 'Нет такого' }), { fetch: f }).calendarUrl(), /«Нет такого» не найден/);
});

test('caldav: бронь из двух промежутков → оплата → в календаре ✅, время занято', async () => {
  const f = fakeCalDav();
  const { booking, calendar, payments, sent } = service(f);
  const r = await booking.book(order());
  assert.equal(f.store.size, 2);
  const paths = [...f.store.keys()];
  assert.ok(paths.every((p) => p.startsWith('/calendars/user@yandex.ru/events-2/booking-' + r.code)), paths.join());

  const evs = await calendar.findAllByCode(r.code);
  assert.equal(evs.length, 2);
  assert.ok(evs[0].summary.startsWith('⏳'));
  assert.equal(evs[0].private.status, 'pending');
  assert.equal(evs[0].private.name, order().name);

  // время занято для следующего клиента
  await assert.rejects(booking.book(order({ ranges: [{ date: '2026-11-13', hours: [19] }] })), /заняли/);

  // клиент оплатил
  payments._set(evs[0].private.paymentId, "succeeded");
  assert.equal((await booking.status(r.code, r.token)).status, 'paid');
  const after = await calendar.findAllByCode(r.code);
  assert.ok(after.every((e) => e.summary.startsWith('✅') && e.private.status === 'paid'));
  assert.ok(sent.some(([k]) => k === 'paid'));
  assert.equal((await calendar.listPending()).length, 0);
});

test('caldav: неоплаченная бронь удаляется по таймеру', async () => {
  const f = fakeCalDav();
  const { booking, clock, sent } = service(f);
  await booking.book(order());
  assert.equal(f.store.size, 2);
  clock.now = new Date(NOW.getTime() + 3 * 3600000);
  const res = await booking.sweep();
  assert.equal(res.expired, 1);
  assert.equal(f.store.size, 0);
  assert.ok(sent.some(([k]) => k === 'expired'));
});

test('caldav: администратор заменил ⏳ на ✅ — бронь подтверждена (оплата переводом)', async () => {
  const f = fakeCalDav();
  const { booking, calendar } = service(f, { PAYMENT_PROVIDER: 'transfer' });
  const r = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }] }));
  const [path] = f.store.keys();
  const cur = f.store.get(path);
  f.store.set(path, { text: cur.text.replace('SUMMARY:⏳', 'SUMMARY:✅'), etag: '"admin"' });
  assert.equal((await booking.sweep()).paid, 1);
  const [ev] = await calendar.findAllByCode(r.code);
  assert.equal(ev.private.status, 'paid');
});

test('caldav: Яндекс выбрасывает X-свойство — данные берутся из описания', async () => {
  const f = fakeCalDav();
  const { booking, calendar } = service(f);
  const r = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }] }));
  assert.ok(![...f.store.values()][0].text.includes('X-BOOKING-DATA'));
  const [ev] = await calendar.findAllByCode(r.code);
  assert.equal(ev.private.code, r.code);
  assert.equal(ev.private.status, 'pending');
  assert.ok(!ev.description.includes('#booking:'));
});

test('caldav: свои события администратора тоже занимают время', async () => {
  const f = fakeCalDav();
  const { booking } = service(f);
  f.store.set('/calendars/user@yandex.ru/events-2/admin.ics', {
    etag: '"a"',
    text: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:admin', 'DTSTART;TZID=Europe/Moscow:20261113T150000', 'DTEND;TZID=Europe/Moscow:20261113T170000', 'SUMMARY:Уборка', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
  });
  await assert.rejects(booking.book(order({ ranges: [{ date: '2026-11-13', hours: [16] }] })), /заняли/);
  const ok = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [17] }] }));
  assert.ok(ok.code);
});

test('caldav: Яндекс секунду «не видит» только что записанное — сайт верит своей записи', async () => {
  const f = fakeCalDav({ lag: true });
  const { booking, calendar, payments } = service(f);
  const r = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }] }));
  // сразу после брони: статус «ждёт оплаты», а не «бронь пропала»
  assert.equal((await booking.status(r.code, r.token)).status, 'pending');
  // вторая бронь на тот же час в ту же секунду не проходит
  await assert.rejects(booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }], email: 'b@example.com' })), /заняли/);
  // оплата прошла: подтверждение и повторные проверки сразу после него не приводят к возврату денег
  const [ev] = await calendar.findAllByCode(r.code);
  payments._set(ev.private.paymentId, 'succeeded');
  assert.equal((await booking.status(r.code, r.token)).status, 'paid');
  assert.equal((await booking.status(r.code, r.token)).status, 'paid');
  assert.equal(payments._refunds.length, 0, 'оплаченную бронь нельзя вернуть из-за задержки календаря');
});

test('caldav: после отмены Яндекс ещё секунду показывает событие — время уже свободно', async () => {
  const f = fakeCalDav({ lag: true });
  const { booking } = service(f);
  const r = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }] }));
  await booking.cancel(r.code, r.token);
  assert.equal((await booking.status(r.code, r.token)).status, 'gone');
  const again = await booking.book(order({ ranges: [{ date: '2026-11-13', hours: [12] }], email: 'c@example.com' }));
  assert.ok(again.code);
});

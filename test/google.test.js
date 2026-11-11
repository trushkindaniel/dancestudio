'use strict';
/* Проверяем, что мы шлём в Google правильные запросы. Настоящий Google здесь не вызывается. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createGoogleCalendar } = require('../server/calendar/google');
const { buildConfig } = require('../server/config');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const credentials = {
  email: 'bot@project.iam.gserviceaccount.com',
  key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  tokenUri: 'https://oauth2.googleapis.com/token',
};
const cfg = buildConfig({
  CALENDAR_DRIVER: 'google', GOOGLE_CALENDAR_ID: 'studio@group.calendar.google.com', GOOGLE_SERVICE_ACCOUNT_JSON: '{}',
});

function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const h = handlers.find((x) => x.match(u, init));
    if (!h) throw new Error('неожиданный запрос ' + u);
    const r = h.reply(u, init);
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json || ''), };
  };
  fn.calls = calls;
  return fn;
}

const tokenHandler = { match: (u) => u.includes('oauth2.googleapis.com'), reply: () => ({ json: { access_token: 'TKN', expires_in: 3600 } }) };

test('google: токен берётся один раз, подпись RS256 проверяется', async () => {
  const f = fakeFetch([tokenHandler, { match: (u) => u.endsWith('/freeBusy'), reply: () => ({ json: { calendars: { [cfg.googleCalendarId]: { busy: [] } } } }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials, now: () => new Date('2026-11-09T07:00:00Z') });
  await cal.listBusy(new Date('2026-11-13T00:00:00Z'), new Date('2026-11-14T00:00:00Z'));
  await cal.listBusy(new Date('2026-11-13T00:00:00Z'), new Date('2026-11-14T00:00:00Z'));
  const tokenCalls = f.calls.filter((c) => c.url.includes('oauth2'));
  assert.equal(tokenCalls.length, 1);

  const assertion = new URLSearchParams(tokenCalls[0].body.toString()).get('assertion');
  const [h, c, s] = assertion.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, credentials.email);
  const pub = crypto.createPublicKey(credentials.key);
  assert.equal(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(pub, Buffer.from(s, 'base64url')), true);
});

test('google: занятые периоды превращаются в даты', async () => {
  const f = fakeFetch([tokenHandler, { match: (u) => u.endsWith('/freeBusy'), reply: () => ({ json: { calendars: { [cfg.googleCalendarId]: { busy: [{ start: '2026-11-13T15:00:00Z', end: '2026-11-13T17:00:00Z' }] } } } }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials });
  const busy = await cal.listBusy(new Date('2026-11-13T00:00:00Z'), new Date('2026-11-14T00:00:00Z'));
  assert.equal(busy[0].start.toISOString(), '2026-11-13T15:00:00.000Z');
  const body = JSON.parse(f.calls.at(-1).body);
  assert.equal(body.items[0].id, cfg.googleCalendarId);
});

test('google: ошибка доступа к календарю не маскируется под «всё свободно»', async () => {
  const f = fakeFetch([tokenHandler, { match: (u) => u.endsWith('/freeBusy'), reply: () => ({ json: { calendars: { [cfg.googleCalendarId]: { errors: [{ reason: 'notFound' }] } } } }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials });
  await assert.rejects(cal.listBusy(new Date(), new Date()), /notFound/);
});

test('google: создание события отправляет пояс, цвет и скрытые поля', async () => {
  const f = fakeFetch([tokenHandler, { match: (u, i) => u.includes('/events') && i.method === 'POST', reply: () => ({ json: { id: 'ev1' } }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials });
  const r = await cal.createEvent({
    summary: 'S', description: 'D', colorId: '5', localStart: '2026-11-13T18:00:00', localEnd: '2026-11-13T20:00:00',
    private: { code: 'A7F3', status: 'pending' },
  });
  assert.equal(r.id, 'ev1');
  const call = f.calls.at(-1);
  assert.match(call.url, /calendars\/studio%40group\.calendar\.google\.com\/events$/);
  assert.equal(call.headers.Authorization, 'Bearer TKN');
  const body = JSON.parse(call.body);
  assert.deepEqual(body.start, { dateTime: '2026-11-13T18:00:00', timeZone: 'Asia/Omsk' });
  assert.equal(body.colorId, '5');
  assert.deepEqual(body.extendedProperties.private, { code: 'A7F3', status: 'pending' });
});

test('google: поиск ожидающих по скрытому полю, нормализация ответа', async () => {
  const f = fakeFetch([tokenHandler, { match: (u) => u.includes('/events?'), reply: () => ({ json: { items: [{ id: 'e1', summary: 'x', colorId: '10', extendedProperties: { private: { code: 'A7F3', status: 'pending' } } }, { id: 'e2' }] } }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials });
  const list = await cal.listPending();
  assert.match(decodeURIComponent(f.calls.at(-1).url), /privateExtendedProperty=status=pending/);
  assert.deepEqual(list[0], { id: 'e1', summary: 'x', colorId: '10', private: { code: 'A7F3', status: 'pending' } });
  assert.deepEqual(list[1].private, {});
});

test('google: patch и delete идут по нужным адресам', async () => {
  const f = fakeFetch([tokenHandler, { match: (u, i) => i.method === 'PATCH', reply: () => ({ json: {} }) }, { match: (u, i) => i.method === 'DELETE', reply: () => ({ status: 204 }) }]);
  const cal = createGoogleCalendar(cfg, { fetch: f, credentials });
  await cal.patchEvent('e1', { summary: '✅', private: { status: 'paid' } });
  await cal.deleteEvent('e1');
  const [, patch, del] = f.calls;
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /\/events\/e1$/);
  assert.deepEqual(JSON.parse(patch.body), { summary: '✅', extendedProperties: { private: { status: 'paid' } } });
  assert.equal(del.method, 'DELETE');
});

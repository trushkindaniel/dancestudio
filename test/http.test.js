'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, createRateLimiter } = require('../server/app');
const { makeEnv, NOW } = require('./helpers');

async function start() {
  const env = makeEnv();
  const server = createApp({ cfg: env.cfg, booking: env.booking, calendar: env.calendar, now: () => NOW, log: { error() {}, log() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...env, base, close: () => new Promise((r) => server.close(r)) };
}

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const body = (over = {}) => ({ date: '2026-11-13', hours: [18, 19], name: 'Анна', phone: '+7 900 123-45-67', email: 'anna@example.com', consent: true, pdConsent: true, website: '', ...over });

// «сырой» запрос, чтобы адрес не нормализовался клиентом
const raw = (base, path) => new Promise((resolve, reject) => {
  http.get(base + path, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

test('GET /api/config: настройки и сегодняшняя дата студии, без секретов', async () => {
  const s = await start();
  const j = await (await fetch(s.base + '/api/config')).json();
  assert.equal(j.priceDay, 800);
  assert.equal(j.today, '2026-11-09');
  assert.equal(j.nowMinutes, 600);
  assert.equal('requisites' in j, false);
  assert.equal('googleCalendarId' in j, false);
  await s.close();
});

test('POST /api/book: 201, затем слот занят в /api/slots, повтор даёт 409', async () => {
  const s = await start();
  const r = await post(s.base + '/api/book', body());
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.total, 2000);
  assert.ok(j.requisites.recipient);

  const slots = await (await fetch(s.base + '/api/slots?from=2026-11-13&to=2026-11-13')).json();
  assert.deepEqual(slots.busy['2026-11-13'], [18, 19]);

  const again = await post(s.base + '/api/book', body({ name: 'Борис', email: 'b@example.com' }));
  assert.equal(again.status, 409);
  await s.close();
});

test('POST /api/book: ошибки формы приходят по полям, плохой JSON и тип ловятся', async () => {
  const s = await start();
  const r = await post(s.base + '/api/book', body({ name: '', email: 'x' }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.ok(j.fields.name && j.fields.email);

  const bad = await fetch(s.base + '/api/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  const wrongType = await fetch(s.base + '/api/book', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(wrongType.status, 415);
  await s.close();
});

test('DELETE /api/book/:code: отмена по секрету', async () => {
  const s = await start();
  const j = await (await post(s.base + '/api/book', body())).json();
  assert.equal((await fetch(`${s.base}/api/book/${j.code}?token=${'0'.repeat(24)}`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${s.base}/api/book/${j.code}?token=${j.token}`, { method: 'DELETE' })).status, 200);
  const slots = await (await fetch(s.base + '/api/slots?from=2026-11-13&to=2026-11-13')).json();
  assert.deepEqual(slots.busy['2026-11-13'], []);
  await s.close();
});

test('dev: имитация зелёного события подтверждает оплату', async () => {
  const s = await start();
  const j = await (await post(s.base + '/api/book', body())).json();
  const r = await fetch(`${s.base}/api/dev/mark-paid/${j.code}`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).sweep.paid, 1);
  await s.close();
});

test('сайт: главная отдаётся, 404 со своей страницей', async () => {
  const s = await start();
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /Аренда зала 55/);
  const nf = await fetch(s.base + '/net-takoj-stranicy');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Такой страницы нет/);
  await s.close();
});

test('безопасность: код сервера, .env и выход из public недоступны', async () => {
  const s = await start();
  for (const p of ['/server/index.js', '/.env', '/package.json', '/docs/scheme-and-wireframe.html']) {
    assert.equal((await fetch(s.base + p)).status, 404, p);
  }
  for (const p of ['/../.env', '/..%2f.env', '/%2e%2e/package.json', '/css/..%2f..%2fpackage.json']) {
    const code = await raw(s.base, p);
    assert.ok(code === 403 || code === 404, `${p} → ${code}`);
  }
  await s.close();
});

test('лимиты: после 6 заявок за 10 минут с одного адреса приходит 429', async () => {
  const s = await start();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(s.base + '/api/book', body({ name: '' }))).status);
  assert.deepEqual(codes.slice(0, 6), [400, 400, 400, 400, 400, 400]);
  assert.equal(codes[6], 429);
  await s.close();
});

test('лимитчик: окно скользит', () => {
  const allow = createRateLimiter();
  assert.equal(allow('k', 2, 1000, 0), true);
  assert.equal(allow('k', 2, 1000, 100), true);
  assert.equal(allow('k', 2, 1000, 200), false);
  assert.equal(allow('k', 2, 1000, 1200), true);
});

test('страницы 152-ФЗ: /privacy и /consent открываются без .html', async () => {
  const s = await start();
  try {
    for (const [p, h] of [['/privacy', 'Политика обработки персональных данных'], ['/consent', 'Согласие на обработку персональных данных'], ['/privacy.html', 'Политика']]) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 200, p);
      assert.ok((await r.text()).includes(h), p);
    }
    assert.equal((await fetch(s.base + '/nope')).status, 404);
  } finally { await s.close(); }
});

test('POST /api/book без согласия на обработку персональных данных — 400 по полю pdConsent', async () => {
  const s = await start();
  try {
    const r = await post(`${s.base}/api/book`, body({ pdConsent: false }));
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.ok(j.fields && j.fields.pdConsent, JSON.stringify(j));
    assert.ok(!j.fields.consent);
  } finally { await s.close(); }
});

test('152-ФЗ: шрифты и карта свои — страницы не грузят Google Fonts и OpenStreetMap', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/privacy', '/consent', '/nope']) {
      const html = await (await fetch(s.base + p)).text();
      assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), p);
      assert.ok(!/<iframe[^>]+openstreetmap\.org/.test(html), p + ': карта должна быть своей картинкой');
    }
    const css = await fetch(s.base + '/css/fonts.css');
    assert.equal(css.status, 200);
    const font = await fetch(s.base + '/fonts/great-vibes-logo-normal-400.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
  } finally { await s.close(); }
});

test('POST /api/book: почта необязательна, но если указана — проверяется', async () => {
  const s = await start();
  try {
    const ok = await post(`${s.base}/api/book`, body({ email: '' }));
    assert.equal(ok.status, 201);
    const bad = await post(`${s.base}/api/book`, body({ email: 'не-почта', hours: [12] }));
    assert.equal(bad.status, 400);
    assert.ok((await bad.json()).fields.email);
  } finally { await s.close(); }
});

'use strict';
/* Личный кабинет: вход и регистрация по коду из письма, cookie сессии, что видно в кабинете. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { createAuthService } = require('../server/auth');
const { createJsonStore } = require('../server/store');
const { makeEnv, NOW } = require('./helpers');

const SECRET = 'x'.repeat(64);

function setup(clock = { now: NOW }) {
  const env = makeEnv();
  const mails = [];
  const notify = { loginCode: async (email, b) => mails.push({ email, ...b }) };
  const accounts = createJsonStore(null);
  const subsStore = createJsonStore(null);
  const auth = createAuthService({ cfg: env.cfg, secret: SECRET, accounts, notify, calendar: env.calendar, booking: env.booking, subsStore, now: () => clock.now, log: { error() {} } });
  return { ...env, auth, mails, accounts, subsStore, clock };
}
const cookieHeader = (cookies) => cookies.map((c) => c.split(';')[0]).join('; ');

test('регистрация: письмо с кодом, по коду создаётся аккаунт и ставится cookie сессии', async () => {
  const s = setup();
  const r = await s.auth.requestCode({ email: '  Anna@Example.com ' });
  assert.equal(r.email, 'anna@example.com');
  assert.equal(s.mails.length, 1);
  assert.equal(s.mails[0].email, 'anna@example.com');
  assert.match(s.mails[0].code, /^\d{6}$/);
  assert.equal(s.mails[0].minutes, 10);
  assert.equal(s.mails[0].isNew, true);
  const code = s.mails[0].code;
  const v = s.auth.verify({ email: 'ANNA@example.com', code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });
  assert.equal(v.body.isNew, true);
  assert.ok(s.accounts.get('anna@example.com'));
  const [sess, flag] = v.cookies;
  assert.match(sess, /^az55_session=[^;]+; HttpOnly; Path=\/; Max-Age=2592000; SameSite=Lax/);
  assert.match(flag, /^az55_in=1; Path=\//);
  assert.equal(s.auth.sessionEmail(cookieHeader(v.cookies)), 'anna@example.com');
  // второй вход — уже не регистрация
  await s.auth.requestCode({ email: 'anna@example.com' });
  assert.equal(s.mails[1].isNew, false);
});

test('код: срабатывает один раз, живёт 10 минут, 5 попыток, новый код отменяет прежний', async () => {
  const s = setup();
  const last = () => s.mails[s.mails.length - 1].code;
  await s.auth.requestCode({ email: 'anna@example.com' });
  const code = last();
  s.auth.verify({ email: 'anna@example.com', code });
  assert.throws(() => s.auth.verify({ email: 'anna@example.com', code }), (e) => e.code === 'code_expired');
  // срок
  await s.auth.requestCode({ email: 'anna@example.com' });
  s.clock.now = new Date(NOW.getTime() + 11 * 60000);
  assert.throws(() => s.auth.verify({ email: 'anna@example.com', code: last() }), (e) => e.code === 'code_expired');
  // на почту без запрошенного кода войти нельзя
  assert.throws(() => s.auth.verify({ email: 'nobody@example.com', code: '123456' }), (e) => e.code === 'code_expired');
  // 5 неверных попыток — код сгорает, даже верный больше не подходит
  await s.auth.requestCode({ email: 'vera@example.com' });
  const right = last();
  const wrong = right === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) assert.throws(() => s.auth.verify({ email: 'vera@example.com', code: wrong }), (e) => e.code === 'bad_code' && e.message.includes(String(5 - i)));
  assert.throws(() => s.auth.verify({ email: 'vera@example.com', code: wrong }), (e) => e.code === 'code_expired');
  assert.throws(() => s.auth.verify({ email: 'vera@example.com', code: right }), (e) => e.code === 'code_expired');
  // новый код отменяет прежний
  await s.auth.requestCode({ email: 'gleb@example.com' });
  const old = last();
  await s.auth.requestCode({ email: 'gleb@example.com' });
  const fresh = last();
  if (old !== fresh) assert.throws(() => s.auth.verify({ email: 'gleb@example.com', code: old }), (e) => e.code === 'bad_code');
  assert.equal(s.auth.verify({ email: 'gleb@example.com', code: fresh }).body.ok, true);
  // подделанная cookie не проходит
  assert.equal(s.auth.sessionEmail('az55_session=abc.def'), null);
  await assert.rejects(s.auth.requestCode({ email: 'не почта' }), (e) => e.status === 400);
});

test('кабинет: постоянные брони и предстоящие разовые брони только на свою почту', async () => {
  const s = setup();
  const mine = await s.booking.book({ date: '2026-11-13', hours: [18], name: 'Анна', phone: '+7 900 123-45-67', email: 'Anna@example.com', consent: true, pdConsent: true, website: '' });
  await s.booking.book({ date: '2026-11-14', hours: [10], name: 'Борис', phone: '+7 900 000-00-00', email: 'boris@example.com', consent: true, pdConsent: true, website: '' });
  s.subsStore.put({ id: 'SAAAAAA', token: 'a'.repeat(24), status: 'active', email: 'anna@example.com', name: 'Анна Смирнова', phone: '+79001234567', createdAt: NOW.toISOString() });
  s.subsStore.put({ id: 'SBBBBBB', token: 'b'.repeat(24), status: 'active', email: 'boris@example.com', name: 'Борис', createdAt: NOW.toISOString() });
  s.subsStore.put({ id: 'STESTTT', token: 'c'.repeat(24), status: 'active', email: 'anna@example.com', test: true, createdAt: NOW.toISOString() });
  await assert.rejects(s.auth.account(''), (e) => e.status === 401);
  await s.auth.requestCode({ email: 'anna@example.com' });
  const v = s.auth.verify({ email: 'anna@example.com', code: s.mails[0].code });
  const a = await s.auth.account(cookieHeader(v.cookies));
  assert.equal(a.email, 'anna@example.com');
  assert.deepEqual(a.subs, [{ id: 'SAAAAAA', t: 'a'.repeat(24), status: 'active' }]);
  assert.equal(a.bookings.length, 1);
  assert.equal(a.bookings[0].code, mine.code);
  assert.equal(a.bookings[0].status, 'pending');
  assert.equal(a.profile.name, 'Анна Смирнова');
});

test('HTTP: запрос кода, вход, кабинет по cookie, выход; лимит на одну почту', async () => {
  const s = setup();
  const server = createApp({ cfg: s.cfg, booking: s.booking, calendar: s.calendar, auth: s.auth, now: () => NOW, log: { error() {}, log() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(b || {}) });
  try {
    assert.equal((await fetch(base + '/api/account')).status, 401);
    assert.equal((await post('/api/auth/request', { email: 'anna@example.com' })).status, 200);
    assert.equal((await post('/api/auth/verify', { email: 'anna@example.com', code: 'abcdef' })).status, 400);
    const v = await post('/api/auth/verify', { email: 'anna@example.com', code: s.mails[0].code });
    assert.equal(v.status, 200);
    const cookies = v.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    const acc = await fetch(base + '/api/account', { headers: { Cookie: cookieHeader(cookies) } });
    assert.equal(acc.status, 200);
    assert.equal((await acc.json()).email, 'anna@example.com');
    const out = await post('/api/auth/logout');
    assert.ok(out.headers.getSetCookie().every((c) => /Max-Age=0/.test(c)));
    // письма на одну почту — не чаще 3 за 10 минут
    await post('/api/auth/request', { email: 'spam@example.com' });
    await post('/api/auth/request', { email: 'spam@example.com' });
    await post('/api/auth/request', { email: 'spam@example.com' });
    assert.equal((await post('/api/auth/request', { email: 'spam@example.com' })).status, 429);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

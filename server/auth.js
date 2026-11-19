'use strict';
/*
 * Личный кабинет: вход и регистрация по почте, без паролей.
 *
 *  1. Клиент вводит почту → сайт присылает ссылку для входа (живёт LOGIN_MINUTES минут, срабатывает один раз).
 *  2. Ссылка открывает кабинет: при первом входе аккаунт создаётся сам (это и есть регистрация),
 *     в браузер ставится cookie сессии на SESSION_DAYS дней (HttpOnly, подписана секретом сервера).
 *  3. В кабинете видны постоянные брони и предстоящие разовые брони на эту почту.
 *
 * Ссылка и cookie — подписанные HMAC строки, базы сессий нет. Аккаунты лежат в data/accounts.json.
 */
const crypto = require('node:crypto');
const { AppError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE = 'az55_session';
const FLAG = 'az55_in';            // не HttpOnly: странице видно, что вход выполнен (значок в шапке, подстановка почты)
const b64 = (s) => Buffer.from(s).toString('base64url');

function createAuthService({ cfg, secret, accounts, notify, calendar, booking, subsStore, now = () => new Date(), log = console }) {
  if (!secret || secret.length < 32) throw new Error('Нужен секрет для входа в кабинет (AUTH_SECRET или data/auth-secret)');
  const A = cfg.auth;
  const used = new Map();          // одноразовые ссылки: nonce → когда истекает

  const sign = (payload) => {
    const body = b64(JSON.stringify(payload));
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`;
  };
  function unsign(token, purpose) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest();
    let got;
    try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    if (!p || p.p !== purpose || typeof p.e !== 'string' || !(p.x > now().getTime())) return null;
    return p;
  }

  const normEmail = (s) => String(s || '').trim().toLowerCase();
  const secure = /^https:/i.test(cfg.baseUrl);
  const cookieAttrs = (maxAge) => `Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? '; Secure' : ''}`;

  /** Шаг 1: прислать ссылку для входа */
  async function requestLink(input) {
    const email = normEmail(input && input.email);
    if (!EMAIL_RE.test(email) || email.length > 120) throw new AppError(400, 'validation', 'Проверьте почту, например name@mail.ru', { email: 'Проверьте почту' });
    const token = sign({ p: 'login', e: email, x: now().getTime() + A.loginMinutes * 60000, n: crypto.randomBytes(9).toString('base64url') });
    const url = `${cfg.baseUrl.replace(/\/$/, '')}/subscription?login=${token}`;
    await notify.loginLink(email, { url, minutes: A.loginMinutes, isNew: !accounts.get(email) });
    return { ok: true, email };
  }

  /** Шаг 2: ссылка из письма → аккаунт (создаётся при первом входе) и cookie сессии */
  function verify(input) {
    const p = unsign(input && input.token, 'login');
    if (!p) throw new AppError(400, 'bad_link', 'Ссылка для входа устарела или уже использована. Запросите новую.');
    const t = now().getTime();
    for (const [n, x] of used) if (x < t) used.delete(n);
    if (used.has(p.n)) throw new AppError(400, 'bad_link', 'Ссылка для входа устарела или уже использована. Запросите новую.');
    used.set(p.n, p.x);
    const at = now().toISOString();
    const acc = accounts.get(p.e) || { id: p.e, email: p.e, createdAt: at };
    const isNew = !acc.lastLoginAt;
    acc.lastLoginAt = at;
    accounts.put(acc);
    const maxAge = A.sessionDays * 86400;
    const session = sign({ p: 'session', e: p.e, x: t + maxAge * 1000 });
    return {
      body: { ok: true, email: p.e, isNew },
      cookies: [`${COOKIE}=${session}; HttpOnly; ${cookieAttrs(maxAge)}`, `${FLAG}=1; ${cookieAttrs(maxAge)}`],
    };
  }

  function logoutCookies() {
    return [`${COOKIE}=; HttpOnly; ${cookieAttrs(0)}`, `${FLAG}=; ${cookieAttrs(0)}`];
  }

  /** Почта из cookie сессии или null */
  function sessionEmail(cookieHeader) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String(cookieHeader || ''));
    const p = m && unsign(m[1], 'session');
    return p && accounts.get(p.e) ? p.e : null;
  }

  /** Что видно в кабинете: постоянные брони и предстоящие разовые брони на эту почту */
  async function account(cookieHeader) {
    const email = sessionEmail(cookieHeader);
    if (!email) throw new AppError(401, 'auth', 'Войдите в личный кабинет');
    const STATUS_ORDER = { active: 0, pending: 1, paused: 2, cancelled: 3 };
    const subs = (subsStore ? subsStore.all() : [])
      .filter((s) => normEmail(s.email) === email && !s.test)
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((s) => ({ id: s.id, t: s.token, status: s.status }));

    let bookings = [];
    let profile = {};
    try {
      const from = now();
      const to = new Date(from.getTime() + (cfg.horizonDays + 1) * 86400000);
      const evs = (await calendar.listBookings(from, to)).filter((e) => normEmail(e.private.email) === email && !e.private.sub);
      const byCode = new Map();
      for (const e of evs) { const c = e.private.code; if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(e); }
      bookings = [...byCode.values()].map((list) => {
        const d = booking._internal.describe(list);
        profile = { name: d.name, phone: d.phone };
        return { code: d.code, when: d.whenLabel, total: d.total, status: list.every((e) => e.private.status === 'paid') ? 'paid' : 'pending', start: +new Date(d.start) };
      }).sort((a, b) => a.start - b.start).map(({ start, ...b }) => b);
    } catch (e) {
      log.error('[auth] брони для кабинета:', e.message);
    }
    const last = subsStore && subsStore.all().filter((s) => normEmail(s.email) === email && !s.test)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (last) profile = { name: last.name, phone: last.phone };
    return { email, profile, subs, bookings };
  }

  return { requestLink, verify, logoutCookies, sessionEmail, account, COOKIE };
}

/** Секрет подписи: AUTH_SECRET из .env или файл data/auth-secret (создаётся сам при первом запуске) */
function loadSecret(cfg, fs = require('node:fs'), path = require('node:path')) {
  if (cfg.auth.secret) return cfg.auth.secret;
  const file = cfg.auth.secretFile;
  try { return fs.readFileSync(file, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

module.exports = { createAuthService, loadSecret };

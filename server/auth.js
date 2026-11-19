'use strict';
/*
 * Личный кабинет: вход и регистрация по почте, без паролей.
 *
 *  1. Клиент вводит почту → сайт присылает 6-значный код (живёт LOGIN_CODE_MINUTES минут). Почту можно
 *     открыть на телефоне, а код ввести на компьютере.
 *  2. Код верный → при первом входе аккаунт создаётся сам (это и есть регистрация), в браузер ставится
 *     cookie сессии на SESSION_DAYS дней (HttpOnly, подписана секретом сервера).
 *  3. В кабинете видны постоянные брони и предстоящие разовые брони на эту почту.
 *
 * Коды живут в памяти процесса (хранится только хэш), на один код 5 попыток. Новый код отменяет прежний.
 * Cookie — подписанная HMAC строка, базы сессий нет. Аккаунты лежат в data/accounts.json.
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
  const codes = new Map();         // почта → { hash, until, tries }
  const MAX_TRIES = 5;
  const hashCode = (email, code) => crypto.createHmac('sha256', secret).update(`code:${email}:${code}`).digest();

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

  /** Шаг 1: прислать код для входа */
  async function requestCode(input) {
    const email = normEmail(input && input.email);
    if (!EMAIL_RE.test(email) || email.length > 120) throw new AppError(400, 'validation', 'Проверьте почту, например name@mail.ru', { email: 'Проверьте почту' });
    const t = now().getTime();
    for (const [e, x] of codes) if (x.until < t) codes.delete(e);
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    codes.set(email, { hash: hashCode(email, code), until: t + A.codeMinutes * 60000, tries: 0 });
    await notify.loginCode(email, { code, minutes: A.codeMinutes, isNew: !accounts.get(email) });
    return { ok: true, email, minutes: A.codeMinutes };
  }

  /** Шаг 2: почта и код → аккаунт (создаётся при первом входе) и cookie сессии */
  function verify(input) {
    const email = normEmail(input && input.email);
    const code = String((input && input.code) || '').replace(/\D/g, '');
    const rec = codes.get(email);
    const t = now().getTime();
    if (!rec || rec.until < t) { codes.delete(email); throw new AppError(400, 'code_expired', 'Код устарел. Запросите новый.'); }
    if (code.length !== 6 || !crypto.timingSafeEqual(hashCode(email, code), rec.hash)) {
      rec.tries++;
      const left = MAX_TRIES - rec.tries;
      if (left <= 0) { codes.delete(email); throw new AppError(400, 'code_expired', 'Слишком много неверных попыток. Запросите новый код.'); }
      throw new AppError(400, 'bad_code', `Неверный код. Осталось попыток: ${left}.`, { code: 'Неверный код' });
    }
    codes.delete(email);
    const at = now().toISOString();
    const acc = accounts.get(email) || { id: email, email, createdAt: at };
    const isNew = !acc.lastLoginAt;
    acc.lastLoginAt = at;
    accounts.put(acc);
    const maxAge = A.sessionDays * 86400;
    const session = sign({ p: 'session', e: email, x: t + maxAge * 1000 });
    return {
      body: { ok: true, email, isNew },
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

  return { requestCode, verify, logoutCookies, sessionEmail, account, COOKIE };
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

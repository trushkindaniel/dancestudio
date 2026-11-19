'use strict';
/* HTTP: API записи + раздача статического сайта из папки public. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');
const { publicConfig, root } = require('./config');
const T = require('./time');
const { PAYMENT_ID_RE } = require('./payments');


const PUBLIC_DIR = path.join(root, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function createRateLimiter() {
  const hits = new Map();
  return function allow(key, limit, windowMs, nowMs = Date.now()) {
    const arr = (hits.get(key) || []).filter((t) => nowMs - t < windowMs);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(nowMs);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || nowMs - v[v.length - 1] > windowMs) hits.delete(k);
    return true;
  };
}

function readJson(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new AppError(415, 'bad_type', 'Ожидается JSON'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new AppError(413, 'too_big', 'Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new AppError(400, 'bad_json', 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(payload);
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  // скрытые папки и файлы (.taste-skill, .env и т.п.) наружу не отдаём
  if (rel.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (rel.endsWith('/')) rel += 'index.html';
  else if (!path.extname(rel)) rel += '.html'; // /privacy → privacy.html
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const nf = path.join(PUBLIC_DIR, '404.html');
      return fs.readFile(nf, (e2, data) => {
        if (e2) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        send(res, 404, data, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
      });
    }
    const ext = path.extname(file).toLowerCase();
    const cache = ['.css', '.js', '.html'].includes(ext) ? 'no-cache' : 'public, max-age=86400';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createApp({ cfg, booking, calendar, payments = null, subs = null, now = () => new Date(), log = console, trustProxy = false }) {
  const allow = createRateLimiter();

  const clientIp = (req) => {
    if (trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const ip = clientIp(req);

    if (req.method === 'GET' && pathname === '/api/config') {
      const t = T.nowInTz(now(), cfg.tz);
      return send(res, 200, { ...publicConfig(cfg), today: t.date, nowMinutes: t.minutes });
    }

    if (req.method === 'GET' && pathname === '/api/slots') {
      if (!allow(`slots:${ip}`, 120, 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много запросов, подождите минуту');
      const busy = await booking.getBusy(url.searchParams.get('from') || '', url.searchParams.get('to') || '');
      return send(res, 200, { busy });
    }

    if (req.method === 'POST' && pathname === '/api/book') {
      if (!allow(`book:${ip}`, 6, 10 * 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много попыток, попробуйте через несколько минут');
      const body = await readJson(req);
      return send(res, 201, await booking.book(body));
    }

    // Клиент вернулся со страницы оплаты и спрашивает, что с бронью
    const st = req.method === 'GET' && /^\/api\/book\/([A-Za-z0-9]{4})$/.exec(pathname);
    if (st) {
      if (!allow(`status:${ip}`, 60, 10 * 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много запросов');
      return send(res, 200, await booking.status(st[1].toUpperCase(), url.searchParams.get('token') || ''));
    }

    // «Оплатить по СБП»: платёж СБП и ссылка на страницу ЮKassa
    const sbp = req.method === 'POST' && /^\/api\/book\/([A-Za-z0-9]{4})\/sbp$/.exec(pathname);
    if (sbp) {
      if (!allow(`sbp:${ip}`, 10, 10 * 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много попыток');
      return send(res, 200, await booking.payBySbp(sbp[1].toUpperCase(), url.searchParams.get('token') || ''));
    }

    // Уведомление ЮKassa. Телу не доверяем: берём только id платежа и спрашиваем статус у API.
    if (req.method === 'POST' && pathname === '/api/payments/yookassa') {
      if (!allow(`hook:${ip}`, 300, 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много запросов');
      const body = await readJson(req, 64_000);
      const id = body && body.object && body.object.id;
      if (!payments || !PAYMENT_ID_RE.test(String(id || ''))) return send(res, 200, { ok: true, ignored: true });
      const result = await booking.syncPayment(String(id)); // сбой API → 500, и ЮKassa пришлёт уведомление повторно
      return send(res, 200, { ok: true, result });
    }

    // Постоянная бронь: просмотр и отмена по ссылке из письма
    const sv = /^\/api\/sub\/(S[A-Z2-9]{6})(\/cancel|\/card\/bind|\/card\/unbind|\/pay)?$/.exec(pathname);
    if (sv && subs) {
      if (!allow(`sub:${ip}`, 60, 10 * 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много запросов');
      const t = url.searchParams.get('t') || '';
      if (req.method === 'GET' && !sv[2]) return send(res, 200, await subs.view(sv[1], t));
      if (req.method === 'POST' && sv[2] === '/pay') return send(res, 200, await subs.payNow(sv[1], t));
      if (req.method === 'POST' && sv[2] === '/cancel') return send(res, 200, await subs.cancel(sv[1], t));
      if (req.method === 'POST' && sv[2] === '/card/unbind') return send(res, 200, await subs.unbindCard(sv[1], t));
      if (req.method === 'POST' && sv[2] === '/card/bind') return send(res, 200, await subs.startBind(sv[1], t));
      if (req.method === 'GET' && sv[2] === '/card/bind') return send(res, 200, await subs.bindStatus(sv[1], t));
    }

    const del = req.method === 'DELETE' && /^\/api\/book\/([A-Za-z0-9]{4})$/.exec(pathname);
    if (del) {
      if (!allow(`cancel:${ip}`, 20, 10 * 60_000)) throw new AppError(429, 'rate_limit', 'Слишком много попыток');
      return send(res, 200, await booking.cancel(del[1].toUpperCase(), url.searchParams.get('token') || ''));
    }

    // Только для разработки: «администратор покрасил событие в зелёный» без настоящего Google
    const dev = req.method === 'POST' && /^\/api\/dev\/mark-paid\/([A-Za-z0-9]{4})$/.exec(pathname);
    if (dev && calendar.driver === 'memory' && !cfg.isProduction) {
      const ev = await calendar.findByCode(dev[1].toUpperCase());
      if (!ev) throw new AppError(404, 'not_found', 'Бронь не найдена');
      calendar._paint(ev.id, cfg.paidColorId);
      return send(res, 200, { sweep: await booking.sweep() });
    }

    // Только для разработки: имитация оплаты в виджете ЮKassa (кнопки «Оплатить» / «Отказаться» на странице)
    const fake = req.method === 'POST' && /^\/api\/dev\/pay\/(fake-[0-9a-f]{20})$/.exec(pathname);
    if (fake && payments && payments.provider === 'fake' && !cfg.isProduction) {
      if (!payments._get(fake[1])) throw new AppError(404, 'not_found', 'Платёж не найден');
      payments._set(fake[1], url.searchParams.get('result') === 'succeeded' ? 'succeeded' : 'canceled');
      return send(res, 200, { result: await booking.syncPayment(fake[1]) }); // так же, как при уведомлении от ЮKassa
    }

    throw new AppError(404, 'not_found', 'Неизвестный адрес API');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof AppError) return send(res, e.status, { error: e.code, message: e.message, fields: e.fields });
      log.error('[server]', e);
      return send(res, 500, { error: 'internal', message: 'Что-то пошло не так, попробуйте позже' });
    }
  });
}

module.exports = { createApp, createRateLimiter };

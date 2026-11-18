'use strict';
/* Онлайн-оплата через виджет ЮKassa (платёж с confirmation.type = embedded, форма оплаты прямо на сайте).
   yookassa: настоящий API ЮKassa (v3). fake: имитация для разработки.
   Статус платежа всегда берём запросом к API. Уведомлению (webhook) не доверяем: его может прислать кто угодно. */
const crypto = require('node:crypto');

const API = 'https://api.yookassa.ru/v3';
const PAYMENT_ID_RE = /^[0-9a-z-]{20,64}$/i;

const money = (rub) => ({ value: Number(rub).toFixed(2), currency: 'RUB' });
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** «8 (913) 658-19-00» → «79136581900» */
function ruPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return d;
}

function normalize(p) {
  return {
    id: p.id,
    status: p.status, // pending | waiting_for_capture | succeeded | canceled
    amount: p.amount ? Number(p.amount.value) : 0,
    metadata: p.metadata || {},
    // одноразовый токен для виджета, живёт 1 час
    confirmationToken: p.confirmation && p.confirmation.confirmation_token,
  };
}

/** Тело платежа. Общее для настоящего API и имитации, чтобы тесты видели то же, что уйдёт в ЮKassa. */
function paymentBody(cfg, b) {
  const description = cut(`Аренда зала, бронь ${b.code}: ${b.dateLabel}, ${b.timeLabel}`, 128);
  const body = {
    amount: money(b.total),
    capture: true,
    confirmation: { type: 'embedded' },
    description,
    metadata: { code: b.code, date: b.date, hours: b.hours },
  };
  if (cfg.payment.receipt) {
    body.receipt = {
      // чек приходит на почту, а если её нет — СМС на телефон (формат ЮKassa: 79001234567)
      customer: b.email ? { email: b.email } : { phone: ruPhone(b.phone) },
      items: [{
        description: cut(`Аренда танцевального зала, ${b.hoursCount} ч (бронь ${b.code})`, 128),
        quantity: '1.00',
        amount: money(b.total),
        vat_code: cfg.payment.vatCode,
        payment_mode: 'full_payment',
        payment_subject: 'service',
      }],
    };
  }
  return body;
}

function createYooKassa(cfg, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const auth = 'Basic ' + Buffer.from(`${cfg.payment.shopId}:${cfg.payment.secretKey}`).toString('base64');

  async function call(method, path, body, idempotenceKey) {
    const headers = { Authorization: auth, 'Content-Type': 'application/json' };
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
    const res = await fetchFn(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`ЮKassa ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }

  return {
    provider: 'yookassa',
    // Ключ идемпотентности привязан к брони: повтор запроса не создаст второй платёж
    async createPayment(b) { return normalize(await call('POST', '/payments', paymentBody(cfg, b), b.idempotenceKey || `pay-${b.code}`)); },
    async getPayment(id) {
      if (!PAYMENT_ID_RE.test(String(id))) throw new Error('Некорректный id платежа');
      return normalize(await call('GET', `/payments/${encodeURIComponent(id)}`));
    },
    async refund(id, amount, reason) {
      const r = await call('POST', '/refunds', { payment_id: id, amount: money(amount), description: cut(reason, 250) }, `refund-${id}`);
      return { id: r.id, status: r.status };
    },
  };
}

/** Имитация ЮKassa: токен равен id платежа, браузер «платит» запросом POST /api/dev/pay/:id. */
function createFakePayments(cfg) {
  const payments = new Map();
  const refunds = [];
  return {
    provider: 'fake',
    async createPayment(b) {
      const id = `fake-${crypto.randomBytes(10).toString('hex')}`;
      const body = paymentBody(cfg, b);
      payments.set(id, { id, status: 'pending', amount: body.amount, metadata: body.metadata, body, confirmation: { type: 'embedded', confirmation_token: id } });
      return normalize(payments.get(id));
    },
    async getPayment(id) {
      const p = payments.get(id);
      if (!p) throw new Error('Платёж не найден');
      return normalize(p);
    },
    async refund(id, amount, reason) {
      refunds.push({ id, amount, reason });
      return { id: `refund-${id}`, status: 'succeeded' };
    },
    /** Только для разработки и тестов */
    _set(id, status) { const p = payments.get(id); if (p) p.status = status; return p; },
    _get: (id) => payments.get(id),
    _refunds: refunds,
  };
}

function createPayments(cfg, deps) {
  if (cfg.payment.provider === 'yookassa') return createYooKassa(cfg, deps);
  if (cfg.payment.provider === 'fake') return createFakePayments(cfg);
  return null; // transfer: оплата переводом, подтверждает администратор цветом события
}

module.exports = { createPayments, createYooKassa, createFakePayments, paymentBody, PAYMENT_ID_RE };

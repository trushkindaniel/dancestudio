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
    // СБП: ссылка на страницу ЮKassa с QR-кодом и выбором банка
    confirmationUrl: p.confirmation && p.confirmation.confirmation_url,
    // сохранённая карта для автосписаний (постоянная бронь); данных карты здесь нет, только id и подпись
    paymentMethod: p.payment_method ? { id: p.payment_method.id, saved: Boolean(p.payment_method.saved), title: p.payment_method.title || '' } : null,
    cancelReason: p.cancellation_details ? p.cancellation_details.reason : '',
  };
}

/** Тело платежа. Общее для настоящего API и имитации, чтобы тесты видели то же, что уйдёт в ЮKassa. */
function paymentBody(cfg, b) {
  const description = cut(b.description || `Аренда зала, бронь ${b.code}: ${b.dateLabel}, ${b.timeLabel}`, 128);
  const body = {
    amount: money(b.total),
    capture: true,
    confirmation: { type: 'embedded' },
    description,
    metadata: { code: b.code, date: b.date, hours: b.hours },
  };
  // постоянная бронь: первая оплата сохраняет карту, следующие списываются с неё без участия клиента
  if (b.savePaymentMethod) body.save_payment_method = true;
  if (b.paymentMethodId) { delete body.confirmation; body.payment_method_id = b.paymentMethodId; }
  if (b.sub) body.metadata.sub = b.sub;
  if (b.week !== undefined && b.week !== null) body.metadata.week = String(b.week);
  if (cfg.payment.receipt) {
    body.receipt = {
      // чек приходит на почту, а если её нет — СМС на телефон (формат ЮKassa: 79001234567)
      customer: b.email ? { email: b.email } : { phone: ruPhone(b.phone) },
      items: [{
        description: cut(b.receiptText || `Аренда танцевального зала, ${b.hoursCount} ч (бронь ${b.code})`, 128),
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

/** Платёж через СБП: сразу на страницу ЮKassa с QR-кодом и списком банков, потом обратно на сайт */
function sbpBody(cfg, b) {
  const body = paymentBody(cfg, b);
  body.confirmation = { type: 'redirect', return_url: b.returnUrl };
  body.payment_method_data = { type: 'sbp' };
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
    async createSbpPayment(b) { return normalize(await call('POST', '/payments', sbpBody(cfg, b), b.idempotenceKey)); },
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
  let autopay = 'succeeded';                         // чем закончится следующее автосписание (для тестов)
  let noSave = false;                                // карту не удалось сохранить (автоплатежи не включены)
  return {
    provider: 'fake',
    async createPayment(b) {
      const id = `fake-${crypto.randomBytes(10).toString('hex')}`;
      const body = paymentBody(cfg, b);
      const p = { id, status: 'pending', amount: body.amount, metadata: body.metadata, body, confirmation: { type: 'embedded', confirmation_token: id } };
      if (b.paymentMethodId) {                       // автосписание с сохранённой карты: ответ сразу
        delete p.confirmation;
        p.status = autopay;
        p.payment_method = { id: b.paymentMethodId, saved: true, title: 'Bank card *4444' };
        if (autopay === 'canceled') p.cancellation_details = { reason: 'insufficient_funds' };
      }
      payments.set(id, p);
      return normalize(p);
    },
    async createSbpPayment(b) {
      const id = `fake-${crypto.randomBytes(10).toString('hex')}`;
      const body = sbpBody(cfg, b);
      // имитация: «страница ЮKassa» — это возврат на сайт с кнопками «Оплатить» / «Отказаться»
      const p = { id, status: 'pending', amount: body.amount, metadata: body.metadata, body, confirmation: { type: 'redirect', confirmation_url: `${b.returnUrl.replace('#booking', '')}&fakepay=${id}#booking` } };
      payments.set(id, p);
      return normalize(p);
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
    _set(id, status) {
      const p = payments.get(id);
      if (!p) return p;
      p.status = status;
      // как ЮKassa: при успешной оплате с save_payment_method карта сохраняется
      if (status === 'succeeded' && p.body.save_payment_method && !p.payment_method) p.payment_method = { id: `pm-${id}`, saved: !noSave, title: 'Bank card *4444' };
      return p;
    },
    _autopay(status) { autopay = status; },
    _noSave(v) { noSave = v; },
    _get: (id) => payments.get(id),
    _refunds: refunds,
  };
}

function createPayments(cfg, deps) {
  if (cfg.payment.provider === 'yookassa') return createYooKassa(cfg, deps);
  if (cfg.payment.provider === 'fake') return createFakePayments(cfg);
  return null; // transfer: оплата переводом, подтверждает администратор цветом события
}

module.exports = { createPayments, createYooKassa, createFakePayments, paymentBody, sbpBody, PAYMENT_ID_RE };

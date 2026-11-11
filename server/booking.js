'use strict';
/* Бизнес-логика: свободные слоты, бронь, отмена, подтверждение оплаты (ЮKassa или цвет события). */
const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { validateBooking } = require('./validate');
const { priceFor } = require('./pricing');
const T = require('./time');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-Z2-9]{4}$/;
const TOKEN_RE = /^[0-9a-f]{24}$/;

const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const dateLabelOf = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return dateFmt.format(new Date(Date.UTC(y, m - 1, d)));
};

/**
 * @param payments null для оплаты переводом, иначе createPayments(...) (ЮKassa или имитация)
 */
function createBookingService({ calendar, cfg, notify, payments = null, now = () => new Date(), log = console }) {
  // Двое могут нажать «Забронировать» одновременно, а уведомление ЮKassa может прийти одновременно с фоновой проверкой.
  // Всё, что меняет брони, выполняем по очереди. Работает, пока сервер запущен в одном экземпляре.
  let chain = Promise.resolve();
  const withLock = (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  };

  function labels(date, firstHour, lastHour) {
    return { dateLabel: dateLabelOf(date), timeLabel: `${T.hhmm(firstHour)}–${T.hhmm(lastHour + 1)}` };
  }

  function describe(p) {
    const [a, b] = String(p.hours || '0-0').split('-').map(Number);
    return {
      code: p.code, name: p.name, email: p.email, phone: p.phone, total: Number(p.total),
      ...labels(p.date, a, b),
    };
  }

  async function getBusy(from, to) {
    if (!T.isDateKey(from) || !T.isDateKey(to)) throw new AppError(400, 'bad_range', 'Нужны даты from и to вида ГГГГ-ММ-ДД');
    const span = T.daysBetween(from, to);
    if (span < 0 || span >= cfg.maxSlotsRangeDays) throw new AppError(400, 'bad_range', `Диапазон не больше ${cfg.maxSlotsRangeDays} дней`);

    const busy = await calendar.listBusy(T.zonedToUtc(from, 0, cfg.tz), T.zonedToUtc(T.addDays(to, 1), 0, cfg.tz));
    const result = {};
    for (let i = 0; i <= span; i++) {
      const d = T.addDays(from, i);
      result[d] = [];
      for (let h = cfg.openHour; h < cfg.closeHour; h++) {
        const s = T.zonedToUtc(d, h, cfg.tz);
        const e = T.zonedToUtc(d, h + 1, cfg.tz);
        if (busy.some((b) => b.start < e && b.end > s)) result[d].push(h);
      }
    }
    return result;
  }

  async function uniqueCode() {
    for (let i = 0; i < 8; i++) {
      let code = '';
      for (const byte of crypto.randomBytes(4)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (!(await calendar.findByCode(code))) return code;
    }
    throw new AppError(503, 'busy', 'Не удалось создать код брони, попробуйте ещё раз');
  }

  const fmtDeadline = (d) => d.toLocaleString('ru-RU', { timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' });

  async function book(input) {
    const v = validateBooking(input, cfg, now());
    return withLock(async () => {
      const busy = (await getBusy(v.date, v.date))[v.date];
      if (v.hours.some((h) => busy.includes(h))) throw new AppError(409, 'slot_taken', 'Это время только что заняли, выберите другое');

      const first = v.hours[0];
      const last = v.hours[v.hours.length - 1];
      const { total } = priceFor(v.hours, cfg);
      const code = await uniqueCode();
      const token = crypto.randomBytes(12).toString('hex');
      const deadline = new Date(now().getTime() + cfg.holdMinutes * 60000);
      const lb = labels(v.date, first, last);
      const online = Boolean(payments);

      const howToConfirm = online
        ? ['Оплата онлайн через виджет ЮKassa на сайте. Когда платёж пройдёт, сайт сам покрасит событие в зелёный и напишет клиенту.',
          `Если оплаты не будет до ${deadline.toISOString()}, событие удалится само.`]
        : ['Оплата пришла? Покрасьте это событие в зелёный цвет («Базилик»). Сайт сам подтвердит бронь и напишет клиенту.',
          `Если оплаты не будет до ${deadline.toISOString()}, событие удалится само.`];

      const priv = {
        managed: '1', code, status: 'pending', token, date: v.date, hours: `${first}-${last}`,
        name: v.name, phone: v.phone, email: v.email, total: String(total), expiresAt: deadline.toISOString(),
        pay: online ? payments.provider : 'transfer',
      };

      const created = await calendar.createEvent({
        summary: `⏳ ${code} · ${v.name} · ${lb.timeLabel} · ${total} ₽`,
        description: [
          `Бронь ${code}: ${lb.dateLabel}, ${lb.timeLabel}`,
          `Клиент: ${v.name}`, `Телефон: ${v.phone}`, `Почта: ${v.email}`,
          v.purposeLabel ? `Формат: ${v.purposeLabel}` : null,
          v.people ? `Человек: ${v.people}` : null,
          v.note ? `Комментарий: ${v.note}` : null,
          `К оплате: ${total} ₽`,
          '',
          ...howToConfirm,
        ].filter((x) => x !== null).join('\n'),
        colorId: cfg.pendingColorId,
        start: T.zonedToUtc(v.date, first, cfg.tz),
        end: T.zonedToUtc(v.date, last + 1, cfg.tz),
        localStart: T.localDateTime(v.date, first),
        localEnd: T.localDateTime(v.date, last + 1),
        private: priv,
      });

      let confirmationToken = null;
      if (online) {
        try {
          const p = await payments.createPayment({
            code, total, date: v.date, hours: `${first}-${last}`, hoursCount: v.hours.length, email: v.email, ...lb,
            idempotenceKey: `pay-${code}-${deadline.getTime()}`,
          });
          if (!p.confirmationToken) throw new Error('ЮKassa не вернула токен для виджета');
          confirmationToken = p.confirmationToken;
          await calendar.patchEvent(created.id, { private: { ...priv, paymentId: p.id } });
        } catch (e) {
          log.error(`[pay] бронь ${code}: не удалось создать платёж:`, e.message);
          await calendar.deleteEvent(created.id).catch(() => {});
          throw new AppError(502, 'payment_unavailable', 'Платёжный сервис сейчас не отвечает. Попробуйте ещё раз через пару минут.');
        }
      }

      await notify.created({ ...lb, code, name: v.name, phone: v.phone, email: v.email, total, online, purpose: v.purposeLabel, people: v.people, deadlineLabel: fmtDeadline(deadline) });

      const res = { code, token, total, date: v.date, hours: v.hours, deadline: deadline.toISOString(), ...lb };
      if (online) res.payment = { provider: payments.provider, confirmationToken };
      else res.requisites = cfg.requisites;
      return res;
    });
  }

  async function findOwned(code, token) {
    if (!CODE_RE.test(String(code)) || !TOKEN_RE.test(String(token || ''))) return null;
    const ev = await calendar.findByCode(code);
    const ok = ev && ev.private.token && ev.private.token.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(ev.private.token), Buffer.from(token));
    return ok ? ev : null;
  }

  async function cancel(code, token) {
    return withLock(async () => {
      const ev = await findOwned(code, token);
      if (!ev) throw new AppError(404, 'not_found', 'Бронь не найдена');
      if (ev.private.status !== 'pending') throw new AppError(409, 'not_cancellable', 'Оплаченную бронь отменяет администратор, напишите нам');
      await calendar.deleteEvent(ev.id);
      await notify.cancelled(describe(ev.private));
      return { ok: true };
    });
  }

  async function markPaid(ev, extra = {}) {
    await calendar.patchEvent(ev.id, {
      summary: ev.summary.replace('⏳', '✅'),
      colorId: cfg.paidColorId,
      private: { ...ev.private, status: 'paid', paidAt: now().toISOString(), ...extra },
    });
    await notify.paid(describe(ev.private));
  }

  /**
   * Сверяет бронь с платежом в ЮKassa. Вызывается из уведомления ЮKassa, при возврате клиента на сайт и фоновой проверкой.
   * Возвращает, что сделано: paid | released | refunded | waiting | ignored.
   */
  async function syncPayment(paymentId) {
    if (!payments) return 'ignored';
    const p = await payments.getPayment(paymentId);
    const code = String(p.metadata.code || '');
    if (!CODE_RE.test(code)) return 'ignored';

    return withLock(async () => {
      const ev = await calendar.findByCode(code);
      const ours = ev && ev.private.paymentId === p.id;

      if (p.status === 'succeeded') {
        if (ours && ev.private.status === 'paid') return 'paid';
        if (ours && ev.private.status === 'pending' && Number(ev.private.total) === p.amount) {
          await markPaid(ev, { paymentId: p.id });
          return 'paid';
        }
        // Деньги пришли, а брони уже нет (срок вышел, клиент отменил) или сумма не та: возвращаем автоматически
        const reason = `Бронь ${code} снята до поступления оплаты, деньги возвращены`;
        await payments.refund(p.id, p.amount, reason);
        await notify.refunded({ code, total: p.amount, date: p.metadata.date, hours: p.metadata.hours, email: ev && ev.private.email });
        log.log(`[pay] ${reason}`);
        return 'refunded';
      }

      if (p.status === 'canceled') {
        if (ours && ev.private.status === 'pending') {
          await calendar.deleteEvent(ev.id);
          await notify.expired({ ...describe(ev.private), reason: 'payment_canceled' });
          return 'released';
        }
        return 'ignored';
      }

      return 'waiting';
    });
  }

  /** Статус брони для клиента, вернувшегося со страницы оплаты. */
  async function status(code, token) {
    let ev = await findOwned(code, token);
    if (!ev) return { status: 'gone' };
    if (ev.private.status === 'pending' && ev.private.paymentId) {
      try {
        await syncPayment(ev.private.paymentId);
        ev = await findOwned(code, token);
        if (!ev) return { status: 'gone' };
      } catch (e) {
        log.error(`[pay] статус ${code}:`, e.message);
      }
    }
    const d = describe(ev.private);
    return { status: ev.private.status, code: d.code, total: d.total, dateLabel: d.dateLabel, timeLabel: d.timeLabel, deadline: ev.private.expiresAt };
  }

  /** Проходит по ожидающим броням: оплаченные подтверждает, просроченные удаляет. */
  async function sweep() {
    const result = { paid: 0, expired: 0, released: 0, refunded: 0, errors: 0 };
    const pending = await calendar.listPending();
    for (const ev of pending) {
      try {
        // Администратор может подтвердить вручную цветом и при онлайн-оплате (например, оплатили по телефону)
        if (ev.colorId === cfg.paidColorId) {
          await withLock(() => markPaid(ev));
          result.paid++;
          continue;
        }
        if (ev.private.paymentId && payments) {
          const r = await syncPayment(ev.private.paymentId);
          if (r === 'paid') { result.paid++; continue; }
          if (r === 'released') { result.released++; continue; }
          if (r === 'refunded') { result.refunded++; continue; }
        }
        if (new Date(ev.private.expiresAt) <= now()) {
          await withLock(async () => {
            const fresh = await calendar.findByCode(ev.private.code);
            if (!fresh || fresh.private.status !== 'pending') return;
            await calendar.deleteEvent(fresh.id);
            await notify.expired(describe(fresh.private));
            result.expired++;
          });
        }
      } catch (e) {
        result.errors++;
        log.error(`[sweep] бронь ${ev.private && ev.private.code}:`, e.message);
      }
    }
    return result;
  }

  return { getBusy, book, cancel, status, syncPayment, sweep };
}

module.exports = { createBookingService };

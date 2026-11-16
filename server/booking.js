'use strict';
/* Бизнес-логика: свободные слоты, бронь, отмена, подтверждение оплаты (ЮKassa или цвет события).
   Одна бронь (код + секрет + одна оплата) может состоять из нескольких промежутков в разные дни.
   Каждый промежуток — отдельное событие в календаре с общим кодом брони. */
const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { validateOrder } = require('./validate');
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
const plural = (n, f) => { const a = n % 10, b = n % 100; return f[(b > 10 && b < 20) ? 2 : a === 1 ? 0 : (a > 1 && a < 5) ? 1 : 2]; };

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

  /** Один промежуток: даты, часы, подписи */
  function rangeInfo(date, a, b, total) {
    return {
      date, startHour: a, endHour: b + 1, hours: b - a + 1, total: Number(total),
      start: T.zonedToUtc(date, a, cfg.tz), end: T.zonedToUtc(date, b + 1, cfg.tz),
      ...labels(date, a, b),
    };
  }

  /** Вся бронь по её событиям: контакты, список промежутков, общая сумма */
  function describe(events) {
    const list = (Array.isArray(events) ? events : [events]).map((e) => e.private || e);
    const ranges = list.map((p) => {
      const [a, b] = String(p.hours || '0-0').split('-').map(Number);
      return rangeInfo(p.date, a, b, p.total);
    }).sort((x, y) => x.start - y.start);
    const p = list[0];
    const total = ranges.reduce((t, r) => t + r.total, 0);
    const whenLabel = ranges.map((r) => `${r.dateLabel}, ${r.timeLabel}`).join('; ');
    const first = ranges[0];
    return {
      code: p.code, name: p.name, email: p.email, phone: p.phone, total,
      purpose: p.purpose || '', people: p.people || '',
      ranges, whenLabel, hoursTotal: ranges.reduce((t, r) => t + r.hours, 0),
      // поля первого промежутка: шаблоны для одной брони работают как раньше
      date: first.date, startHour: first.startHour, endHour: first.endHour, start: first.start, end: first.end,
      dateLabel: ranges.length > 1 ? `${ranges.length} ${plural(ranges.length, ['промежуток', 'промежутка', 'промежутков'])}` : first.dateLabel,
      timeLabel: ranges.length > 1 ? whenLabel : first.timeLabel,
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
    const v = validateOrder(input, cfg, now());
    return withLock(async () => {
      for (const r of v.ranges) {
        const busy = (await getBusy(r.date, r.date))[r.date];
        if (r.hours.some((h) => busy.includes(h))) throw new AppError(409, 'slot_taken', 'Часть выбранного времени только что заняли, выберите другое');
      }

      const code = await uniqueCode();
      const token = crypto.randomBytes(12).toString('hex');
      const deadline = new Date(now().getTime() + cfg.holdMinutes * 60000);
      const online = Boolean(payments);
      const parts = v.ranges.map((r) => ({ ...r, first: r.hours[0], last: r.hours[r.hours.length - 1], total: priceFor(r.hours, cfg).total }));
      const total = parts.reduce((t, r) => t + r.total, 0);
      const hoursCount = parts.reduce((t, r) => t + r.hours.length, 0);
      const allLabels = parts.map((r) => { const lb = labels(r.date, r.first, r.last); return `${lb.dateLabel}, ${lb.timeLabel}`; });

      // В Яндекс Календаре (CalDAV) цвет события не меняется: статус показывает значок ⏳/✅ в названии
      const byIcon = calendar.driver === 'caldav';
      const dl = T.nowInTz(deadline, cfg.tz);
      const until = `Если оплаты не будет до ${dl.date} ${T.pad(Math.floor(dl.minutes / 60))}:${T.pad(dl.minutes % 60)}, события удалятся сами.`;
      const howToConfirm = online
        ? [`Оплата онлайн через виджет ЮKassa на сайте. Когда платёж пройдёт, сайт сам ${byIcon ? 'заменит ⏳ на ✅ в названии' : 'покрасит события брони в зелёный'} и напишет клиенту.`, until]
        : [byIcon ? 'Оплата пришла? Замените ⏳ на ✅ в названии любого события брони: подтвердится вся бронь.' : 'Оплата пришла? Покрасьте событие в зелёный цвет («Базилик»): подтвердится вся бронь.', until];

      const created = [];
      const privs = [];
      try {
        for (let i = 0; i < parts.length; i++) {
          const r = parts[i];
          const lb = labels(r.date, r.first, r.last);
          const partTag = parts.length > 1 ? ` (${i + 1}/${parts.length})` : '';
          const priv = {
            managed: '1', code, status: 'pending', token, date: r.date, hours: `${r.first}-${r.last}`,
            name: v.name, phone: v.phone, email: v.email, total: String(r.total), orderTotal: String(total),
            part: `${i + 1}/${parts.length}`, expiresAt: deadline.toISOString(),
            purpose: v.purposeLabel || '', people: v.people ? String(v.people) : '',
            pay: online ? payments.provider : 'transfer',
          };
          const ev = await calendar.createEvent({
            summary: `⏳ ${code}${partTag} · ${v.name} · ${lb.timeLabel} · ${r.total} ₽`,
            description: [
              `Бронь ${code}${partTag}: ${lb.dateLabel}, ${lb.timeLabel}`,
              parts.length > 1 ? `Вся бронь: ${allLabels.join('; ')} — всего ${total} ₽` : null,
              `Клиент: ${v.name}`, `Телефон: ${v.phone}`, `Почта: ${v.email}`,
              v.purposeLabel ? `Формат: ${v.purposeLabel}` : null,
              v.people ? `Человек: ${v.people}` : null,
              v.note ? `Комментарий: ${v.note}` : null,
              `К оплате за этот промежуток: ${r.total} ₽`,
              '',
              ...howToConfirm,
            ].filter((x) => x !== null).join('\n'),
            colorId: cfg.pendingColorId,
            start: T.zonedToUtc(r.date, r.first, cfg.tz),
            end: T.zonedToUtc(r.date, r.last + 1, cfg.tz),
            localStart: T.localDateTime(r.date, r.first),
            localEnd: T.localDateTime(r.date, r.last + 1),
            private: priv,
          });
          created.push(ev.id);
          privs.push(priv);
        }
      } catch (e) {
        for (const id of created) await calendar.deleteEvent(id).catch(() => {});
        throw e;
      }

      const order = describe(privs);
      let confirmationToken = null;
      if (online) {
        try {
          const p = await payments.createPayment({
            code, total, date: parts[0].date, hours: `${parts[0].first}-${parts[0].last}`, hoursCount, email: v.email,
            dateLabel: parts.length > 1 ? order.dateLabel : order.ranges[0].dateLabel,
            timeLabel: parts.length > 1 ? `${hoursCount} ч` : order.ranges[0].timeLabel,
            idempotenceKey: `pay-${code}-${deadline.getTime()}`,
          });
          if (!p.confirmationToken) throw new Error('ЮKassa не вернула токен для виджета');
          confirmationToken = p.confirmationToken;
          for (let i = 0; i < created.length; i++) await calendar.patchEvent(created[i], { private: { ...privs[i], paymentId: p.id } });
        } catch (e) {
          log.error(`[pay] бронь ${code}: не удалось создать платёж:`, e.message);
          for (const id of created) await calendar.deleteEvent(id).catch(() => {});
          throw new AppError(502, 'payment_unavailable', 'Платёжный сервис сейчас не отвечает. Попробуйте ещё раз через пару минут.');
        }
      }

      await notify.created({ ...order, online, deadlineLabel: fmtDeadline(deadline) });

      const first = parts[0];
      const res = {
        code, token, total, deadline: deadline.toISOString(),
        date: first.date, hours: first.hours,                       // первый промежуток (совместимость)
        ranges: order.ranges.map((r) => ({ date: r.date, startHour: r.startHour, endHour: r.endHour, total: r.total, dateLabel: r.dateLabel, timeLabel: r.timeLabel })),
        dateLabel: order.dateLabel, timeLabel: order.timeLabel, whenLabel: order.whenLabel,
      };
      if (online) res.payment = { provider: payments.provider, confirmationToken };
      else res.requisites = cfg.requisites;
      return res;
    });
  }

  /** События брони, если код и секрет верны */
  async function findOwned(code, token) {
    if (!CODE_RE.test(String(code)) || !TOKEN_RE.test(String(token || ''))) return null;
    const evs = await calendar.findAllByCode(code);
    const ev = evs[0];
    const ok = ev && ev.private.token && ev.private.token.length === token.length &&
      crypto.timingSafeEqual(Buffer.from(ev.private.token), Buffer.from(token));
    return ok ? evs : null;
  }

  async function cancel(code, token) {
    return withLock(async () => {
      const evs = await findOwned(code, token);
      if (!evs) throw new AppError(404, 'not_found', 'Бронь не найдена');
      if (evs.some((e) => e.private.status !== 'pending')) throw new AppError(409, 'not_cancellable', 'Оплаченную бронь отменяет администратор, напишите нам');
      for (const e of evs) await calendar.deleteEvent(e.id);
      await notify.cancelled(describe(evs));
      return { ok: true };
    });
  }

  async function markPaid(evs, extra = {}) {
    const at = now().toISOString();
    for (const ev of evs) {
      if (ev.private.status === 'paid') continue;
      await calendar.patchEvent(ev.id, {
        summary: ev.summary.replace('⏳', '✅'),
        colorId: cfg.paidColorId,
        private: { ...ev.private, status: 'paid', paidAt: at, ...extra },
      });
    }
    await notify.paid(describe(evs));
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
      const evs = await calendar.findAllByCode(code);
      const ours = evs.length > 0 && evs.every((e) => e.private.paymentId === p.id);
      const sum = evs.reduce((t, e) => t + Number(e.private.total), 0);

      if (p.status === 'succeeded') {
        if (ours && evs.every((e) => e.private.status === 'paid')) return 'paid';
        if (ours && sum === p.amount) {
          await markPaid(evs, { paymentId: p.id });
          return 'paid';
        }
        // Деньги пришли, а брони уже нет (срок вышел, клиент отменил) или сумма не та: возвращаем автоматически
        const reason = `Бронь ${code} снята до поступления оплаты, деньги возвращены`;
        await payments.refund(p.id, p.amount, reason);
        await notify.refunded({ code, total: p.amount, date: p.metadata.date, hours: p.metadata.hours, email: evs[0] && evs[0].private.email });
        log.log(`[pay] ${reason}`);
        return 'refunded';
      }

      if (p.status === 'canceled') {
        if (ours && evs.every((e) => e.private.status === 'pending')) {
          for (const e of evs) await calendar.deleteEvent(e.id);
          await notify.expired({ ...describe(evs), reason: 'payment_canceled' });
          return 'released';
        }
        return 'ignored';
      }

      return 'waiting';
    });
  }

  /** Статус брони для клиента после оплаты в виджете. */
  async function status(code, token) {
    let evs = await findOwned(code, token);
    if (!evs) return { status: 'gone' };
    if (evs[0].private.status === 'pending' && evs[0].private.paymentId) {
      try {
        await syncPayment(evs[0].private.paymentId);
        evs = await findOwned(code, token);
        if (!evs) return { status: 'gone' };
      } catch (e) {
        log.error(`[pay] статус ${code}:`, e.message);
      }
    }
    const d = describe(evs);
    const st = evs.every((e) => e.private.status === 'paid') ? 'paid' : 'pending';
    return { status: st, code: d.code, total: d.total, dateLabel: d.dateLabel, timeLabel: d.timeLabel, whenLabel: d.whenLabel, deadline: evs[0].private.expiresAt };
  }

  /** Проходит по ожидающим броням: оплаченные подтверждает, просроченные удаляет. */
  async function sweep() {
    const result = { paid: 0, expired: 0, released: 0, refunded: 0, errors: 0 };
    const pending = await calendar.listPending();
    const byCode = new Map();
    for (const ev of pending) {
      const c = ev.private.code;
      if (!byCode.has(c)) byCode.set(c, []);
      byCode.get(c).push(ev);
    }
    for (const [code, evs] of byCode) {
      try {
        // Администратор может подтвердить вручную цветом (любое событие брони) и при онлайн-оплате
        if (evs.some((e) => e.colorId === cfg.paidColorId)) {
          await withLock(async () => markPaid(await calendar.findAllByCode(code)));
          result.paid++;
          continue;
        }
        const pid = evs[0].private.paymentId;
        if (pid && payments) {
          // Статус платежа не узнали (сбой сети, платёж не найден) — не страшно:
          // ниже просроченная бронь всё равно снимется, иначе она навсегда заняла бы время.
          let r = null;
          try { r = await syncPayment(pid); } catch (e) { result.errors++; log.error(`[sweep] бронь ${code}: платёж ${pid}:`, e.message); }
          if (r === 'paid') { result.paid++; continue; }
          if (r === 'released') { result.released++; continue; }
          if (r === 'refunded') { result.refunded++; continue; }
        }
        if (new Date(evs[0].private.expiresAt) <= now()) {
          await withLock(async () => {
            const fresh = (await calendar.findAllByCode(code)).filter((e) => e.private.status === 'pending');
            if (!fresh.length) return;
            for (const e of fresh) await calendar.deleteEvent(e.id);
            await notify.expired(describe(fresh));
            result.expired++;
          });
        }
      } catch (e) {
        result.errors++;
        log.error(`[sweep] бронь ${code}:`, e.message);
      }
    }
    return result;
  }

  return { getBusy, book, cancel, status, syncPayment, sweep };
}

module.exports = { createBookingService };

'use strict';
/*
 * Постоянная бронь «каждую неделю» с автосписанием с карты.
 *
 * Как это работает:
 *  1. Клиент выбирает время (в пределах одной недели) и «Каждую неделю». Сайт проверяет, что это время
 *     свободно на SUB_WEEKS недель вперёд, создаёт обычную бронь ⏳ на первую неделю (оплата в виджете,
 *     карта сохраняется) и закрепляет следующие недели событиями 🔁 — для других это время занято.
 *  2. Первая оплата прошла и карта сохранилась → постоянная бронь активна, клиенту письмо со ссылкой управления.
 *  3. За SUB_CHARGE_DAYS дней до каждого занятия сайт сам списывает оплату с карты: 🔁 → ✅, письмо и чек.
 *  4. Не списалось → письмо клиенту и администратору, повтор через SUB_RETRY_HOURS. Если за SUB_RELEASE_HOURS
 *     до занятия оплаты нет — занятие освобождается, постоянная бронь ставится на паузу (будущие 🔁 снимаются).
 *  5. Клиент может отменить по ссылке из письма: будущие неоплаченные занятия освобождаются, оплаченные остаются.
 *  Сайт поддерживает закреплёнными SUB_WEEKS будущих недель: каждую неделю добавляется следующая.
 *
 *  Пока ЮKassa не включила магазину автоплатежи, карта не сохраняется (paymentMethod.id = null). Постоянная
 *  бронь всё равно оформляется и работает, только вместо автосписания за SUB_CHARGE_DAYS дней до занятия
 *  клиенту приходит письмо об оплате, а в личном кабинете появляется кнопка «Оплатить занятие» (неделя awaiting).
 *
 * Записи хранятся в data/subscriptions.json (server/store.js), события — в календаре.
 */
const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { validateOrder } = require('./validate');
const T = require('./time');

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID_RE = /^S[A-Z2-9]{6}$/;
const TOKEN_RE = /^[0-9a-f]{24}$/;
const DAY = 86400000;
const EVERY = ['каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'];
const weekday = (dateKey) => { const [y, m, d] = dateKey.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; };
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function createSubscriptionService({ calendar, cfg, notify, payments, store, booking, now = () => new Date(), log = console }) {
  const S = cfg.subscriptions;
  const B = booking._internal;

  const enabled = () => Boolean(S.enabled && payments);
  const manageUrl = (sub) => `${cfg.baseUrl.replace(/\/$/, '')}/subscription?id=${sub.id}&t=${sub.token}`;
  const weekParts = (sub, k) => sub.slots.map((s) => ({ date: T.addDays(s.date, 7 * k), first: s.first, last: s.last, hours: range(s.first, s.last), total: s.total }));
  const weekStart = (sub, k) => Math.min(...weekParts(sub, k).map((p) => T.zonedToUtc(p.date, p.first, cfg.tz).getTime()));
  const weekLabel = (sub, k) => weekParts(sub, k).map((p) => { const l = B.labels(p.date, p.first, p.last); return `${l.dateLabel}, ${l.timeLabel}`; }).join('; ');
  const schedule = (sub) => sub.slots.map((s) => `${EVERY[weekday(s.date)]} ${T.hhmm(s.first)}–${T.hhmm(s.last + 1)}`).join('; ');
  const contact = (sub) => ({ name: sub.name, phone: sub.phone, email: sub.email, purposeLabel: sub.purpose, people: sub.people, note: sub.note || '' });
  const weekOf = (sub, k) => sub.weeks.find((w) => w.k === k);
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru-RU', { timeZone: cfg.tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const info = (sub, extra = {}) => ({
    id: sub.id, name: sub.name, phone: sub.phone, email: sub.email, schedule: schedule(sub), weekTotal: sub.weekTotal,
    weeks: S.weeks, chargeDaysBefore: S.chargeDaysBefore, card: sub.paymentMethod ? sub.paymentMethod.title : '', url: manageUrl(sub),
    autopay: Boolean(sub.paymentMethod && sub.paymentMethod.id), ...extra,
  });

  /** Свободно ли время частей брони (по уже загруженным занятым интервалам) */
  const overlaps = (busy, p) => {
    const s = T.zonedToUtc(p.date, p.first, cfg.tz); const e = T.zonedToUtc(p.date, p.last + 1, cfg.tz);
    return busy.some((b) => b.start < e && b.end > s);
  };

  async function uniqueId() {
    for (let i = 0; i < 8; i++) {
      let id = 'S';
      for (const byte of crypto.randomBytes(6)) id += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (!store.get(id)) return id;
    }
    throw new AppError(503, 'busy', 'Попробуйте ещё раз');
  }

  /** Закрепить неделю k событиями 🔁 (под замком) */
  async function reserve(sub, k) {
    const code = await B.uniqueCode();
    if (!sub.test) await B.createEvents({
      code, token: crypto.randomBytes(12).toString('hex'), parts: weekParts(sub, k), c: contact(sub), status: 'reserved',
      extra: { sub: sub.id, week: String(k), subUrl: manageUrl(sub) }, icon: '🔁', consentAt: sub.pdConsentAt,
      tail: [`Постоянная бронь ${sub.id}: ${schedule(sub)}. Оплата спишется с карты клиента за ${S.chargeDaysBefore} дн. до занятия, тогда 🔁 сменится на ✅.`],
    });
    const w = weekOf(sub, k);
    const rec = { k, code, status: 'reserved', paymentId: null, attempts: 0, nextTryAt: null };
    if (w) Object.assign(w, rec); else sub.weeks.push(rec);
  }

  /** Снять события недели из календаря (под замком) */
  async function dropWeek(w) {
    for (const e of await calendar.findAllByCode(w.code)) await calendar.deleteEvent(e.id);
    w.status = 'released';
  }

  /** Освободить все будущие неоплаченные недели (под замком) */
  async function releaseFuture(sub) {
    const t = now().getTime();
    for (const w of sub.weeks) {
      if (['reserved', 'awaiting', 'charging', 'pending'].includes(w.status) && weekStart(sub, w.k) > t) await dropWeek(w);
    }
  }

  // ---------- оформление ----------
  async function book(input) {
    if (!enabled()) throw new AppError(400, 'subs_off', 'Постоянная бронь пока недоступна, оформите разовую');
    const v = validateOrder(input, cfg, now());
    const f = {};
    if (!v.email) f.email = 'Для постоянной брони нужна почта: пришлём ссылку для управления и чеки';
    if (input.autopayConsent !== true) f.autopayConsent = 'Нужно согласие на автоматическое списание';
    const dates = v.ranges.map((r) => r.date).sort();
    if (T.daysBetween(dates[0], dates[dates.length - 1]) > 6) f.hours = 'Для постоянной брони выберите время в пределах одной недели';
    if (Object.keys(f).length) throw new AppError(400, 'validation', Object.values(f)[0], f);

    return B.withLock(async () => {
      const slots = B.toParts(v.ranges).map((p) => ({ date: p.date, first: p.first, last: p.last, total: p.total }));
      const draft = { slots };
      // время должно быть свободно во все закрепляемые недели
      const lastDay = T.addDays(dates[dates.length - 1], 7 * (S.weeks - 1));
      const busy = await calendar.listBusy(T.zonedToUtc(dates[0], 0, cfg.tz), T.zonedToUtc(T.addDays(lastDay, 1), 0, cfg.tz));
      const conflicts = [];
      for (let k = 0; k < S.weeks; k++) {
        for (const p of weekParts(draft, k)) if (overlaps(busy, p)) { const l = B.labels(p.date, p.first, p.last); conflicts.push(`${l.dateLabel}, ${l.timeLabel}`); }
      }
      if (conflicts.length) {
        throw new AppError(409, 'slot_taken', `Это время уже занято в некоторые недели: ${conflicts.slice(0, 4).join('; ')}${conflicts.length > 4 ? ' и ещё ' + (conflicts.length - 4) : ''}. Выберите другое время или оформите разовую бронь.`, { conflicts });
      }

      const at = now().toISOString();
      const sub = {
        id: await uniqueId(), token: crypto.randomBytes(12).toString('hex'), status: 'pending', createdAt: at,
        name: v.name, phone: v.phone, email: v.email, purpose: v.purposeLabel || '', people: v.people ? String(v.people) : '', note: v.note || '',
        slots, weekTotal: slots.reduce((t, s) => t + s.total, 0), weeks: [], paymentMethod: null,
        autopayConsentAt: at, pdConsentAt: at,
      };
      const o = await B.createOrder(v, { extra: { sub: sub.id, week: '0', subUrl: manageUrl(sub) }, savePaymentMethod: true });
      sub.linkMode = Boolean(o.saveDeferred);   // ЮKassa ещё не сохраняет карты: следующие занятия — оплата по ссылке
      sub.weeks.push({ k: 0, code: o.code, status: 'pending', paymentId: o.paymentId, attempts: 0, nextTryAt: null });
      try {
        for (let k = 1; k < S.weeks; k++) await reserve(sub, k);
      } catch (e) {
        log.error(`[sub] ${sub.id}: не удалось закрепить недели:`, e.message);
        for (const w of sub.weeks) await dropWeek(w).catch(() => {});
        throw new AppError(503, 'calendar_unavailable', 'Не удалось закрепить время на следующие недели, попробуйте ещё раз');
      }
      store.put(sub);
      await notify.created({ ...o.order, online: o.online, deadlineLabel: B.fmtDeadline(o.deadline), subscription: info(sub) });
      B.scheduleRelease(o.code);
      return { ...B.orderResponse(o), subscription: { id: sub.id, schedule: schedule(sub), weeks: S.weeks, weekTotal: sub.weekTotal, chargeDaysBefore: S.chargeDaysBefore } };
    });
  }

  // ---------- события от брони (вызываются под замком) ----------
  async function onPaid(evs, p) {
    const priv = evs[0].private;
    const sub = priv.sub && store.get(priv.sub);
    if (!sub) return;
    const k = Number(priv.week);
    const w = weekOf(sub, k);
    if (w) { w.status = 'paid'; w.paymentId = p.id; w.paidAt = now().toISOString(); w.amount = p.amount; }
    if (k === 0 && sub.status === 'pending') {
      const saved = Boolean(p.paymentMethod && p.paymentMethod.saved);
      if (saved || sub.linkMode) {
        sub.paymentMethod = { id: saved ? p.paymentMethod.id : null, title: (p.paymentMethod && p.paymentMethod.title) || 'карта' };
        sub.status = 'active';
        store.put(sub);
        await notify.subscription('started', info(sub, { reserved: sub.weeks.filter((x) => x.status === 'reserved').map((x) => weekLabel(sub, x.k)) }));
      } else {
        // ЮKassa не сохранила карту (автоплатежи не включены или способ оплаты их не поддерживает)
        await releaseFuture(sub);
        sub.status = 'cancelled'; sub.endReason = 'card_not_saved';
        store.put(sub);
        await notify.subscription('card_not_saved', info(sub));
      }
      return;
    }
    store.put(sub);
  }

  async function onDropped(evs) {
    const priv = evs[0].private;
    const sub = priv.sub && store.get(priv.sub);
    if (!sub || Number(priv.week) !== 0 || sub.status !== 'pending') return;
    // первая неделя не оплачена — постоянная бронь не оформилась, снимаем закреплённые недели
    const w0 = weekOf(sub, 0); if (w0) w0.status = 'released';
    await releaseFuture(sub);
    sub.status = 'cancelled'; sub.endReason = 'first_unpaid';
    store.put(sub);
  }

  // ---------- автосписание ----------
  async function settle(sub, w, p) {
    if (p.status === 'succeeded') {
      const evs = await calendar.findAllByCode(w.code);
      if (!evs.length) { // неделю уже сняли, а деньги пришли — вернуть
        await payments.refund(p.id, p.amount, `Занятие по постоянной брони ${sub.id} уже освобождено, деньги возвращены`);
        w.status = 'released';
        return 'refunded';
      }
      await B.markPaid(evs, { paymentId: p.id });
      w.status = 'paid'; w.paymentId = p.id; w.paidAt = now().toISOString(); w.amount = p.amount;
      return 'paid';
    }
    if (p.status === 'canceled') {
      if (!sub.paymentMethod || !sub.paymentMethod.id) {   // клиент не оплатил по ссылке — ждём оплату дальше
        w.status = 'awaiting'; w.paymentId = null; w.payUrl = null;
        return 'failed';
      }
      w.status = 'reserved'; w.paymentId = null;
      w.nextTryAt = new Date(now().getTime() + S.retryHours * 3600000).toISOString();
      await notify.subscription('charge_failed', info(sub, { weekLabel: weekLabel(sub, w.k), amount: weekParts(sub, w.k).reduce((t, x) => t + x.total, 0), reason: p.cancelReason, nextTryAt: w.nextTryAt }));
      return 'failed';
    }
    return 'waiting';
  }

  async function charge(sub, w) {
    const evs = await calendar.findAllByCode(w.code);
    if (!evs.length) { w.status = 'released'; return 'released'; }
    const order = B.describe(evs);
    if (!sub.paymentMethod.id) {
      // карта не сохранена в ЮKassa: письмо с кнопкой оплаты, оплатить можно и в личном кабинете
      w.status = 'awaiting'; w.notifiedAt = now().toISOString();
      store.put(sub);
      await notify.subscription('pay_due', info(sub, { weekLabel: weekLabel(sub, w.k), amount: order.total, payBefore: fmtDate(weekStart(sub, w.k) - S.releaseHoursBefore * 3600000) }));
      return 'awaiting';
    }
    w.attempts = (w.attempts || 0) + 1;
    w.lastTryAt = now().toISOString();
    let p;
    try {
      p = await payments.createPayment({
        code: w.code, total: order.total, date: order.date, hours: `${order.startHour}-${order.endHour - 1}`, hoursCount: order.hoursTotal,
        email: sub.email, phone: sub.phone, dateLabel: order.dateLabel, timeLabel: order.timeLabel,
        paymentMethodId: sub.paymentMethod.id, sub: sub.id, week: w.k, idempotenceKey: `sub-${sub.id}-${w.k}-${w.attempts}`,
      });
    } catch (e) {
      log.error(`[sub] ${sub.id}: списание за неделю ${w.k} не создано:`, e.message);
      w.nextTryAt = new Date(now().getTime() + 3600000).toISOString(); // сбой связи — повтор через час
      return 'error';
    }
    w.paymentId = p.id; w.status = 'charging';
    for (const ev of evs) await calendar.patchEvent(ev.id, { private: { ...ev.private, paymentId: p.id } });
    store.put(sub);
    return settle(sub, w, p);
  }

  /** Обработать одну постоянную бронь: списания, освобождение, продление (под замком) */
  async function process(sub) {
    const t = now().getTime();
    for (const w of [...sub.weeks].sort((a, b) => a.k - b.k)) {
      if (!['reserved', 'awaiting', 'charging'].includes(w.status)) continue;
      const start = weekStart(sub, w.k);
      if (start <= t) { w.status = 'released'; continue; }
      if (w.status === 'charging' && w.paymentId) {
        const r = await settle(sub, w, await payments.getPayment(w.paymentId));
        if (r === 'paid' || r === 'refunded') continue;
      }
      if (t >= start - S.releaseHoursBefore * 3600000) {
        // к сроку не оплачено: занятие освобождаем, постоянную бронь ставим на паузу
        const label = weekLabel(sub, w.k);
        await dropWeek(w);
        await releaseFuture(sub);
        sub.status = 'paused'; sub.endReason = 'unpaid';
        store.put(sub);
        await notify.subscription('paused', info(sub, { weekLabel: label }));
        return;
      }
      if (w.status === 'reserved' && t >= start - S.chargeDaysBefore * DAY && (!w.nextTryAt || t >= Date.parse(w.nextTryAt))) {
        if (!sub.paymentMethod) continue;                // карту отвязали — ждём новую, к сроку освободим
        await charge(sub, w);
      }
    }
    // держим закреплёнными S.weeks будущих недель
    const alive = sub.weeks.filter((w) => ['reserved', 'awaiting', 'charging', 'paid', 'pending'].includes(w.status) && weekStart(sub, w.k) > t).length;
    let need = S.weeks - alive;
    let k = Math.max(...sub.weeks.map((w) => w.k));
    for (let guard = 0; need > 0 && guard < S.weeks * 2; guard++) {
      k++;
      const parts = weekParts(sub, k);
      const from = T.zonedToUtc(parts[0].date, 0, cfg.tz);
      const busy = await calendar.listBusy(new Date(from.getTime() - DAY), new Date(from.getTime() + 8 * DAY));
      if (parts.some((p) => overlaps(busy, p))) {
        sub.weeks.push({ k, code: null, status: 'skipped' });
        await notify.subscription('skipped', info(sub, { weekLabel: weekLabel(sub, k) }));
      } else {
        await reserve(sub, k);
        need--;
      }
    }
    // старая история не нужна: оставляем 12 последних недель
    if (sub.weeks.length > S.weeks + 12) sub.weeks = sub.weeks.sort((a, b) => a.k - b.k).slice(-(S.weeks + 12));
    store.put(sub);
  }

  async function tick() {
    const result = { processed: 0, errors: 0 };
    if (!enabled()) return result;
    for (const sub of store.all()) {
      if (sub.bindPaymentId) await B.withLock(() => finishBind(sub)).catch((e) => log.error(`[sub] ${sub.id}: привязка карты:`, e.message));
      if (sub.status !== 'active' || sub.test) continue;
      try {
        await B.withLock(() => process(sub));
        result.processed++;
      } catch (e) {
        result.errors++;
        log.error(`[sub] ${sub.id}:`, e.message);
      }
    }
    return result;
  }

  // ---------- карта для автосписаний: привязать и отвязать ----------
  /** Вернуть паузу в работу: закрепить снова освобождённые будущие недели, если время свободно (под замком) */
  async function reactivate(sub) {
    sub.status = 'active'; sub.endReason = '';
    const t = now().getTime();
    for (const w of [...sub.weeks].sort((a, b) => a.k - b.k)) {
      if (w.status !== 'released' || weekStart(sub, w.k) <= t + S.releaseHoursBefore * 3600000) continue;
      const parts = weekParts(sub, w.k);
      const from = T.zonedToUtc(parts[0].date, 0, cfg.tz);
      const busy = await calendar.listBusy(new Date(from.getTime() - DAY), new Date(from.getTime() + 8 * DAY));
      if (!parts.some((p) => overlaps(busy, p))) await reserve(sub, w.k);
    }
    await process(sub);
  }

  /** Отвязать карту: автосписания прекращаются, неоплаченные будущие занятия освобождаются, бронь на паузе */
  async function unbindCard(id, token) {
    return B.withLock(async () => {
      const sub = owned(id, token);
      if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
      if (!sub.paymentMethod) return { ok: true };
      const card = sub.paymentMethod.title;
      sub.paymentMethod = null;
      await releaseFuture(sub);
      if (sub.status === 'active') { sub.status = 'paused'; sub.endReason = 'card_unbound'; }
      store.put(sub);
      await notify.subscription('card_unbound', info(sub, { card }));
      return { ok: true };
    });
  }

  /** Привязать карту: проверочный платёж 1 ₽ в виджете ЮKassa с сохранением карты, рубль сразу возвращаем */
  async function startBind(id, token) {
    if (!enabled()) throw new AppError(400, 'subs_off', 'Привязка карты пока недоступна');
    return B.withLock(async () => {
      const sub = owned(id, token);
      if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
      if (sub.status === 'cancelled') throw new AppError(409, 'cancelled', 'Постоянная бронь отменена, оформите новую');
      if (sub.test && !payments) throw new AppError(400, 'subs_off', 'Привязка карты недоступна');
      const attempt = (sub.bindAttempts || 0) + 1;
      const p = await payments.createPayment({
        code: `bind-${sub.id}`, total: 1, hoursCount: 0, email: sub.email, phone: sub.phone,
        description: `Проверка карты для постоянной брони ${sub.id}, 1 ₽ вернём сразу`,
        receiptText: `Проверка карты для автосписаний (постоянная бронь ${sub.id})`,
        savePaymentMethod: true, sub: sub.id, idempotenceKey: `bind-${sub.id}-${attempt}`,
      }).catch((e) => {
        log.error(`[sub] ${sub.id}: привязка карты не создана:`, e.message);
        throw new AppError(502, 'payment_unavailable', 'Платёжный сервис сейчас не отвечает, попробуйте позже');
      });
      if (!p.confirmationToken) throw new AppError(502, 'payment_unavailable', 'ЮKassa не ответила, попробуйте ещё раз');
      sub.bindAttempts = attempt;
      sub.bindPaymentId = p.id;
      sub.bindDeferred = Boolean(p.saveDeferred);
      store.put(sub);
      return { provider: payments.provider, confirmationToken: p.confirmationToken };
    });
  }

  /** Итог привязки (браузер спрашивает после формы ЮKassa; фоновая проверка тоже доводит до конца) */
  async function finishBind(sub) {
    if (!sub.bindPaymentId) return { status: 'none' };
    const p = await payments.getPayment(sub.bindPaymentId);
    if (p.status === 'pending' || p.status === 'waiting_for_capture') return { status: 'pending' };
    sub.bindPaymentId = null;
    if (p.status === 'succeeded') {
      await payments.refund(p.id, p.amount, 'Возврат проверочного платежа за привязку карты').catch((e) => log.error(`[sub] ${sub.id}: возврат 1 ₽:`, e.message));
      if (!p.paymentMethod || (!p.paymentMethod.saved && !sub.bindDeferred)) {
        store.put(sub);
        return { status: 'failed', message: 'Этот способ оплаты не поддерживает автосписания, привяжите банковскую карту' };
      }
      sub.paymentMethod = { id: p.paymentMethod.saved ? p.paymentMethod.id : null, title: p.paymentMethod.title || 'карта' };
      if (sub.status === 'paused') await reactivate(sub);
      store.put(sub);
      await notify.subscription('card_bound', info(sub));
      return { status: 'bound', card: sub.paymentMethod.title };
    }
    store.put(sub);
    return { status: 'failed', message: 'Карту привязать не удалось, попробуйте ещё раз или другую карту' };
  }

  async function bindStatus(id, token) {
    return B.withLock(async () => {
      const sub = owned(id, token);
      if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
      return finishBind(sub);
    });
  }

  // ---------- управление по ссылке из письма ----------
  function owned(id, token) {
    if (!ID_RE.test(String(id)) || !TOKEN_RE.test(String(token || ''))) return null;
    const sub = store.get(id);
    if (!sub || !crypto.timingSafeEqual(Buffer.from(sub.token), Buffer.from(String(token)))) return null;
    return sub;
  }

  /** Узнать у ЮKassa итог начатых оплат (клиент вернулся в кабинет со страницы оплаты) — под замком */
  async function refresh(sub) {
    for (const w of sub.weeks) {
      if (w.status !== 'charging' || !w.paymentId) continue;
      try { await settle(sub, w, await payments.getPayment(w.paymentId)); } catch (e) { log.error(`[sub] ${sub.id}: платёж ${w.paymentId}:`, e.message); }
    }
    store.put(sub);
  }

  async function view(id, token) {
    const sub = owned(id, token);
    if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
    if (payments && sub.weeks.some((w) => w.status === 'charging' && w.paymentId)) await B.withLock(() => refresh(sub));
    const t = now().getTime();
    const STATUS = { pending: 'ждёт первой оплаты', reserved: 'закреплено', awaiting: 'ждёт оплаты', charging: 'оплачивается', paid: 'оплачено', released: 'освобождено', skipped: 'время было занято' };
    const weeks = [...sub.weeks].sort((a, b) => a.k - b.k);
    const amountOf = (w) => w.amount || weekParts(sub, w.k).reduce((s, x) => s + x.total, 0);
    // следующее списание: ближайшая закреплённая неделя
    const next = weeks.find((w) => ['reserved', 'awaiting', 'charging'].includes(w.status) && weekStart(sub, w.k) > t);
    const due = sub.status === 'active' && weeks.find((w) => ['awaiting', 'charging'].includes(w.status) && weekStart(sub, w.k) > t && !(sub.paymentMethod && sub.paymentMethod.id));
    const nextChargeAt = next ? Math.max(t, weekStart(sub, next.k) - S.chargeDaysBefore * DAY) : null;
    // до какого числа время закреплено или оплачено
    const held = weeks.filter((w) => ['reserved', 'awaiting', 'charging', 'paid', 'pending'].includes(w.status) && weekStart(sub, w.k) > t);
    const paidAhead = weeks.filter((w) => w.status === 'paid' && weekStart(sub, w.k) > t);
    const lastHeld = held.length ? weekStart(sub, held[held.length - 1].k) : null;
    const lastPaid = paidAhead.length ? weekStart(sub, paidAhead[paidAhead.length - 1].k) : null;
    return {
      id: sub.id, status: sub.status, schedule: schedule(sub), weekTotal: sub.weekTotal, card: sub.paymentMethod ? sub.paymentMethod.title : '',
      chargeDaysBefore: S.chargeDaysBefore, name: sub.name, endReason: sub.endReason || '', canBind: sub.status !== 'cancelled',
      createdAt: fmtDate(Date.parse(sub.createdAt)),
      nextChargeAt: sub.status === 'active' && nextChargeAt ? fmtDate(nextChargeAt) : null,
      nextChargeAmount: next ? amountOf(next) : null,
      payDue: due ? { lesson: weekLabel(sub, due.k), amount: amountOf(due), payBefore: fmtDate(weekStart(sub, due.k) - S.releaseHoursBefore * 3600000) } : null,
      heldUntil: lastHeld ? fmtDate(lastHeld) : null,       // время закреплено до (активная бронь продлевается сама)
      paidUntil: lastPaid ? fmtDate(lastPaid) : null,       // оплаченные занятия останутся до
      payments: weeks.filter((w) => w.status === 'paid').reverse()
        .map((w) => ({ date: fmtDate(Date.parse(w.paidAt || '') || weekStart(sub, w.k)), lesson: weekLabel(sub, w.k), amount: amountOf(w), status: 'оплачено' })),
      weeks: weeks.filter((w) => weekStart(sub, w.k) > t - 7 * DAY)
        .map((w) => ({ label: weekLabel(sub, w.k), status: w.status, statusLabel: STATUS[w.status] || w.status, past: weekStart(sub, w.k) <= t })),
    };
  }

  /** Оплатить ближайшее занятие по ссылке (страница ЮKassa: карта или СБП), потом возврат в кабинет */
  async function payNow(id, token) {
    if (!enabled()) throw new AppError(400, 'subs_off', 'Оплата сейчас недоступна');
    return B.withLock(async () => {
      const sub = owned(id, token);
      if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
      if (sub.status !== 'active') throw new AppError(409, 'not_active', 'Постоянная бронь не активна');
      const t = now().getTime();
      const w = [...sub.weeks].sort((a, b) => a.k - b.k).find((x) => ['awaiting', 'reserved', 'charging'].includes(x.status) && weekStart(sub, x.k) > t);
      if (!w) throw new AppError(409, 'nothing_due', 'Сейчас оплачивать нечего');
      if (w.status === 'charging' && w.paymentId) {
        const r = await settle(sub, w, await payments.getPayment(w.paymentId));
        store.put(sub);
        if (r === 'paid' || r === 'refunded') return { paid: true };
        if (r === 'waiting' && w.payUrl) return { confirmationUrl: w.payUrl };
      }
      const evs = sub.test ? [] : await calendar.findAllByCode(w.code);
      if (!evs.length) throw new AppError(409, 'nothing_due', 'Это занятие уже освобождено');
      const order = B.describe(evs);
      w.attempts = (w.attempts || 0) + 1;
      const p = await payments.createPayment({
        code: w.code, total: order.total, date: order.date, hours: `${order.startHour}-${order.endHour - 1}`, hoursCount: order.hoursTotal,
        email: sub.email, phone: sub.phone, dateLabel: order.dateLabel, timeLabel: order.timeLabel,
        redirectUrl: `${manageUrl(sub)}&paid=1`, sub: sub.id, week: w.k, idempotenceKey: `subpay-${sub.id}-${w.k}-${w.attempts}`,
      }).catch((e) => {
        log.error(`[sub] ${sub.id}: оплата недели ${w.k} не создана:`, e.message);
        throw new AppError(502, 'payment_unavailable', 'Платёжный сервис сейчас не отвечает, попробуйте через пару минут');
      });
      if (!p.confirmationUrl) throw new AppError(502, 'payment_unavailable', 'ЮKassa не ответила, попробуйте ещё раз');
      w.status = 'charging'; w.paymentId = p.id; w.payUrl = p.confirmationUrl;
      for (const ev of evs) await calendar.patchEvent(ev.id, { private: { ...ev.private, paymentId: p.id } });
      store.put(sub);
      return { confirmationUrl: p.confirmationUrl };
    });
  }

  async function cancel(id, token) {
    return B.withLock(async () => {
      const sub = owned(id, token);
      if (!sub) throw new AppError(404, 'not_found', 'Постоянная бронь не найдена');
      if (sub.status === 'cancelled') return { ok: true };
      await releaseFuture(sub);
      sub.status = 'cancelled'; sub.endReason = 'client';
      sub.cancelledAt = now().toISOString();
      store.put(sub);
      await notify.subscription('cancelled', info(sub));
      return { ok: true };
    });
  }

  return { book, tick, view, cancel, unbindCard, startBind, bindStatus, payNow, hooks: { onPaid, onDropped }, _process: process };
}

module.exports = { createSubscriptionService };

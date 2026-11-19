/* Аренда зала 55 — фронтенд записи.
   Все цены, занятость и бронь приходят с сервера (/api/*). Браузеру ничего не доверяем:
   сервер сам пересчитывает цену и заново проверяет, что слот свободен. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var nf = new Intl.NumberFormat('ru-RU');
  var num = function (n) { return nf.format(n).replace(/ /g, ' '); };
  var money = function (n) { return num(n) + ' ₽'; };   // неразрывный пробел: «₽» не уходит на новую строку
  var plural = function (n, f) { var a = n % 10, b = n % 100; return f[(b > 10 && b < 20) ? 2 : a === 1 ? 0 : (a > 1 && a < 5) ? 1 : 2]; };

  var fmtLong = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  var fmtShort = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
  var fmtMonthYear = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  var WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  // ---------- даты как строки «ГГГГ-ММ-ДД», без привязки к часовому поясу браузера ----------
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateFromKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(k, n) { var d = dateFromKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
  function daysBetween(a, b) { return Math.round((Date.UTC.apply(null, b.split('-').map(function (v, i) { return i === 1 ? v - 1 : +v; })) - Date.UTC.apply(null, a.split('-').map(function (v, i) { return i === 1 ? v - 1 : +v; }))) / 86400000); }

  // ---------- состояние ----------
  var CONFIG = null;
  var clock = null;                       // «сейчас» в часовом поясе студии, по данным сервера
  // picks: выбранные часы по дням { '2026-11-16': [9, 10], … } — можно в разные дни и несколько промежутков
  var state = { weekOffset: 0, day: null, picks: {}, busy: {}, loading: false, failed: false, showNight: false };
  // ночные часы (до 08:00) бронируют редко: по умолчанию свёрнуты под стрелку
  var NIGHT_END = 8;
  var MAX_WEEK = 8;

  function studioNow() {
    var elapsed = Math.floor((Date.now() - clock.at) / 60000);
    var total = clock.minutes + elapsed;
    return { date: addDays(clock.date, Math.floor(total / 1440)), minutes: total % 1440 };
  }
  var priceOf = function (h) { return h >= CONFIG.peakFrom ? CONFIG.pricePeak : CONFIG.priceDay; };
  // бронь блоками по SLOT часов: 09–11, 11–13, …
  var slotH = function () { return (CONFIG && CONFIG.slotHours) || 1; };
  var blockHours = function (h) { var a = []; for (var i = 0; i < slotH(); i++) a.push(h + i); return a; };
  var blockPrice = function (h) { return blockHours(h).reduce(function (t, x) { return t + priceOf(x); }, 0); };
  function blockStatus(dk, h) {
    var st = blockHours(h).map(function (x) { return slotStatus(dk, x); });
    if (st.indexOf('past') > -1) return 'past';
    if (st.indexOf('busy') > -1) return 'busy';
    return st[0];
  }

  function weekDays() {
    var t = studioNow().date, dow = (dateFromKey(t).getDay() + 6) % 7;
    var start = addDays(t, -dow + state.weekOffset * 7), out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(start, i));
    return out;
  }

  function slotStatus(dk, h) {
    var now = studioNow();
    if (dk < now.date) return 'past';
    if (dk === now.date && h * 60 < now.minutes + CONFIG.minLeadMinutes) return 'past';
    if (daysBetween(now.date, dk) > CONFIG.horizonDays) return 'past';
    var busy = state.busy[dk];
    if (!busy) return 'past';                           // расписание ещё не загрузилось
    if (busy.indexOf(h) > -1) return 'busy';
    return h >= CONFIG.peakFrom ? 'peak' : 'day';
  }

  // ---------- сеть ----------
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) { var e = new Error(data.message || 'Ошибка ' + res.status); e.status = res.status; e.data = data; throw e; }
        return data;
      });
    });
  }

  function loadWeek() {
    var days = weekDays();
    state.loading = true; renderCalendar();
    return api('/api/slots?from=' + days[0] + '&to=' + days[6]).then(function (r) {
      Object.keys(r.busy).forEach(function (d) { state.busy[d] = r.busy[d]; });
      state.failed = false;
      // выбранное время могли занять другие клиенты: такие блоки снимаем
      var lost = false;
      Object.keys(state.picks).forEach(function (d) {
        var busy = state.busy[d]; if (!busy) return;
        var keep = state.picks[d].filter(function (h) { return busy.indexOf(h) < 0; });
        if (keep.length !== state.picks[d].length) {
          lost = true;
          // снимаем блок целиком
          var bad = state.picks[d].filter(function (h) { return busy.indexOf(h) > -1; }).map(function (h) { return h - (h - CONFIG.openHour) % slotH(); });
          keep = state.picks[d].filter(function (h) { return bad.indexOf(h - (h - CONFIG.openHour) % slotH()) < 0; });
          if (keep.length) state.picks[d] = keep; else delete state.picks[d];
        }
      });
      if (lost) $('selNote').textContent = 'Часть выбранного времени только что заняли, мы её сняли.';
    }).catch(function () {
      state.failed = true;
    }).then(function () {
      state.loading = false; $('calError').hidden = !state.failed; render();
    });
  }

  // ---------- выбор часов ----------
  function isPicked(dk, h) { return !!state.picks[dk] && state.picks[dk].indexOf(h) > -1; }

  /** Выбор → список промежутков: по дням, часы подряд */
  function pickedRanges() {
    var out = [];
    Object.keys(state.picks).sort().forEach(function (d) {
      var hs = state.picks[d].slice().sort(function (x, y) { return x - y; }), run = [];
      hs.forEach(function (h) {
        if (run.length && h !== run[run.length - 1] + 1) { out.push({ date: d, hours: run }); run = []; }
        run.push(h);
      });
      if (run.length) out.push({ date: d, hours: run });
    });
    return out;
  }

  function toggle(dk, h) {
    var note = $('selNote'), blk = blockHours(h), cur = (state.picks[dk] || []).slice();
    note.textContent = '';
    if (isPicked(dk, h)) {
      cur = cur.filter(function (x) { return blk.indexOf(x) < 0; });
      if (cur.length) state.picks[dk] = cur; else delete state.picks[dk];
      return;
    }
    var before = JSON.stringify(state.picks);
    state.picks[dk] = cur.concat(blk).sort(function (x, y) { return x - y; });
    var ranges = pickedRanges();
    var tooLong = ranges.some(function (r) { return r.hours.length > CONFIG.maxHours; });
    var tooMany = ranges.length > (CONFIG.maxRanges || 10);
    if (tooLong || tooMany) {
      state.picks = JSON.parse(before);
      note.textContent = tooLong ? 'Подряд в один день можно взять не больше ' + CONFIG.maxHours + ' часов.'
        : 'За одну бронь не больше ' + (CONFIG.maxRanges || 10) + ' промежутков.';
    }
  }

  function clearPicks() { state.picks = {}; $('selNote').textContent = ''; render(); }

  // ---------- отрисовка календаря ----------
  function slotButton(dk, h, withPrice) {
    var st = blockStatus(dk, h), n = slotH();
    var selected = isPicked(dk, h);
    var disabled = !selected && (st === 'busy' || st === 'past');
    var p = blockPrice(h), date = dateFromKey(dk), range = pad(h) + ':00–' + pad(h + n) + ':00';
    var label = fmtLong.format(date) + ', ' + range + ', ' +
      (st === 'busy' ? 'занято' : st === 'past' ? 'недоступно' : p + ' рублей' + (selected ? ', выбрано' : ', свободно'));
    var inner = withPrice
      ? '<span>' + range + '</span><span class="p-val">' + (st === 'busy' ? 'занято' : st === 'past' ? '—' : money(p)) + '</span>'
      : (st === 'busy' || st === 'past' ? '' : num(p));
    return '<button type="button" class="slot ' + (selected ? 'sel' : st) + '" data-date="' + dk + '" data-hour="' + h + '"' +
      (disabled ? ' disabled' : '') + ' aria-label="' + label + '"' + (disabled ? '' : ' aria-pressed="' + selected + '"') + '>' + inner + '</button>';
  }

  function weekLabel(days) {
    var a = dateFromKey(days[0]), b = dateFromKey(days[6]);
    if (a.getMonth() === b.getMonth()) return a.getDate() + '–' + fmtMonthYear.format(b);
    return fmtShort.format(a) + ' – ' + fmtShort.format(b) + ' ' + b.getFullYear();
  }

  function renderCalendar() {
    var ae = document.activeElement, focusKey = null;
    if (ae && ae.dataset && ae.dataset.date) focusKey = { c: ae.closest('#weekGrid') ? 'weekGrid' : 'slotList', d: ae.dataset.date, h: ae.dataset.hour };

    var days = weekDays(), today = studioNow().date;
    $('weekLabel').textContent = weekLabel(days);
    $('prevWeek').disabled = state.weekOffset <= 0;
    $('nextWeek').disabled = state.weekOffset >= MAX_WEEK;
    $('weekGrid').setAttribute('aria-busy', String(state.loading));
    $('slotList').setAttribute('aria-busy', String(state.loading));

    // ночь свёрнута, пока её не раскрыли или пока в ней нет выбранных часов
    var hasNight = CONFIG.openHour < NIGHT_END;
    var nightPicked = days.some(function (d) { return (state.picks[d] || []).some(function (h) { return h < NIGHT_END; }); });
    var showNight = !hasNight || state.showNight || nightPicked;
    var nightBtn = function () {
      if (!hasNight || nightPicked) return '';
      return '<button type="button" class="night-toggle" data-night aria-expanded="' + showNight + '">' +
        (showNight ? 'Свернуть ночные часы' : 'Ночные часы ' + pad(CONFIG.openHour) + ':00–' + pad(NIGHT_END) + ':00') +
        '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>';
    };
    var g = '<div></div>';
    days.forEach(function (d, i) {
      g += '<div class="wk-day' + (d === today ? ' today' : '') + '"><b>' + WD[i] + '</b><span>' + dateFromKey(d).getDate() + '</span></div>';
    });
    g += nightBtn();
    for (var h = CONFIG.openHour; h < CONFIG.closeHour; h += slotH()) {
      if (!showNight && h < NIGHT_END) continue;
      g += '<div class="wk-time">' + pad(h) + '–' + pad(h + slotH()) + '</div>';
      days.forEach(function (d) { g += slotButton(d, h, false); });
    }
    $('weekGrid').innerHTML = g;

    if (!state.day || days.indexOf(state.day) < 0) state.day = days.filter(function (d) { return d >= today; })[0] || days[0];
    var tabs = '';
    days.forEach(function (d, i) {
      var closed = d < today || daysBetween(today, d) > CONFIG.horizonDays;
      tabs += '<button type="button" role="tab" class="daytab' + (state.picks[d] ? ' has-pick' : '') + '" data-day="' + d + '" aria-selected="' + (d === state.day) + '"' + (closed ? ' disabled' : '') +
        ' aria-label="' + fmtLong.format(dateFromKey(d)) + '"><b>' + WD[i] + '</b><span>' + dateFromKey(d).getDate() + '</span></button>';
    });
    $('dayTabs').innerHTML = tabs;
    var list = nightBtn();
    for (var hh = CONFIG.openHour; hh < CONFIG.closeHour; hh += slotH()) { if (showNight || hh >= NIGHT_END) list += slotButton(state.day, hh, true); }
    $('slotList').innerHTML = list;

    if (focusKey) {
      var el = $(focusKey.c).querySelector('[data-date="' + focusKey.d + '"][data-hour="' + focusKey.h + '"]');
      if (el && !el.disabled) el.focus({ preventScroll: true });
    }
  }

  function totals(hours) {
    var nd = hours.filter(function (h) { return h < CONFIG.peakFrom; }).length, np = hours.length - nd;
    return { nd: nd, np: np, total: nd * CONFIG.priceDay + np * CONFIG.pricePeak };
  }

  function renderSummary() {
    var ranges = pickedRanges(), has = ranges.length > 0;
    $('summaryEmpty').hidden = has;
    $('bookForm').hidden = !has;
    if (!has) return;
    var all = [], lines = '';
    ranges.forEach(function (r) { all = all.concat(r.hours); });
    var t = totals(all);
    if (ranges.length === 1) {
      var r0 = ranges[0], min = r0.hours[0], max = r0.hours[r0.hours.length - 1];
      $('chosenDate').textContent = fmtLong.format(dateFromKey(r0.date));
      $('chosenTime').textContent = pad(min) + ':00–' + pad(max + 1) + ':00';
      if (t.nd) lines += '<li><span>' + t.nd + ' ' + plural(t.nd, ['час', 'часа', 'часов']) + ' × ' + money(CONFIG.priceDay) + '</span><span>' + money(t.nd * CONFIG.priceDay) + '</span></li>';
      if (t.np) lines += '<li><span>' + t.np + ' ' + plural(t.np, ['час', 'часа', 'часов']) + ' × ' + money(CONFIG.pricePeak) + '</span><span>' + money(t.np * CONFIG.pricePeak) + '</span></li>';
    } else {
      var days = Object.keys(state.picks).length;
      $('chosenDate').textContent = ranges.length + ' ' + plural(ranges.length, ['промежуток', 'промежутка', 'промежутков']) +
        (days > 1 ? ' в ' + days + ' ' + plural(days, ['день', 'дня', 'дней']) : '');
      $('chosenTime').textContent = all.length + ' ' + plural(all.length, ['час', 'часа', 'часов']);
      ranges.forEach(function (r) {
        var a = r.hours[0], z = r.hours[r.hours.length - 1];
        lines += '<li class="range"><span>' + fmtShort.format(dateFromKey(r.date)) + ' · ' + pad(a) + ':00–' + pad(z + 1) + ':00</span><span>' + money(totals(r.hours).total) + '</span></li>';
      });
    }
    lines += '<li class="clear-line"><button type="button" class="link-btn" id="clearPicks">Очистить выбор</button></li>';
    $('chosenLines').innerHTML = lines;
    $('chosenTotal').textContent = money(t.total);
    $('clearPicks').onclick = clearPicks;
  }

  // ---------- постоянная бронь ----------
  var EVERY = ['каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'];
  // ?subs=preview — показать вариант «Каждую неделю» для проверки ЮKassa, пока автоплатежи не включены (оформить нельзя)
  var SUBS_PREVIEW = /[?&]subs=preview(&|$)/.test(location.search);
  function subsCfg() { return (CONFIG && CONFIG.subscriptions) || (SUBS_PREVIEW ? { weeks: 8, chargeDaysBefore: 3, preview: true } : null); }
  function weekly() { var w = document.querySelector('input[name="freq"][value="weekly"]'); return Boolean(subsCfg() && w && w.checked); }
  function weekSpanBad() {
    var d = pickedRanges().map(function (r) { return r.date; }).sort();
    return d.length > 1 && daysBetween(d[0], d[d.length - 1]) > 6;
  }
  function updateFreq() {
    var s = subsCfg();
    $('freqBox').hidden = !s;
    var on = weekly();
    $('weeklyInfo').hidden = !on;
    $('emailOpt').textContent = on ? 'нужна для ссылки управления и чеков' : 'необязательно';
    $('totalLabel').textContent = on ? 'Сейчас, за первое занятие' : 'Итого';
    if (!on) return;
    var ranges = pickedRanges(), all = [];
    ranges.forEach(function (r) { all = all.concat(r.hours); });
    var sum = money(totals(all).total);
    var when = ranges.map(function (r) {
      var wd = (dateFromKey(r.date).getDay() + 6) % 7;
      return EVERY[wd] + ' ' + pad(r.hours[0]) + ':00–' + pad(r.hours[r.hours.length - 1] + 1) + ':00';
    }).join(', ');
    $('weeklyText').textContent = 'Время закрепится за вами: ' + (when || 'выбранные часы') + ', на ' + s.weeks + ' недель вперёд, дальше продлевается само. ' +
      'Сейчас оплачиваете первое занятие, дальше ' + sum + ' будет списываться с карты за ' + s.chargeDaysBefore + ' дн. до каждого занятия. Отменить можно в любой момент по ссылке из письма.';
    $('autopayText').textContent = 'Согласен на автоматическое списание ' + sum + ' в неделю с привязанной карты за ' + s.chargeDaysBefore + ' дн. до каждого занятия, пока не отменю постоянную бронь';
  }

  function render() { renderCalendar(); renderSummary(); updateFreq(); }

  // ---------- события календаря ----------
  function onSlotClick(e) {
    var b = e.target.closest('.slot'); if (!b || b.disabled) return;
    toggle(b.dataset.date, +b.dataset.hour);
    render();
  }

  // ---------- форма ----------
  function setErr(inputId, errId, msg) {
    var i = $(inputId); $(errId).textContent = msg || '';
    if (i) { if (msg) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid'); }
  }
  var FIELD_MAP = { name: ['fName', 'eName'], phone: ['fPhone', 'ePhone'], email: ['fEmail', 'eEmail'], consent: ['fConsent', 'eConsent'], pdConsent: ['fConsent', 'eConsent'], autopayConsent: ['fAutopay', 'eAutopay'] };

  function validate() {
    var ok = true, first = null;
    var name = $('fName').value.trim(), phone = $('fPhone').value.replace(/\D/g, ''), email = $('fEmail').value.trim();
    var bad = function (id, eid, msg) { setErr(id, eid, msg); ok = false; if (!first) first = $(id); };
    Object.keys(FIELD_MAP).forEach(function (k) { setErr(FIELD_MAP[k][0], FIELD_MAP[k][1]); });
    $('eForm').textContent = '';
    if (name.length < 2) bad('fName', 'eName', 'Введите имя');
    if (phoneDigits($('fPhone').value).length < 10) bad('fPhone', 'ePhone', 'Введите телефон полностью: +7 и 10 цифр');
    if (weekly() && !email) bad('fEmail', 'eEmail', 'Для постоянной брони нужна почта: пришлём ссылку для управления и чеки');
    else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('fEmail', 'eEmail', 'Проверьте почту, например name@mail.ru, или оставьте поле пустым');
    if (weekly() && !$('fAutopay').checked) bad('fAutopay', 'eAutopay', 'Отметьте согласие на автоматическое списание или выберите «Разово»');
    if (weekly() && weekSpanBad()) { $('eForm').textContent = 'Для постоянной брони выберите время в пределах одной недели'; ok = false; }
    if (!$('fConsent').checked) bad('fConsent', 'eConsent', 'Отметьте согласие с правилами и на обработку персональных данных, без него бронь не оформить');
    if (first) first.focus();
    return ok;
  }

  function showServerError(err) {
    var d = err.data || {};
    if (err.status === 400 && d.fields) {
      var first = null;
      Object.keys(FIELD_MAP).forEach(function (k) {
        if (d.fields[k]) { setErr(FIELD_MAP[k][0], FIELD_MAP[k][1], d.fields[k]); if (!first) first = $(FIELD_MAP[k][0]); }
      });
      var other = d.fields.hours || d.fields.date || d.fields.note;
      if (other) $('eForm').textContent = other;
      if (first) first.focus();
      return;
    }
    if (err.status === 409) {
      state.picks = {};
      $('eForm').textContent = '';
      $('selNote').textContent = d.message || 'Это время только что заняли.';
      return loadWeek();
    }
    $('eForm').textContent = err.status ? (d.message || 'Не удалось отправить') : 'Нет связи с сервером. Проверьте интернет и повторите.';
  }

  // ---------- окно оплаты ----------
  var dlg = $('payDialog'), timerId = null, current = null;

  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
  function tick() {
    var left = Math.max(0, current.deadline - Date.now());
    var s = Math.floor(left / 1000);
    $('payTimer').textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60);
    if (left === 0) {
      stopTimer(); destroyWidget();
      chip('Время вышло, бронь снята', true);
      $('payStatus').textContent = 'Оплата не поступила вовремя, слот освобождён. Выберите время заново.';
      if (current) { var gone = current; setTimeout(function () { api('/api/book/' + gone.code + '?token=' + gone.token).catch(function () {}).then(loadWeek); }, 2500); }
      $('payCancel').hidden = true; $('payClose').hidden = false;
      current = null;
      loadWeek();
    }
  }
  function holdLabel(min) {
    if (min % 60 === 0) { var h = min / 60; return h + ' ' + plural(h, ['часа', 'часов', 'часов']); }
    return min + ' ' + plural(min, ['минуты', 'минут', 'минут']);
  }
  function chip(text, bad) { $('payChip').textContent = text; $('payChip').classList.toggle('cancelled', !!bad); }

  // какие части окна видны: transfer (реквизиты), widget (форма ЮKassa), status (итог оплаты)
  var payState = '';   // widget | retry | transfer | status
  function payMode(mode) {
    $('paySumLine').hidden = mode !== 'transfer'; $('payReq').hidden = mode !== 'transfer'; $('payNote').hidden = mode !== 'transfer';
    payState = mode;
    $('payTimer').hidden = mode === 'status'; $('payWidget').hidden = mode !== 'widget';
    $('payStatus').hidden = mode === 'transfer';
    $('payClose').hidden = mode === 'widget' || mode === 'retry';   // во время оплаты окно закрывается только отменой брони
    $('payCancel').hidden = mode === 'status';
    if (mode !== 'widget' && mode !== 'retry') $('paySbp').hidden = true;
  }

  function fillHead(r) {
    $('payTitle').textContent = 'Бронь ' + r.code + ' создана';
    $('payWhen').textContent = (r.whenLabel || (r.dateLabel + ', ' + r.timeLabel)) + ' · ' + money(r.total);
    $('payError').textContent = '';
  }

  // оплата переводом (PAYMENT_PROVIDER=transfer)
  function openPayment(r, email) {
    current = { code: r.code, token: r.token, deadline: new Date(r.deadline).getTime(), online: false };
    stopTimer(); payMode('transfer'); fillHead(r);
    chip('Ожидает оплаты');
    $('paySum').textContent = money(r.total); $('reqSum').textContent = money(r.total);
    $('payHold').textContent = holdLabel(CONFIG.holdMinutes);
    $('reqPurpose').textContent = 'Аренда зала, бронь ' + r.code;
    $('reqRecipient').textContent = r.requisites.recipient;
    $('reqAccount').textContent = r.requisites.account;
    $('reqBank').textContent = r.requisites.bank;
    $('payMail').textContent = email ? 'Мы пришлём письмо на ' + email + ', когда администратор подтвердит поступление.' : 'Когда администратор подтвердит поступление, бронь станет оплаченной. Вопросы: 8 913 658-19-00.';
    tick(); timerId = setInterval(tick, 1000);
    dlg.showModal();
  }

  // ---------- виджет ЮKassa ----------
  var WIDGET_SRC = 'https://yookassa.ru/checkout-widget/v1/checkout-widget.js';
  var widget = null, widgetScript = null;

  function loadWidgetScript() {
    if (window.YooMoneyCheckoutWidget) return Promise.resolve();
    if (widgetScript) return widgetScript;
    widgetScript = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = WIDGET_SRC; el.async = true;
      el.onload = function () { resolve(); };
      el.onerror = function () { widgetScript = null; reject(new Error('script')); };
      document.head.appendChild(el);
    });
    return widgetScript;
  }

  function destroyWidget() {
    if (widget && widget.destroy) { try { widget.destroy(); } catch (e) {} }
    widget = null;
    $('payWidget').innerHTML = '';
  }

  // цвета формы под светлую тему сайта (ЮKassa принимает только HEX)
  var WIDGET_COLORS = {
    control_primary: '#9C5A6A', control_primary_content: '#FFFFFF', background: '#FFFBF7',
    text: '#2A211B', border: '#E3D5C8', control_secondary: '#F4EBE2',
  };
  var WIDGET_ERRORS = {
    token_expired: 'Время на оплату вышло. Оформите бронь заново.',
    invalid_token: 'Платёж не найден. Оформите бронь заново.',
    no_payment_methods_to_display: 'Нет доступных способов оплаты. Напишите нам.',
  };

  function openWidget(r, email) {
    current = { code: r.code, token: r.token, deadline: new Date(r.deadline).getTime(), online: true, sub: r.subscription || null, email: email };
    stopTimer(); destroyWidget(); payMode('widget'); fillHead(r);
    $('paySbp').hidden = Boolean(r.subscription);   // постоянную бронь оплачивают картой
    chip('Ожидает оплаты');
    $('payStatus').textContent = 'Оплатите картой или через СБП. Время на оплату: ' + holdLabel(CONFIG.holdMinutes) + ', потом слот освободится.';
    $('payMail').textContent = email ? 'Подтверждение и чек придут на ' + email + '.' : 'Чек придёт СМС на телефон, итог оплаты появится в этом окне.';
    tick(); timerId = setInterval(tick, 1000);
    dlg.showModal();

    if (r.payment.provider === 'fake') return renderFakeWidget(r.payment.confirmationToken);

    $('payWidget').textContent = 'Загружаем форму оплаты…';
    loadWidgetScript().then(function () {
      if (!current || current.code !== r.code) return;
      $('payWidget').textContent = '';
      widget = new window.YooMoneyCheckoutWidget({
        confirmation_token: r.payment.confirmationToken,
        customization: { colors: WIDGET_COLORS },
        error_callback: function (error) {
          var code = error && (error.error || error.code || error);
          $('payError').textContent = WIDGET_ERRORS[code] || 'Форма оплаты не загрузилась. Обновите страницу и попробуйте ещё раз.';
        },
      });
      // return_url не передаём: тогда виджет не уводит со страницы, а сообщает об итоге событием
      widget.on('complete', function () { afterWidget(); });
      widget.render('payWidget');
    }).catch(function () {
      $('payWidget').textContent = '';
      $('payError').textContent = 'Не удалось загрузить форму оплаты ЮKassa. Проверьте интернет или отключите блокировщик рекламы и обновите страницу.';
    });
  }

  // «Оплатить по СБП»: сервер создаёт платёж СБП, переходим на страницу ЮKassa, оттуда вернёмся с ?pay=КОД
  function onSbp() {
    if (!current) return;
    var b = $('sbpBtn'); b.disabled = true; $('sbpLabel').textContent = 'Открываем СБП…';
    api('/api/book/' + current.code + '/sbp?token=' + current.token, { method: 'POST' }).then(function (r) {
      location.href = r.confirmationUrl;
    }).catch(function (err) {
      b.disabled = false; $('sbpLabel').textContent = 'Оплатить через СБП';
      $('payError').textContent = err.status ? err.message : 'Нет связи с сервером. Попробуйте ещё раз.';
    });
  }

  // вернулись со страницы ЮKassa после СБП: показываем итог оплаты
  function resumeFromSbp() {
    var q = new URLSearchParams(location.search), code = q.get('pay'), token = q.get('t'), fakepay = q.get('fakepay');
    if (!code || !token || !/^[A-Za-z0-9]{4}$/.test(code)) return;
    if (history.replaceState) history.replaceState(null, '', location.pathname + '#booking');
    current = { code: code, token: token, deadline: 0, online: true, sub: null };
    payMode('status'); $('paySbp').hidden = true;
    $('payTitle').textContent = 'Бронь ' + code;
    $('payMail').textContent = '';
    dlg.showModal();
    if (fakepay) { payMode('widget'); $('paySbp').hidden = true; return renderFakeWidget(fakepay); }  // режим разработки
    chip('Проверяем оплату');
    $('payStatus').textContent = 'Проверяем платёж по СБП, это несколько секунд.';
    pollStatus(code, token, 0, 'sbp');
  }

  // вернулись со страницы СБП, а оплаты нет: оплатить ещё раз или отменить бронь (время сразу освободится)
  function sbpUnfinished(r) {
    if (!current) return;
    current.deadline = r.deadline ? new Date(r.deadline).getTime() : current.deadline;
    payMode('retry');
    chip('Ожидает оплаты');
    $('payTitle').textContent = 'Бронь ' + current.code + ' не оплачена';
    $('payStatus').textContent = 'Оплата по СБП не завершена. Попробуйте ещё раз или отмените бронь, тогда время сразу освободится.';
    $('paySbp').hidden = false;
    $('sbpBtn').disabled = false; $('sbpLabel').textContent = 'Оплатить через СБП ещё раз';
    if (current.deadline) { stopTimer(); tick(); timerId = setInterval(tick, 1000); }
  }

  // режим разработки: вместо формы ЮKassa две кнопки, деньги не списываются
  function renderFakeWidget(paymentId) {
    $('payWidget').innerHTML =
      '<div class="fake-widget"><p>Режим разработки: это имитация формы ЮKassa, деньги не списываются.</p>' +
      '<div class="pay-actions"><button type="button" class="btn btn-ghost" data-fake="canceled">Отказаться</button>' +
      '<button type="button" class="btn" data-fake="succeeded">Оплатить</button></div></div>';
    $('payWidget').onclick = function (e) {
      var b = e.target.closest('[data-fake]'); if (!b) return;
      b.disabled = true;
      api('/api/dev/pay/' + paymentId + '?result=' + b.getAttribute('data-fake'), { method: 'POST' })
        .then(afterWidget, function (err) { $('payError').textContent = err.message; b.disabled = false; });
    };
  }

  // форма сообщила, что оплата завершена. Итог узнаём у сервера: он сам спрашивает ЮKassa
  function afterWidget() {
    if (!current) return;
    var c = current;
    destroyWidget(); stopTimer(); payMode('status');
    chip('Проверяем оплату');
    $('payStatus').textContent = 'Проверяем платёж, это несколько секунд.';
    pollStatus(c.code, c.token, 0);
  }

  function pollStatus(code, token, tries, via) {
    api('/api/book/' + code + '?token=' + token).then(function (r) {
      if (r.status === 'paid') {
        var sub = current && current.sub, mail = current && current.email;
        current = null;
        chip('Оплачено');
        $('payTitle').textContent = sub ? 'Постоянная бронь оформлена' : 'Бронь ' + code + ' подтверждена';
        $('payStatus').textContent = sub
          ? 'Первое занятие оплачено. Дальше оплата спишется сама за ' + sub.chargeDaysBefore + ' дн. до каждого занятия: ' + sub.schedule + '.'
          : 'Оплата прошла. Ждём вас в зале.';
        $('payMail').textContent = sub ? 'Письмо со ссылкой для управления и отмены ушло на вашу почту.' : (mail ? 'Подтверждение с адресом и инструкцией ушло на ' + mail + '.' : 'Ключ возьмите за несколько минут до начала в офисе ITB, 3 этаж, офис 307. Вопросы: 8 913 658-19-00.');
        loadWeek();
      } else if (r.status === 'pending') {
        if (via === 'sbp' && tries >= 4) return sbpUnfinished(r);   // ~12 секунд: платёж СБП так и не завершён
        if (tries < 20) return setTimeout(function () { pollStatus(code, token, tries + 1, via); }, 3000);
        $('payStatus').textContent = 'Банк ещё не ответил. Как только оплата пройдёт, мы пришлём письмо.';
      } else {
        current = null;
        chip('Бронь снята', true);
        $('payTitle').textContent = 'Бронь ' + code + ' снята';
        $('payStatus').textContent = 'Оплата не прошла, слот освобождён. Выберите время и попробуйте ещё раз.';
        $('payMail').textContent = 'Если деньги всё же списались, они вернутся автоматически.';
        loadWeek();
      }
    }).catch(function () {
      $('payStatus').textContent = 'Нет связи с сервером. Результат оплаты придёт письмом.';
    });
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    if (weekly() && subsCfg().preview) {
      $('eForm').innerHTML = 'Это демонстрация: постоянная бронь заработает, когда ЮKassa включит автоплатежи. После оплаты первого занятия клиент попадает в <a href="/subscription?demo=1">личный кабинет постоянной брони</a>.';
      return;
    }
    var ranges = pickedRanges(), btn = $('submitBtn'), email = $('fEmail').value.trim();
    btn.disabled = true; btn.textContent = 'Отправляем…';
    api('/api/book', {
      method: 'POST',
      body: {
        ranges: ranges,
        name: $('fName').value.trim(), phone: $('fPhone').value.trim(), email: email,
        purpose: $('fPurpose').value, people: $('fPeople').value ? Number($('fPeople').value) : null,
        note: $('fNote').value.trim(), consent: $('fConsent').checked, pdConsent: $('fConsent').checked, website: $('fWebsite').value,
        recurring: weekly(), autopayConsent: weekly() && $('fAutopay').checked,
      },
    }).then(function (r) {
      state.picks = {};
      $('bookForm').reset();
      updateFreq();
      $('selNote').textContent = '';
      if (r.payment) openWidget(r, email);
      else openPayment(r, email);
      return loadWeek();
    }).catch(showServerError).then(function () {
      btn.disabled = false; btn.textContent = 'Оплатить бронь онлайн';
    });
  }

  function onCancel() {
    if (!current) return;
    var btn = $('payCancel'); btn.disabled = true;
    api('/api/book/' + current.code + '?token=' + current.token, { method: 'DELETE' }).then(function () {
      stopTimer(); destroyWidget(); current = null; dlg.close(); return loadWeek();
    }).catch(function (err) {
      $('payError').textContent = err.status ? err.message : 'Нет связи с сервером. Попробуйте ещё раз.';
    }).then(function () { btn.disabled = false; });
  }

  function onCopy(e) {
    var c = e.target.closest('.copy'); if (!c) return;
    var from = c.getAttribute('data-copy-from');
    var text = from ? $(from).textContent : c.getAttribute('data-copy'), old = c.textContent;
    var done = function () { c.textContent = 'Скопировано'; setTimeout(function () { c.textContent = old; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    else done();
  }

  // ---------- украшения ----------
  // ---------- слайдеры: активный кадр по центру, листаются в обе стороны ----------
  // ширина окна без полосы прокрутки, чтобы слайдер на всю ширину был ровно по центру
  function setViewportVar() { document.documentElement.style.setProperty('--vw', document.documentElement.clientWidth + 'px'); }

  function setupSliders() {
    setViewportVar();
    window.addEventListener('resize', setViewportVar);
    document.querySelectorAll('[data-slider]').forEach(function (track) {
      var slides = Array.prototype.slice.call(track.children);
      var count = track.getAttribute('data-count') ? $(track.getAttribute('data-count')) : null;
      if (!slides.length) return;
      var idx = 0;

      function current() {
        var mid = track.getBoundingClientRect().left + track.clientWidth / 2, best = 0, dist = Infinity;
        slides.forEach(function (sl, i) {
          var r = sl.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid);
          if (d < dist) { dist = d; best = i; }
        });
        return best;
      }
      function go(i, instant) {
        i = (i + slides.length) % slides.length;
        idx = i;
        var sl = slides[i];
        track.scrollTo({ left: sl.offsetLeft + sl.offsetWidth / 2 - track.clientWidth / 2, behavior: instant ? 'auto' : 'smooth' });
      }
      function mark() {
        var i = idx = current();
        slides.forEach(function (sl, j) { sl.classList.toggle('is-active', j === i); });
        if (count) count.textContent = (i + 1) + ' / ' + slides.length;
      }

      document.querySelectorAll('[data-nav="' + track.id + '"]').forEach(function (b) {
        b.addEventListener('click', function () { go(idx + Number(b.getAttribute('data-dir'))); });
      });
      track.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
      });
      var t = null;
      track.addEventListener('scroll', function () { clearTimeout(t); t = setTimeout(mark, 60); }, { passive: true });

      // мышью можно тянуть ленту, как пальцем на телефоне
      var down = null, moved = false;
      track.addEventListener('pointerdown', function (e) {
        if (e.pointerType !== 'mouse') return;
        down = { x: e.clientX, left: track.scrollLeft }; moved = false;
        track.style.scrollSnapType = 'none';
      });
      window.addEventListener('pointermove', function (e) {
        if (!down) return;
        var dx = e.clientX - down.x;
        if (Math.abs(dx) > 5) moved = true;
        track.scrollLeft = down.left - dx;
      });
      window.addEventListener('pointerup', function () {
        if (!down) return;
        down = null; track.style.scrollSnapType = '';
        if (moved) go(current());
      });
      // после перетаскивания клик не должен открывать фото
      track.addEventListener('click', function (e) { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
      track.addEventListener('dragstart', function (e) { e.preventDefault(); });

      // стартуем с середины: соседние кадры видны и слева, и справа
      requestAnimationFrame(function () { go(Math.floor(slides.length / 2), true); mark(); });
      window.addEventListener('resize', function () { go(current(), true); });
    });
  }

  // ---------- просмотр фото на весь экран, с листанием ----------
  function setupLightbox() {
    var box = $('lightbox'); if (!box || !box.showModal) return;
    var img = document.createElement('img'), list = [], pos = 0, opener = null;
    img.id = 'lbImg'; img.alt = '';
    $('lbFigure').insertBefore(img, $('lbFigure').firstChild);

    var all = Array.prototype.slice.call(document.querySelectorAll('img[data-zoom]'));
    all.forEach(function (el) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', 'Открыть фото: ' + (el.alt || 'фото'));
      el.addEventListener('click', function () { open(el); });
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(el); } });
    });

    function group(name) {
      // одно и то же фото может стоять на странице дважды: в листании оставляем его один раз
      var seen = {};
      return all.filter(function (el) {
        var src = el.getAttribute('data-full') || el.src;
        if (el.getAttribute('data-zoom') !== name || seen[src]) return false;
        seen[src] = true; return true;
      });
    }
    function show(i) {
      pos = (i + list.length) % list.length;
      var el = list[pos];
      img.src = el.getAttribute('data-full') || el.currentSrc || el.src;
      img.alt = el.alt;
      $('lbCap').textContent = el.alt;
      $('lbCount').textContent = list.length > 1 ? (pos + 1) + ' / ' + list.length : '';
      $('lbPrev').hidden = $('lbNext').hidden = list.length < 2;
      // соседние фото подгружаем заранее, чтобы листание было без задержки
      [pos + 1, pos - 1].forEach(function (j) { var n = list[(j + list.length) % list.length]; (new Image()).src = n.getAttribute('data-full') || n.src; });
    }
    function open(el) {
      list = group(el.getAttribute('data-zoom'));
      var src = el.getAttribute('data-full') || el.src;
      var i = list.findIndex(function (x) { return (x.getAttribute('data-full') || x.src) === src; });
      opener = el;
      show(i < 0 ? 0 : i);
      box.showModal();
    }
    function close() { box.close(); }

    $('lbPrev').addEventListener('click', function () { show(pos - 1); });
    $('lbNext').addEventListener('click', function () { show(pos + 1); });
    $('lbClose').addEventListener('click', close);
    box.addEventListener('close', function () { img.removeAttribute('src'); if (opener) opener.focus(); });
    // клик по тёмному фону закрывает
    box.addEventListener('click', function (e) { if (e.target === box || e.target.classList.contains('lb-figure')) close(); });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') show(pos + 1);
      if (e.key === 'ArrowLeft') show(pos - 1);
    });
    // листание пальцем
    var x0 = null, y0 = null;
    box.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    box.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(pos + (dx < 0 ? 1 : -1));
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();   // смахнуть вниз — закрыть
      x0 = y0 = null;
    }, { passive: true });
  }

  // ---------- хореография появления при прокрутке ----------
  // [что, как появляется, канон: соседи по группе выходят по очереди]
  var CHOREO = [
    ['main h2', 'stretch'],
    ['.section-lead, .hall-head p', 'rise'],
    ['#hallSlider, .slider-nav', 'rise'],
    ['.how-a', 'left'],
    ['.how-b', 'right'],
    ['.steps li', 'rise', true],
    ['.tariff-day', 'left'],
    ['.tariff-peak', 'right'],
    ['.timeline', 'rise'],
    ['.cal-card', 'rise'],
    ['.summary', 'right'],
    ['.rules > div:not(.rules-photos) h3', 'rise'],
    ['.rules .ticks li', 'left', true],
    ['.rules-photos img', 'curtain', true],
    ['.contact-line', 'left', true],
    ['.map-live', 'right'],
    ['.foot', 'rise'],
  ];

  function setupReveal() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var items = [];
    CHOREO.forEach(function (step) {
      var els = document.querySelectorAll(step[0]);
      els.forEach(function (el) {
        if (el.hasAttribute('data-reveal')) return;
        el.setAttribute('data-reveal', step[1]);
        if (step[2]) {
          // номер среди соседей по группе (не больше 6 счетов, чтобы длинные списки не тянулись)
          var sibs = Array.prototype.filter.call(el.parentNode.children, function (x) { return x.matches(step[0]); });
          el.style.setProperty('--i', Math.min(sibs.indexOf(el), 6));
        }
        items.push(el);
      });
    });
    if (reduce || !('IntersectionObserver' in window)) { items.forEach(function (i) { i.classList.add('in'); }); return; }
    // фото под «занавесом» обрезано целиком, и браузер считает его невидимым: следим за его контейнером
    var targets = new Map();
    items.forEach(function (el) {
      var t = el.getAttribute('data-reveal') === 'curtain' ? el.parentElement : el;
      if (!targets.has(t)) targets.set(t, []);
      targets.get(t).push(el);
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        targets.get(en.target).forEach(function (el) { el.classList.add('in'); });
        io.unobserve(en.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -6% 0px' });
    targets.forEach(function (_, t) { io.observe(t); });
  }

  // ---------- наверх: логотип и кнопка на телефоне ----------
  function setupToTop() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var up = function (e) {
      if (e) e.preventDefault();
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    };
    var brand = document.querySelector('.brand');
    if (brand) brand.addEventListener('click', up);
    var btn = $('toTop'); if (!btn) return;
    btn.addEventListener('click', function (e) { up(e); btn.blur(); });
    var ticking = false;
    var check = function () {
      ticking = false;
      var show = window.scrollY > window.innerHeight * 1.1;
      btn.classList.toggle('show', show);
      btn.tabIndex = show ? 0 : -1;
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(check); } }, { passive: true });
    check();
  }

  // ---------- запуск ----------
  setupReveal();
  setupSliders();
  setupLightbox();
  setupToTop();

  // ---------- маска телефона: +7 (913) 658-19-00 ----------
  // Работает через событие input: мобильные клавиатуры (Android, iOS) часто не присылают keydown с цифрой.
  // Из введённого берём только цифры номера и собираем его заново; курсор ставим после того же числа цифр.
  /** 10 цифр номера без кода страны. Понимает «+7…», «8…», «7…», вставку целого номера. */
  function phoneDigits(v) {
    var s = String(v || ''), d;
    if (/^\s*\+\s*7/.test(s)) d = s.replace(/^\s*\+\s*7/, '').replace(/\D/g, '');
    else { d = s.replace(/\D/g, ''); if (d.length > 10 && (d[0] === '7' || d[0] === '8')) d = d.slice(1); }
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);   // вставили «89136581900» после «+7 (»
    return d.slice(0, 10);
  }
  function phoneFormat(d) {
    if (!d) return '+7 (';
    var s = '+7 (' + d.slice(0, 3);
    if (d.length > 3) s += ') ' + d.slice(3, 6);
    if (d.length > 6) s += '-' + d.slice(6, 8);
    if (d.length > 8) s += '-' + d.slice(8, 10);
    return s;
  }
  function setupPhoneMask() {
    var el = $('fPhone'), prev = '';
    el.setAttribute('inputmode', 'tel');
    el.placeholder = '+7 (___) ___-__-__';
    var apply = function (e) {
      var raw = el.value;
      var caret = el.selectionStart == null ? raw.length : el.selectionStart;
      var d = phoneDigits(raw);
      var before = Math.min(phoneDigits(raw.slice(0, caret)).length, d.length);
      var prevD = phoneDigits(prev);
      // первой набрали 8 или 7 по привычке — это код страны, он уже стоит
      if (!prevD && d.length === 1 && (d === '8' || d === '7')) { d = ''; before = 0; }
      // стёрли скобку, пробел или дефис — цифры не изменились: стираем цифру перед ним
      if (e && e.inputType && e.inputType.indexOf('delete') === 0 && d === prevD && raw.length < prev.length && before > 0) {
        d = d.slice(0, before - 1) + d.slice(before);
        before -= 1;
      }
      var out = phoneFormat(d);
      el.value = out; prev = out;
      var pos = out.length;
      if (before < d.length) {
        pos = 4;                                          // сразу после «+7 (»
        for (var i = 4, seen = 0; i < out.length && seen < before; i++) if (/\d/.test(out[i])) { seen++; pos = i + 1; }
      }
      if (document.activeElement === el && el.setSelectionRange) { try { el.setSelectionRange(pos, pos); } catch (err) {} }
    };
    el.addEventListener('input', apply);
    el.addEventListener('focus', function () {
      if (!el.value) { el.value = '+7 ('; prev = el.value; }
      setTimeout(function () { if (el.setSelectionRange && phoneDigits(el.value).length === 0) el.setSelectionRange(4, 4); }, 0);
    });
    el.addEventListener('blur', function () { if (!phoneDigits(el.value)) { el.value = ''; prev = ''; } });
    if (el.value) apply();
  }

  function bind() {
    $('weekGrid').addEventListener('click', onSlotClick);
    $('slotList').addEventListener('click', onSlotClick);
    ['weekGrid', 'slotList'].forEach(function (id) {
      $(id).addEventListener('click', function (e) {
        if (!e.target.closest('[data-night]')) return;
        state.showNight = !state.showNight; renderCalendar();
        var t = $(id).querySelector('[data-night]'); if (t) t.focus({ preventScroll: true });
      });
    });
    document.querySelectorAll('input[name="freq"]').forEach(function (r) {
      r.addEventListener('change', function () { updateFreq(); $('eForm').textContent = ''; });
    });
    $('fAutopay').addEventListener('change', function () { $('fAutopay').removeAttribute('aria-invalid'); $('eAutopay').textContent = ''; });
    $('sbpBtn').addEventListener('click', onSbp);
    $('dayTabs').addEventListener('click', function (e) {
      var t = e.target.closest('.daytab'); if (!t || t.disabled) return;
      state.day = t.dataset.day; render();
    });
    $('prevWeek').addEventListener('click', function () { if (state.weekOffset > 0) { state.weekOffset--; state.day = null; loadWeek(); } });
    $('nextWeek').addEventListener('click', function () { if (state.weekOffset < MAX_WEEK) { state.weekOffset++; state.day = null; loadWeek(); } });
    $('calRetry').addEventListener('click', boot);
    ['fName', 'fPhone', 'fEmail'].forEach(function (id) {
      $(id).addEventListener('input', function () { $(id).removeAttribute('aria-invalid'); $('e' + id.slice(1)).textContent = ''; });
    });
    setupPhoneMask();
    $('bookForm').addEventListener('submit', onSubmit);
    $('payClose').addEventListener('click', function () { dlg.close(); });
    // крестик: пока идёт оплата, закрыть окно — значит отказаться от брони (слот освобождается); иначе просто закрыть
    $('payX').addEventListener('click', function () {
      if (current && current.online && (payState === 'widget' || payState === 'retry')) {
        if (confirm('Закрыть оплату? Бронь будет снята, а время освободится.')) onCancel();
        return;
      }
      dlg.close();
    });
    var paying = function () { return current && current.online && (payState === 'widget' || payState === 'retry'); };
    dlg.addEventListener('cancel', function (e) { if (paying()) e.preventDefault(); });
    $('payCancel').addEventListener('click', onCancel);
    dlg.addEventListener('click', function (e) { if (e.target === dlg && !paying()) dlg.close(); });
    dlg.addEventListener('click', onCopy);
    // свежее расписание раз в минуту, пока вкладка открыта
    setInterval(function () { if (!document.hidden && CONFIG && !state.loading) loadWeek(); }, 60000);
  }

  var bound = false;
  function boot() {
    $('calError').hidden = true;
    return api('/api/config').then(function (cfg) {
      CONFIG = cfg;
      clock = { date: cfg.today, minutes: cfg.nowMinutes, at: Date.now() };
      MAX_WEEK = Math.floor(cfg.horizonDays / 7);
      // воскресенье после последнего доступного блока: на этой неделе брать нечего, открываем следующую
      var now = studioNow(), dow = (dateFromKey(now.date).getDay() + 6) % 7;
      var lastStart = (cfg.closeHour - (cfg.slotHours || 1)) * 60;
      if (bound === false && dow === 6 && now.minutes + cfg.minLeadMinutes > lastStart) state.weekOffset = 1;
      $('priceDay').textContent = num(cfg.priceDay);
      $('pricePeak').textContent = num(cfg.pricePeak);
      $('formHint').textContent = (cfg.payment === 'transfer' ? 'Оплата переводом на следующем шаге.' : 'Оплата картой или через СБП прямо на сайте, форма ЮKassa.') +
        ' Слот держится ' + holdLabel(cfg.holdMinutes) + '.';
      if (!bound) { bind(); bound = true; resumeFromSbp(); }
      return loadWeek();
    }).catch(function () {
      $('calErrorText').textContent = 'Сервис записи сейчас недоступен. Попробуйте позже или позвоните нам.';
      $('calError').hidden = false;
    });
  }

  boot();
})();

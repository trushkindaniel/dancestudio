/* Зал «Пульс» — фронтенд записи.
   Все цены, занятость и бронь приходят с сервера (/api/*). Браузеру ничего не доверяем:
   сервер сам пересчитывает цену и заново проверяет, что слот свободен. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var nf = new Intl.NumberFormat('ru-RU');
  var num = function (n) { return nf.format(n).replace(/ /g, ' '); };
  var money = function (n) { return num(n) + ' ₽'; };
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
  var state = { weekOffset: 0, day: null, sel: { date: null, hours: [] }, busy: {}, loading: false, failed: false };
  var MAX_WEEK = 8;

  function studioNow() {
    var elapsed = Math.floor((Date.now() - clock.at) / 60000);
    var total = clock.minutes + elapsed;
    return { date: addDays(clock.date, Math.floor(total / 1440)), minutes: total % 1440 };
  }
  var priceOf = function (h) { return h >= CONFIG.peakFrom ? CONFIG.pricePeak : CONFIG.priceDay; };

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
      // выбранный час мог быть занят другим клиентом
      var s = state.sel;
      if (s.date && state.busy[s.date] && s.hours.some(function (h) { return state.busy[s.date].indexOf(h) > -1; })) {
        state.sel = { date: null, hours: [] };
        $('selNote').textContent = 'Выбранное время только что заняли. Выберите другое.';
      }
    }).catch(function () {
      state.failed = true;
    }).then(function () {
      state.loading = false; $('calError').hidden = !state.failed; render();
    });
  }

  // ---------- выбор часов ----------
  function toggle(dk, h) {
    var s = state.sel, note = $('selNote');
    note.textContent = '';
    if (s.date !== dk || !s.hours.length) { state.sel = { date: dk, hours: [h] }; return; }
    var min = s.hours[0], max = s.hours[s.hours.length - 1];
    if ((h === min - 1 || h === max + 1) && s.hours.length >= CONFIG.maxHours) {
      note.textContent = 'За одну бронь не больше ' + CONFIG.maxHours + ' часов.'; return;
    }
    if (h === min - 1) s.hours.unshift(h);
    else if (h === max + 1) s.hours.push(h);
    else if (s.hours.length === 1 && h === min) state.sel = { date: null, hours: [] };
    else if (h === min) s.hours.shift();
    else if (h === max) s.hours.pop();
    else state.sel = { date: dk, hours: [h] };
  }

  // ---------- отрисовка календаря ----------
  function slotButton(dk, h, withPrice) {
    var st = slotStatus(dk, h);
    var selected = state.sel.date === dk && state.sel.hours.indexOf(h) > -1;
    var disabled = !selected && (st === 'busy' || st === 'past');
    var p = priceOf(h), date = dateFromKey(dk);
    var label = fmtLong.format(date) + ', ' + pad(h) + ':00, ' +
      (st === 'busy' ? 'занято' : st === 'past' ? 'недоступно' : p + ' рублей' + (selected ? ', выбрано' : ', свободно'));
    var inner = withPrice
      ? '<span>' + pad(h) + ':00</span><span class="p-val">' + (st === 'busy' ? 'занято' : st === 'past' ? '—' : money(p)) + '</span>'
      : (st === 'busy' || st === 'past' ? '' : p);
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

    var g = '<div></div>';
    days.forEach(function (d, i) {
      g += '<div class="wk-day' + (d === today ? ' today' : '') + '"><b>' + WD[i] + '</b><span>' + dateFromKey(d).getDate() + '</span></div>';
    });
    for (var h = CONFIG.openHour; h < CONFIG.closeHour; h++) {
      g += '<div class="wk-time">' + pad(h) + ':00</div>';
      days.forEach(function (d) { g += slotButton(d, h, false); });
    }
    $('weekGrid').innerHTML = g;

    if (!state.day || days.indexOf(state.day) < 0) state.day = days.filter(function (d) { return d >= today; })[0] || days[0];
    var tabs = '';
    days.forEach(function (d, i) {
      var closed = d < today || daysBetween(today, d) > CONFIG.horizonDays;
      tabs += '<button type="button" role="tab" class="daytab" data-day="' + d + '" aria-selected="' + (d === state.day) + '"' + (closed ? ' disabled' : '') +
        ' aria-label="' + fmtLong.format(dateFromKey(d)) + '"><b>' + WD[i] + '</b><span>' + dateFromKey(d).getDate() + '</span></button>';
    });
    $('dayTabs').innerHTML = tabs;
    var list = '';
    for (var hh = CONFIG.openHour; hh < CONFIG.closeHour; hh++) list += slotButton(state.day, hh, true);
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
    var s = state.sel, has = s.date && s.hours.length;
    $('summaryEmpty').hidden = !!has;
    $('bookForm').hidden = !has;
    if (!has) return;
    var t = totals(s.hours), min = s.hours[0], max = s.hours[s.hours.length - 1];
    $('chosenDate').textContent = fmtLong.format(dateFromKey(s.date));
    $('chosenTime').textContent = pad(min) + ':00–' + pad(max + 1) + ':00';
    var lines = '';
    if (t.nd) lines += '<li><span>' + t.nd + ' ' + plural(t.nd, ['час', 'часа', 'часов']) + ' × ' + money(CONFIG.priceDay) + '</span><span>' + money(t.nd * CONFIG.priceDay) + '</span></li>';
    if (t.np) lines += '<li><span>' + t.np + ' ' + plural(t.np, ['час', 'часа', 'часов']) + ' × ' + money(CONFIG.pricePeak) + '</span><span>' + money(t.np * CONFIG.pricePeak) + '</span></li>';
    $('chosenLines').innerHTML = lines;
    $('chosenTotal').textContent = money(t.total);
  }

  function render() { renderCalendar(); renderSummary(); }

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
  var FIELD_MAP = { name: ['fName', 'eName'], phone: ['fPhone', 'ePhone'], email: ['fEmail', 'eEmail'], consent: ['fConsent', 'eConsent'] };

  function validate() {
    var ok = true, first = null;
    var name = $('fName').value.trim(), phone = $('fPhone').value.replace(/\D/g, ''), email = $('fEmail').value.trim();
    var bad = function (id, eid, msg) { setErr(id, eid, msg); ok = false; if (!first) first = $(id); };
    Object.keys(FIELD_MAP).forEach(function (k) { setErr(FIELD_MAP[k][0], FIELD_MAP[k][1]); });
    $('eForm').textContent = '';
    if (name.length < 2) bad('fName', 'eName', 'Введите имя');
    if (phone.length < 10) bad('fPhone', 'ePhone', 'Введите телефон полностью');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('fEmail', 'eEmail', 'Проверьте почту, например name@mail.ru');
    if (!$('fConsent').checked) bad('fConsent', 'eConsent', 'Нужно согласие, чтобы оформить бронь');
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
      state.sel = { date: null, hours: [] };
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
      stopTimer();
      $('payChip').textContent = 'Время вышло, бронь снята'; $('payChip').classList.add('cancelled');
      loadWeek();
    }
  }
  function openPayment(r, email) {
    current = { code: r.code, token: r.token, deadline: new Date(r.deadline).getTime() };
    stopTimer();
    $('payChip').textContent = 'Ожидает оплаты'; $('payChip').classList.remove('cancelled');
    $('payTitle').textContent = 'Бронь ' + r.code + ' создана';
    $('payWhen').textContent = r.dateLabel + ', ' + r.timeLabel;
    $('paySum').textContent = money(r.total); $('reqSum').textContent = money(r.total);
    $('reqPurpose').textContent = 'Аренда зала, бронь ' + r.code;
    $('reqRecipient').textContent = r.requisites.recipient;
    $('reqAccount').textContent = r.requisites.account;
    $('reqBank').textContent = r.requisites.bank;
    $('payMail').textContent = 'Мы пришлём письмо на ' + email + ', когда администратор подтвердит поступление.';
    $('payError').textContent = '';
    $('payCancel').hidden = false;
    tick(); timerId = setInterval(tick, 1000);
    dlg.showModal();
  }

  function onSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    var s = state.sel, btn = $('submitBtn'), email = $('fEmail').value.trim();
    btn.disabled = true; btn.textContent = 'Отправляем…';
    api('/api/book', {
      method: 'POST',
      body: {
        date: s.date, hours: s.hours.slice(),
        name: $('fName').value.trim(), phone: $('fPhone').value.trim(), email: email,
        note: $('fNote').value.trim(), consent: $('fConsent').checked, website: $('fWebsite').value,
      },
    }).then(function (r) {
      state.sel = { date: null, hours: [] };
      $('bookForm').reset();
      $('selNote').textContent = '';
      openPayment(r, email);
      return loadWeek();
    }).catch(showServerError).then(function () {
      btn.disabled = false; btn.textContent = 'Забронировать';
    });
  }

  function onCancel() {
    if (!current) return;
    var btn = $('payCancel'); btn.disabled = true;
    api('/api/book/' + current.code + '?token=' + current.token, { method: 'DELETE' }).then(function () {
      stopTimer(); current = null; dlg.close(); return loadWeek();
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
  function buildEqualizer() {
    var eq = $('eq'); if (!eq) return;
    var html = '';
    for (var i = 0; i < 26; i++) {
      var h = 30 + Math.round(Math.abs(Math.sin(i * 1.7)) * 70);
      html += '<i style="--h:' + h + '%;--d:-' + (i * 0.13).toFixed(2) + 's"></i>';
    }
    eq.innerHTML = html;
  }

  function setupReveal() {
    var items = document.querySelectorAll('.reveal');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) { items.forEach(function (i) { i.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    items.forEach(function (i) { io.observe(i); });
  }

  // ---------- запуск ----------
  buildEqualizer();
  setupReveal();

  function bind() {
    $('weekGrid').addEventListener('click', onSlotClick);
    $('slotList').addEventListener('click', onSlotClick);
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
    $('bookForm').addEventListener('submit', onSubmit);
    $('payClose').addEventListener('click', function () { dlg.close(); });
    $('payCancel').addEventListener('click', onCancel);
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
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
      $('priceDay').textContent = num(cfg.priceDay);
      $('pricePeak').textContent = num(cfg.pricePeak);
      if (!bound) { bind(); bound = true; }
      return loadWeek();
    }).catch(function () {
      $('calErrorText').textContent = 'Сервис записи сейчас недоступен. Попробуйте позже или позвоните нам.';
      $('calError').hidden = false;
    });
  }

  boot();
})();

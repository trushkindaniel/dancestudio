'use strict';
/* Шаблоны писем. Каждый возвращает { subject, text, html } и при необходимости вложения.
   Письма клиенту: бронь создана, бронь оплачена (с инструкцией и событием для календаря), бронь снята, возврат.
   Письмо администратору: оплата прошла.
   Всё, что ввёл клиент (имя, почта, телефон), экранируется: письмо нельзя «сломать» вводом в форму. */

const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const nb = (s) => String(s).replace(/ /g, ' ');   // телефон не разрывается переносом
const money = (n) => `${new Intl.NumberFormat('ru-RU').format(Number(n) || 0).replace(/ /g, ' ')} ₽`;

/** «17:45» — во сколько забрать ключ: за N минут до начала аренды */
function pickupTime(startHour, beforeMin) {
  const m = startHour * 60 - beforeMin;
  // аренда с 00:00 — ключ забирают накануне вечером
  if (m < 0) { const w = m + 24 * 60; return `${pad(Math.floor(w / 60))}:${pad(w % 60)} накануне`; }
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Промежутки брони; у старой одиночной брони — один */
const rangesOf = (b) => (Array.isArray(b.ranges) && b.ranges.length ? b.ranges : [b]);
const whenLines = (b) => rangesOf(b).map((r) => `${r.dateLabel}, ${r.timeLabel}`);
// ключ забирают за несколько минут до начала: в письмах указываем время начала аренды
const keyTimes = (cfg, b) => rangesOf(b).map((r) => ({ at: `${pad(r.startHour)}:00`, date: r.dateLabel }));

/** Общая обёртка: светлое письмо, читается в любом почтовом клиенте, без внешних картинок */
function layout(cfg, { preheader, title, body }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4ece5;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4ece5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#2a211b;">
<tr><td style="background:#1f1814;padding:22px 28px;">
  <div style="font-family:'Great Vibes','Segoe Script','Brush Script MT',cursive;font-size:34px;line-height:1;color:#e3afba;">${esc(cfg.studioName)}</div>
  <div style="margin-top:6px;font-size:13px;color:#b9a797;">Аренда танцевального зала по часам · Омск</div>
</td></tr>
<tr><td style="padding:28px;">
  <h1 style="margin:0 0 16px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:26px;line-height:1.25;color:#2a211b;">${esc(title)}</h1>
  ${body}
</td></tr>
<tr><td style="padding:18px 28px;background:#faf6f2;font-size:13px;line-height:1.5;color:#7a6a5c;">
  ${esc(cfg.venue.address)}<br>
  Телефон: <a href="tel:+7${esc(cfg.venue.phone.replace(/\D/g, '').slice(-10))}" style="color:#b0707f;">${esc(nb(cfg.venue.phone))}</a> ·
  <a href="${esc(cfg.venue.mapUrl)}" style="color:#b0707f;">на карте</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

const row = (k, v) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eee3da;color:#7a6a5c;font-size:14px;width:38%;vertical-align:top;">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #eee3da;font-size:15px;font-weight:bold;">${v}</td></tr>`;
const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rows.join('')}</table>`;
const p = (t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${t}</p>`;
const button = (href, label) => `<p style="margin:20px 0 4px;"><a href="${esc(href)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#b0707f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;">${esc(label)}</a></p>`;

/** Пошаговая инструкция: где взять ключ, куда идти, что сделать в конце */
function instructions(cfg, b) {
  const v = cfg.venue;
  const keys = keyTimes(cfg, b);
  const multi = keys.length > 1;
  const at = keys[0].at;
  const whenHtml = multi ? `<b>За несколько минут до начала каждой аренды</b> (${keys.map((k) => `${esc(k.date)} — начало в ${k.at}`).join('; ')})` : `<b>За несколько минут до начала</b> (аренда начинается в ${at})`;
  const whenText = multi ? `За несколько минут до начала каждой аренды (${keys.map((k) => `${k.date} — начало в ${k.at}`).join('; ')})` : `За несколько минут до начала (аренда начинается в ${at})`;
  const steps = [
    `${whenHtml} зайдите в <b>${esc(v.keyPickup)}</b> и заберите ключ от зала.`,
    `Поднимитесь в зал: <b>${esc(v.address.replace(/^.*?,\s*(?=\d+ этаж)/, '') || v.address)}</b>.`,
    'Приходите в сменной обуви или возьмите ту, что есть в зале. Время аренды считается с начала часа.',
    '<b>Перед уходом всё закройте:</b> окна, свет, дверь зала. Если следующий тренер уже пришёл, можно оставить ему открытым.',
    `После аренды <b>верните ключ на ${esc(v.keyReturn)}</b>. Если арендуете постоянно, выдадим вам постоянный ключ.`,
  ];
  const text = [
    `1. ${whenText} зайдите в ${v.keyPickup} и заберите ключ от зала.`,
    `2. Поднимитесь в зал: ${v.address}.`,
    '3. Приходите в сменной обуви или возьмите ту, что есть в зале. Время аренды считается с начала часа.',
    '4. Перед уходом всё закройте: окна, свет, дверь зала. Если следующий тренер уже пришёл, можно оставить ему открытым.',
    `5. После аренды верните ключ на ${v.keyReturn}. Если арендуете постоянно, выдадим вам постоянный ключ.`,
  ].join('\n');
  const html = `<h2 style="margin:24px 0 10px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:20px;">Как попасть в зал</h2>
<ol style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;">${steps.map((s) => `<li style="margin-bottom:8px;">${s}</li>`).join('')}</ol>`;
  return { text, html, pickupAt: at, keys };
}

/** Событие для календаря клиента (.ics): время в UTC, напоминание за час */
function icsEvent(cfg, b) {
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const clean = (x) => String(x).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
  const stamp = f(new Date());
  const events = rangesOf(b).map((r, i) => [
    'BEGIN:VEVENT',
    `UID:booking-${b.code}-${i + 1}@arenda-zala-55`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${f(r.start)}`,
    `DTEND:${f(r.end)}`,
    `SUMMARY:${clean(`Аренда зала ${cfg.studioName}, бронь ${b.code}`)}`,
    `LOCATION:${clean(cfg.venue.address)}`,
    `DESCRIPTION:${clean(`Ключ: ${cfg.venue.keyPickup}, за несколько минут до начала. После аренды верните ключ на ${cfg.venue.keyReturn}. Телефон: ${cfg.venue.phone}`)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', `DESCRIPTION:${clean('Через час аренда зала')}`, 'END:VALARM',
    'END:VEVENT',
  ].join('\r\n'));
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arenda zala 55//booking//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

const when = (b) => whenLines(b).join('; ');
const whenHtml = (b) => whenLines(b).map(esc).join('<br>');

const templates = {
  /** Клиенту: бронь создана, ждём оплату */
  clientCreated(cfg, b) {
    const pay = b.online
      ? `Оплатите бронь в форме ЮKassa на сайте, она открылась после нажатия «Оплатить бронь онлайн». Слот держится до ${b.deadlineLabel}, потом освободится автоматически.`
      : `Переведите сумму по реквизитам. Получатель: ${cfg.requisites.recipient}. Счёт: ${cfg.requisites.account}. Банк: ${cfg.requisites.bank}. Назначение: «Аренда зала, бронь ${b.code}». Слот держится до ${b.deadlineLabel}.`;
    const subject = `Бронь ${b.code}: ${rangesOf(b).length > 1 ? b.dateLabel : when(b)}`;
    const text = `Здравствуйте, ${b.name}!\n\nБронь ${b.code} создана: ${when(b)}.\nК оплате: ${money(b.total)}.\n\n${pay}\nКак только оплата пройдёт, мы пришлём письмо с адресом и инструкцией, где взять ключ.\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: `Бронь ${b.code} ждёт оплаты`, title: `Бронь ${b.code} ждёт оплаты`,
      body: p(`Здравствуйте, ${esc(b.name)}!`) + table([row('Когда', whenHtml(b)), row('К оплате', esc(money(b.total)))]) + p(esc(pay)) +
        p('Как только оплата пройдёт, мы пришлём письмо с адресом и инструкцией, где взять ключ.'),
    });
    return { subject, text, html };
  },

  /** Клиенту: оплата прошла, вот время, адрес и инструкция */
  clientPaid(cfg, b) {
    const ins = instructions(cfg, b);
    const subject = `Бронь ${b.code} подтверждена: ${rangesOf(b).length > 1 ? b.dateLabel : when(b)}`;
    const text = `Здравствуйте, ${b.name}!\n\nОплата получена, зал ваш.\n\nКогда:\n${whenLines(b).map((l) => '  ' + l).join('\n')}\nАдрес: ${cfg.venue.address}\nОплачено: ${money(b.total)}\nКод брони: ${b.code}\n\nКак попасть в зал:\n${ins.text}\n\nКарта: ${cfg.venue.mapUrl}\nВопросы: ${cfg.venue.phone}\n\nВ письме есть файл для календаря, чтобы не забыть.${b.subUrl ? '\nЭто занятие из вашей постоянной брони. Управлять: ' + b.subUrl : ''}\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: `Ключ: ${cfg.venue.keyPickup}, за несколько минут до начала`, title: 'Оплата получена, зал ваш',
      body: p(`Здравствуйте, ${esc(b.name)}!`) + table([
        row('Когда', whenHtml(b)),
        row('Адрес', esc(cfg.venue.address)),
        row('Ключ', `${esc(cfg.venue.keyPickup)}, за несколько минут до начала`),
        row('Оплачено', esc(money(b.total))),
        row('Код брони', esc(b.code)),
      ]) + ins.html + button(cfg.venue.mapUrl, 'Открыть на карте') +
        (b.subUrl ? p(`Это занятие из вашей постоянной брони. <a href="${esc(b.subUrl)}" style="color:#b0707f;">Управлять или отменить</a>.`) : '') +
        p(`<span style="color:#7a6a5c;font-size:13px;">Добавьте аренду в календарь: файл во вложении. Вопросы — по телефону ${esc(nb(cfg.venue.phone))}.</span>`),
    });
    return { subject, text, html, attachments: [{ filename: `bron-${b.code}.ics`, content: icsEvent(cfg, b), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] };
  },

  /** Администратору: оплата прошла */
  adminPaid(cfg, b) {
    const extra = [b.purpose && `Формат: ${b.purpose}`, b.people && `Человек: ${b.people}`].filter(Boolean);
    const subject = `Оплата прошла: бронь ${b.code}, ${rangesOf(b).length > 1 ? b.dateLabel : when(b)}, ${money(b.total)}`;
    const text = `Оплачена бронь ${b.code}.\n\nКогда:\n${whenLines(b).map((l) => '  ' + l).join('\n')}\nКлиент: ${b.name}\nТелефон: ${b.phone}\nПочта: ${b.email || 'не указана'}\nСумма: ${money(b.total)}\n${extra.join('\n')}\n\nКлюч выдать к началу аренды: ${keyTimes(cfg, b).map((k) => `${k.date} в ${k.at}`).join('; ')} (${cfg.venue.keyPickup}).\nСобытие в календаре стало зелёным.`;
    const html = layout(cfg, {
      preheader: `${b.name}, ${when(b)}`, title: `Оплата прошла: бронь ${b.code}`,
      body: table([
        row('Когда', whenHtml(b)),
        row('Клиент', esc(b.name)),
        row('Телефон', `<a href="tel:${esc(String(b.phone).replace(/[^\d+]/g, ''))}" style="color:#b0707f;">${esc(b.phone)}</a>`),
        row('Почта', b.email ? `<a href="mailto:${esc(b.email)}" style="color:#b0707f;">${esc(b.email)}</a>` : 'не указана'),
        row('Сумма', esc(money(b.total))),
        ...(b.purpose ? [row('Формат', esc(b.purpose))] : []),
        ...(b.people ? [row('Человек', esc(b.people))] : []),
      ]) + p(`Ключ выдать к началу аренды: <b>${keyTimes(cfg, b).map((k) => `${esc(k.date)} в ${k.at}`).join('; ')}</b> (${esc(cfg.venue.keyPickup)}). События в календаре стали зелёными.`),
    });
    return { subject, text, html };
  },

  /** Клиенту: бронь снята (нет оплаты или оплата не прошла) */
  loginLink(cfg, b) {
    const subject = b.isNew ? 'Регистрация в личном кабинете' : 'Вход в личный кабинет';
    const what = b.isNew ? 'Чтобы завершить регистрацию и войти в личный кабинет' : 'Чтобы войти в личный кабинет';
    const text = `Здравствуйте!\n\n${what} «${cfg.studioName}», откройте ссылку:\n${b.url}\n\nСсылка действует ${b.minutes} минут и срабатывает один раз. Если вы не запрашивали вход, просто удалите это письмо.\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: `Ссылка действует ${b.minutes} минут`, title: subject,
      body: p('Здравствуйте!') + p(`${esc(what)}, нажмите на кнопку. В кабинете видны ваши брони и постоянная бронь, там же можно управлять картой для оплаты.`) +
        button(b.url, b.isNew ? 'Завершить регистрацию' : 'Войти в кабинет') +
        p(`<span style="color:#7a6a5c;font-size:13px;">Ссылка действует ${b.minutes} минут и срабатывает один раз. Если вы не запрашивали вход, просто удалите это письмо.</span>`),
    });
    return { subject, text, html };
  },

  clientExpired(cfg, b) {
    const failed = b.reason === 'payment_canceled';
    const why = failed ? 'Оплата не прошла, слот освобождён.' : 'Оплата не поступила вовремя, слот освобождён.';
    const subject = `Бронь ${b.code} снята`;
    const text = `Здравствуйте, ${b.name}!\n\n${why} Бронь ${b.code} (${when(b)}).\nЧтобы записаться, выберите время на сайте заново.${failed ? '' : ' Если вы уже оплатили, позвоните нам: ' + cfg.venue.phone + '.'}\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: why, title: `Бронь ${b.code} снята`,
      body: p(`Здравствуйте, ${esc(b.name)}!`) + p(`${esc(why)} Бронь на ${esc(when(b))}.`) +
        p('Чтобы записаться, выберите время на сайте заново.' + (failed ? '' : ` Если вы уже оплатили, позвоните нам: ${esc(cfg.venue.phone)}.`)),
    });
    return { subject, text, html };
  },

  /** Клиенту: деньги вернули (оплата пришла после снятия брони) */
  clientRefunded(cfg, b) {
    const subject = `Возврат оплаты за бронь ${b.code}`;
    const text = `Здравствуйте!\n\nОплата за бронь ${b.code} пришла после того, как бронь была снята, поэтому мы вернули ${money(b.total)}. Деньги вернутся тем же способом, обычно за несколько дней.\nЧтобы записаться снова, выберите время на сайте.\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: `Вернули ${money(b.total)}`, title: 'Мы вернули оплату',
      body: p(`Оплата за бронь ${esc(b.code)} пришла после того, как бронь была снята, поэтому мы вернули <b>${esc(money(b.total))}</b>.`) +
        p('Деньги вернутся тем же способом, обычно за несколько дней. Чтобы записаться снова, выберите время на сайте.'),
    });
    return { subject, text, html };
  },
};


const fmtWhen = (iso, tz) => new Date(iso).toLocaleString('ru-RU', { timeZone: tz, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const DECLINE = {
  insufficient_funds: 'на карте недостаточно средств',
  card_expired: 'истёк срок действия карты',
  permission_revoked: 'вы отключили автосписания для этой карты',
  payment_method_restricted: 'банк ограничил операции по карте',
};

/**
 * Письма постоянной брони. s — сведения о ней: id, name, email, schedule («каждую среду 12:00–13:00»),
 * weekTotal, weeks, chargeDaysBefore, card, url (ссылка управления) и поля конкретного события.
 */
const subTemplates = {
  started(cfg, s) {
    const rule = s.autopay === false
      ? `За ${s.chargeDaysBefore} дн. до каждого следующего занятия пришлём письмо с суммой ${money(s.weekTotal)} и кнопкой оплаты, оплатить можно и в личном кабинете. После оплаты придёт письмо с инструкцией и чек.`
      : `Оплата ${money(s.weekTotal)} за каждое следующее занятие спишется с карты ${s.card} автоматически за ${s.chargeDaysBefore} дн. до занятия. Перед каждым занятием придёт письмо с инструкцией и чек.`;
    const subject = `Постоянная бронь оформлена: ${s.schedule}`;
    const text = `Здравствуйте, ${s.name}!\n\nПостоянная бронь оформлена: ${s.schedule}.\nЗа вами закреплено время на ${s.weeks} недель вперёд, дальше бронь продлевается сама.\n${(s.reserved || []).map((l) => '  ' + l).join('\n')}\n\n${rule}\n\nОтменить постоянную бронь можно в любой момент: ${s.url}\nОплаченные занятия останутся за вами.\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: s.schedule, title: 'Постоянная бронь оформлена',
      body: p(`Здравствуйте, ${esc(s.name)}!`) + table([
        row('Когда', esc(s.schedule)),
        row('За неделю', esc(money(s.weekTotal))),
        row('Карта', esc(s.card)),
      ]) + p(`За вами закреплено время на ${s.weeks} недель вперёд, дальше бронь продлевается сама.`) +
        ((s.reserved || []).length ? p(`<span style="color:#7a6a5c;font-size:14px;">Следующие занятия: ${(s.reserved || []).map(esc).join('; ')}</span>`) : '') +
        p(esc(rule)) + button(s.url, 'Управлять постоянной бронью') +
        p('<span style="color:#7a6a5c;font-size:13px;">Отменить можно в любой момент по этой ссылке, оплаченные занятия останутся за вами.</span>'),
    });
    return { subject, text, html };
  },

  card_not_saved(cfg, s) {
    const subject = 'Постоянную бронь оформить не удалось';
    const msg = 'Оплата первого занятия прошла, оно за вами. Но карту для автосписаний сохранить не удалось (этот способ оплаты не поддерживает повторные списания), поэтому следующие недели мы освободили.';
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\nЧтобы оформить постоянную бронь, выберите время на сайте ещё раз и оплатите банковской картой. Вопросы: ${cfg.venue.phone}.\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Постоянную бронь оформить не удалось', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) + p(`Чтобы оформить постоянную бронь, выберите время на сайте ещё раз и оплатите банковской картой. Вопросы: ${esc(nb(cfg.venue.phone))}.`) });
    return { subject, text, html };
  },

  charge_failed(cfg, s) {
    const why = DECLINE[s.reason] ? ` (${DECLINE[s.reason]})` : '';
    const subject = `Не удалось списать оплату за ${s.weekLabel}`;
    const text = `Здравствуйте, ${s.name}!\n\nНе удалось списать ${money(s.amount)} с карты ${s.card} за занятие ${s.weekLabel}${why}.\nПопробуем ещё раз ${fmtWhen(s.nextTryAt, cfg.tz)}. Если до начала останется меньше суток, а оплаты не будет, занятие освободится и постоянная бронь встанет на паузу.\nПроверьте карту или позвоните нам: ${cfg.venue.phone}.\nУправлять бронью: ${s.url}\n\n${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: `Не прошло списание ${money(s.amount)}`, title: 'Не удалось списать оплату',
      body: p(`Здравствуйте, ${esc(s.name)}!`) + p(`Не удалось списать <b>${esc(money(s.amount))}</b> с карты ${esc(s.card)} за занятие <b>${esc(s.weekLabel)}</b>${esc(why)}.`) +
        p(`Попробуем ещё раз ${esc(fmtWhen(s.nextTryAt, cfg.tz))}. Если до начала останется меньше суток, а оплаты не будет, занятие освободится и постоянная бронь встанет на паузу.`) +
        p(`Проверьте карту или позвоните нам: ${esc(nb(cfg.venue.phone))}.`) + button(s.url, 'Управлять постоянной бронью'),
    });
    return { subject, text, html };
  },

  pay_due(cfg, s) {
    const subject = `Оплатите занятие ${s.weekLabel}`;
    const msg = `Пора оплатить следующее занятие постоянной брони: ${s.weekLabel}, ${money(s.amount)}. Оплатить картой или по СБП можно в личном кабинете до ${s.payBefore}, иначе время освободится.`;
    const text = `Здравствуйте, ${s.name}!

${msg}
Оплатить: ${s.url}

Вопросы: ${cfg.venue.phone}.

${cfg.studioName}`;
    const html = layout(cfg, {
      preheader: msg, title: 'Оплатите следующее занятие',
      body: p(`Здравствуйте, ${esc(s.name)}!`) + table([row('Занятие', esc(s.weekLabel)), row('Сумма', esc(money(s.amount))), row('Оплатить до', esc(s.payBefore))]) +
        p('Оплатить можно картой или по СБП в личном кабинете. Если оплаты не будет, время освободится.') + button(s.url, 'Оплатить занятие'),
    });
    return { subject, text, html };
  },

  paused(cfg, s) {
    const subject = `Постоянная бронь на паузе: ${s.schedule}`;
    const msg = `Оплата за занятие ${s.weekLabel} не прошла, поэтому мы освободили это время и следующие закреплённые недели.`;
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\nЧтобы снова закрепить время, позвоните нам (${cfg.venue.phone}) или оформите постоянную бронь на сайте заново.\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Постоянная бронь на паузе', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) + p(`Чтобы снова закрепить время, позвоните нам (${esc(nb(cfg.venue.phone))}) или оформите постоянную бронь на сайте заново.`) });
    return { subject, text, html };
  },

  skipped(cfg, s) {
    const subject = `Время ${s.weekLabel} занято`;
    const msg = `На ${s.weekLabel} время уже было занято, поэтому эту неделю закрепить не получилось. Остальные занятия постоянной брони остаются за вами, оплата за эту неделю не спишется.`;
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\nВопросы: ${cfg.venue.phone}.\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Одна неделя занята', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) + button(s.url, 'Управлять постоянной бронью') });
    return { subject, text, html };
  },

  card_unbound(cfg, s) {
    const subject = 'Карта отвязана от постоянной брони';
    const msg = `Карта ${s.card} отвязана, автосписаний больше не будет. Неоплаченные занятия освобождены, постоянная бронь на паузе. Чтобы продолжить, привяжите карту в личном кабинете.`;
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\nЛичный кабинет: ${s.url}\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Карта отвязана', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) + button(s.url, 'Личный кабинет') });
    return { subject, text, html };
  },

  card_bound(cfg, s) {
    const subject = 'Карта привязана к постоянной брони';
    const msg = s.autopay === false
      ? `Карта ${s.card} привязана к постоянной брони, проверочный 1 ₽ мы вернули. За ${s.chargeDaysBefore} дн. до каждого занятия пришлём письмо с кнопкой оплаты.`
      : `Карта ${s.card} привязана. Оплата ${money(s.weekTotal)} за каждое занятие будет списываться с неё за ${s.chargeDaysBefore} дн. до занятия. Проверочный 1 ₽ мы вернули.`;
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\nЛичный кабинет: ${s.url}\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Карта привязана', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) + button(s.url, 'Личный кабинет') });
    return { subject, text, html };
  },

  cancelled(cfg, s) {
    const subject = `Постоянная бронь отменена: ${s.schedule}`;
    const msg = 'Постоянная бронь отменена. Будущие неоплаченные занятия освобождены, автосписаний больше не будет. Уже оплаченные занятия остаются за вами.';
    const text = `Здравствуйте, ${s.name}!\n\n${msg}\n\n${cfg.studioName}`;
    const html = layout(cfg, { preheader: msg, title: 'Постоянная бронь отменена', body: p(`Здравствуйте, ${esc(s.name)}!`) + p(esc(msg)) });
    return { subject, text, html };
  },
};

/** Администратору: что произошло с постоянной бронью */
const ADMIN_TITLE = {
  started: 'оформлена', card_not_saved: 'карта не сохранилась, недели освобождены', charge_failed: 'не прошло списание',
  paused: 'на паузе: не оплачено к сроку, время освобождено', skipped: 'неделя пропущена: время занято', cancelled: 'отменена клиентом',
  card_unbound: 'клиент отвязал карту, бронь на паузе', card_bound: 'клиент привязал карту', pay_due: 'клиенту отправлена ссылка на оплату занятия',
};
function adminSub(cfg, kind, s) {
  const title = `Постоянная бронь ${s.id}: ${ADMIN_TITLE[kind] || kind}`;
  const lines = [
    `Клиент: ${s.name}, ${s.phone}${s.email ? ', ' + s.email : ''}`,
    `Расписание: ${s.schedule}, ${money(s.weekTotal)} в неделю`,
    s.weekLabel ? `Занятие: ${s.weekLabel}` : null,
    s.reason ? `Причина отказа банка: ${s.reason}` : null,
  ].filter(Boolean);
  return { subject: title, text: lines.join('\n'), html: layout(cfg, { preheader: title, title, body: lines.map((l) => p(esc(l))).join('') }) };
}

module.exports = { templates, subTemplates, adminSub, pickupTime, icsEvent, esc };

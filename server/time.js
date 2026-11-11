'use strict';
/* Работа со временем студии. Все даты брони — «ГГГГ-ММ-ДД» и час в часовом поясе студии. */

const pad = (n) => (n < 10 ? '0' : '') + n;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateKey(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function addDays(dateKey, n) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
}

function daysBetween(a, b) {
  const ta = Date.UTC(...a.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const tb = Date.UTC(...b.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((tb - ta) / 86400000);
}

/** Смещение часового пояса от UTC в минутах на момент `date`. */
function tzOffsetMinutes(date, tz) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // «GMT+03:00» или «GMT»
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(part);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Момент (Date, UTC), когда в поясе `tz` на часах «dateKey, hour:00». */
function zonedToUtc(dateKey, hour, tz) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, 0, 0);
  let t = guess - tzOffsetMinutes(new Date(guess), tz) * 60000;
  t = guess - tzOffsetMinutes(new Date(t), tz) * 60000; // уточнение на границе перехода времени
  return new Date(t);
}

/** Сегодняшняя дата и минуты с начала суток в поясе `tz`. */
function nowInTz(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Строка для календаря Google: локальное время без смещения + пояс отдельно. */
function localDateTime(dateKey, hour) {
  return `${dateKey}T${pad(hour)}:00:00`;
}

const hhmm = (h) => `${pad(h)}:00`;

module.exports = { pad, isDateKey, addDays, daysBetween, tzOffsetMinutes, zonedToUtc, nowInTz, localDateTime, hhmm };

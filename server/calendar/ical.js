'use strict';
/* Минимальный iCalendar (RFC 5545): собрать одно событие и разобрать ответ сервера. Без внешних библиотек. */
const { tzOffsetMinutes } = require('../time');

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Date → 20261116T030000Z */
function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** Перенос длинных строк: не длиннее 75 байт, продолжение начинается с пробела. */
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Служебные данные брони прячем в своё свойство: base64url от JSON. */
const encodeData = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function decodeData(s) {
  try { return JSON.parse(Buffer.from(s.trim(), 'base64url').toString('utf8')); } catch { return null; }
}
// Запасной вариант: та же строка последней строкой описания (если сервер выбросит своё свойство)
const DATA_MARK = '#booking:';

/**
 * @param ev { uid, summary, description, start: Date, end: Date, data: object, stamp?: Date }
 */
function buildEvent(ev) {
  const data = encodeData(ev.data || {});
  const desc = `${ev.description || ''}\n\n${DATA_MARK}${data}`;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Arenda zala 55//booking//RU', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${utcStamp(ev.stamp || new Date())}`,
    `DTSTART:${utcStamp(ev.start)}`,
    `DTEND:${utcStamp(ev.end)}`,
    `SUMMARY:${escapeText(ev.summary || '')}`,
    `DESCRIPTION:${escapeText(desc)}`,
    'TRANSP:OPAQUE',
    `X-BOOKING-DATA:${data}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Разобрать строку свойства: NAME;PARAM=v;PARAM2=v:VALUE */
function parseLine(line) {
  let i = 0; let inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) break;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const [name, ...ps] = head.split(';');
  const params = {};
  for (const p of ps) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value };
}

/** Время из DTSTART/DTEND → Date. Понимает UTC (…Z), TZID=… и целый день (VALUE=DATE). */
function parseTime(prop, fallbackTz) {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return new Date(wall);
  let tz = prop.params.TZID || fallbackTz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { tz = fallbackTz; }
  let t = wall - tzOffsetMinutes(new Date(wall), tz) * 60000;
  t = wall - tzOffsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** Длительность PT1H30M / P1D → миллисекунды */
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const [, sign, w = 0, d = 0, h = 0, mi = 0, s = 0] = m;
  return (sign === '-' ? -1 : 1) * ((((+w * 7 + +d) * 24 + +h) * 60 + +mi) * 60 + +s) * 1000;
}

/** Все VEVENT из текста календаря: { uid, summary, description, start, end, data, cancelled } */
function parseEvents(text, fallbackTz) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  let depth = 0; // вложенные блоки внутри VEVENT (VALARM) пропускаем
  for (const raw of lines) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') { cur = { props: {} }; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN') { depth++; continue; }
    if (p.name === 'END' && p.value.toUpperCase() === 'VEVENT') { events.push(cur); cur = null; continue; }
    if (p.name === 'END') { depth--; continue; }
    if (depth === 0 && !(p.name in cur.props)) cur.props[p.name] = p;
  }
  return events.map(({ props }) => {
    const start = props.DTSTART ? parseTime(props.DTSTART, fallbackTz) : null;
    let end = props.DTEND ? parseTime(props.DTEND, fallbackTz) : null;
    if (!end && start && props.DURATION) end = new Date(start.getTime() + parseDuration(props.DURATION.value));
    if (!end && start) end = new Date(start.getTime() + (props.DTSTART.params.VALUE === 'DATE' ? 86400000 : 0));
    const description = props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : '';
    let data = props['X-BOOKING-DATA'] ? decodeData(props['X-BOOKING-DATA'].value) : null;
    if (!data) {
      const i = description.lastIndexOf(DATA_MARK);
      if (i >= 0) data = decodeData(description.slice(i + DATA_MARK.length).split('\n')[0]);
    }
    const shownDescription = description.includes(DATA_MARK) ? description.slice(0, description.lastIndexOf(DATA_MARK)).trimEnd() : description;
    return {
      uid: props.UID ? props.UID.value.trim() : '',
      summary: props.SUMMARY ? unescapeText(props.SUMMARY.value) : '',
      description: shownDescription,
      start, end,
      transparent: props.TRANSP ? props.TRANSP.value.trim().toUpperCase() === 'TRANSPARENT' : false,
      cancelled: props.STATUS ? props.STATUS.value.trim().toUpperCase() === 'CANCELLED' : false,
      data: data || {},
    };
  });
}

module.exports = { buildEvent, parseEvents, utcStamp, escapeText, unescapeText, fold, encodeData, decodeData, DATA_MARK };

'use strict';
/*
 * Календарь по протоколу CalDAV. Настроен под Яндекс Календарь (caldav.yandex.ru),
 * но подойдёт любой CalDAV-сервер. Вход: логин и пароль приложения, без внешних библиотек.
 *
 * Каждое событие брони лежит по адресу <календарь>/booking-<код>-<номер промежутка>.ics,
 * поэтому все промежутки брони находятся по коду без поиска. UID события совпадает с именем файла:
 * Яндекс сохраняет событие под именем из UID, а не по адресу, куда его отправили.
 * Служебные данные брони (статус, токен, контакты) хранятся в свойстве X-BOOKING-DATA и последней
 * строкой описания «#booking:…». Яндекс X-свойства выбрасывает, у него работает строка в описании.
 *
 * Цвет событий по CalDAV у Яндекса не меняется, поэтому статус виден по значку в названии:
 * ⏳ — ждёт оплаты, ✅ — оплачено. Администратор может подтвердить бронь, заменив ⏳ на ✅.
 */
const { buildEvent, parseEvents } = require('./ical');

const xmlDecode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

/** Содержимое первого тега с локальным именем `name` (префикс пространства имён любой). */
function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'i').exec(xml);
  return m ? (m[1] || '') : null;
}
function responses(xml) {
  return (xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) || []).map((r) => ({
    href: xmlDecode((tag(r, 'href') || '').trim()),
    etag: xmlDecode((tag(r, 'getetag') || '').trim()),
    data: tag(r, 'calendar-data') !== null ? xmlDecode(tag(r, 'calendar-data')) : null,
    raw: r,
  }));
}

const CAL_QUERY = (from, to, expand) => `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data>${expand ? `<c:expand start="${from}" end="${to}"/>` : ''}</c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${from}" end="${to}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function createCalDavCalendar(cfg, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || (() => new Date());
  const y = cfg.caldav;
  const auth = 'Basic ' + Buffer.from(`${y.user}:${y.password}`).toString('base64');
  const base = new URL(y.url);
  let calUrl = null;

  // Яндекс после записи события примерно на секунду отвечает «нет такого» (замерено: 0,6 с — 404, 1 с — есть).
  // Поэтому помним, что сами записали или удалили за последние 30 секунд, и в этом окне верим себе, а не ответу.
  const clock = deps.clock || Date.now;
  const RECENT_MS = 30000;
  const recent = new Map(); // id → { ev | null (удалено), at }
  const remember = (id, ev) => { recent.set(id, { ev, at: clock() }); };
  const fresh = (id) => { const r = recent.get(id); if (!r) return null; if (clock() - r.at > RECENT_MS) { recent.delete(id); return null; } return r; };

  async function req(method, url, { body, headers = {}, ok = [200, 201, 204, 207] } = {}) {
    const res = await fetchFn(String(url), {
      method,
      headers: { Authorization: auth, ...headers },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    });
    if (res.status === 401) throw new Error('CalDAV: неверный логин или пароль приложения (401). Нужен пароль приложения типа «Календарь CalDAV».');
    if (!ok.includes(res.status)) throw new Error(`CalDAV ${method} ${new URL(url).pathname}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }
  const propfind = async (url, depth, props) => {
    const res = await req('PROPFIND', url, {
      headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>${props}</d:prop></d:propfind>`,
    });
    return res.text();
  };

  /** Список календарей пользователя: [{ url, name }] */
  async function discover() {
    const p1 = await propfind(base, 0, '<d:current-user-principal/>');
    const principal = (tag(tag(p1, 'current-user-principal') || '', 'href') || '').trim();
    if (!principal) throw new Error('CalDAV: сервер не сообщил адрес пользователя (current-user-principal)');
    const p2 = await propfind(new URL(xmlDecode(principal), base), 0, '<c:calendar-home-set/>');
    const home = (tag(tag(p2, 'calendar-home-set') || '', 'href') || '').trim();
    if (!home) throw new Error('CalDAV: сервер не сообщил папку календарей (calendar-home-set)');
    const p3 = await propfind(new URL(xmlDecode(home), base), 1, '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>');
    return responses(p3)
      .filter((r) => /<(?:[\w-]+:)?calendar\b/i.test(tag(r.raw, 'resourcetype') || ''))
      .filter((r) => { const s = tag(r.raw, 'supported-calendar-component-set'); return s === null || /VEVENT/i.test(s); })
      .map((r) => ({ url: new URL(r.href, base).href, name: xmlDecode((tag(r.raw, 'displayname') || '').trim()) }));
  }

  async function calendarUrl() {
    if (calUrl) return calUrl;
    const want = (y.calendar || '').trim();
    if (/^https?:\/\//i.test(want)) {
      calUrl = want.endsWith('/') ? want : want + '/';
      return calUrl;
    }
    const list = await discover();
    if (!list.length) throw new Error('CalDAV: у пользователя нет календарей');
    const found = want ? list.find((c) => c.name.toLowerCase() === want.toLowerCase()) : list[0];
    if (!found) throw new Error(`CalDAV: календарь «${want}» не найден. Есть: ${list.map((c) => `«${c.name}»`).join(', ')}`);
    calUrl = found.url.endsWith('/') ? found.url : found.url + '/';
    return calUrl;
  }

  const idFor = (code, n) => `booking-${String(code).replace(/[^A-Za-z0-9_-]/g, '')}-${n}`;
  const hrefFor = async (id) => new URL(`${encodeURIComponent(id)}.ics`, await calendarUrl());
  const idFromHref = (href) => decodeURIComponent(href.split('/').filter(Boolean).pop() || '').replace(/\.ics$/i, '');

  const normalize = (id, e) => ({
    id,
    summary: e.summary,
    // цвета нет — статус по значку в названии
    colorId: e.summary.includes('✅') ? cfg.paidColorId : cfg.pendingColorId,
    description: e.description,
    start: e.start ? e.start.toISOString() : null,
    end: e.end ? e.end.toISOString() : null,
    private: e.data || {},
  });

  async function getRaw(id) {
    const mine = fresh(id);
    if (mine && !mine.ev) return null; // только что удалили сами, Яндекс может ещё показывать
    const res = await req('GET', await hrefFor(id), { ok: [200, 404, 410] });
    if (res.status !== 200) return mine ? { ev: mine.ev } : null; // только что записали, Яндекс ещё не показывает
    const text = await res.text();
    const ev = parseEvents(text, cfg.tz)[0];
    return ev ? { ev, etag: res.headers.get('etag') } : null;
  }

  /** Записать событие и запомнить его (см. RECENT_MS) */
  async function put(id, body, headers = {}) {
    await req('PUT', await hrefFor(id), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...headers }, body });
    remember(id, parseEvents(body, cfg.tz)[0]);
  }

  async function query(from, to, expand) {
    const res = await req('REPORT', await calendarUrl(), {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: CAL_QUERY(stamp(from), stamp(to), expand),
    });
    const out = [];
    const ids = new Set();
    for (const r of responses(await res.text())) {
      if (!r.data) continue;
      const id = idFromHref(r.href);
      const mine = fresh(id);
      if (mine && !mine.ev) continue;           // удалили сами, Яндекс ещё показывает
      ids.add(id);
      for (const ev of parseEvents(r.data, cfg.tz)) out.push({ id, ev });
    }
    // записали сами, а Яндекс ещё не показывает
    for (const [id] of recent) {
      const mine = fresh(id);
      if (!mine || !mine.ev || ids.has(id)) continue;
      if (mine.ev.end > from && mine.ev.start < to) out.push({ id, ev: mine.ev });
    }
    return out;
  }

  return {
    driver: 'caldav',

    async listBusy(timeMin, timeMax) {
      const items = await query(timeMin, timeMax, true);
      return items
        .map((x) => x.ev)
        .filter((e) => e.start && e.end && !e.transparent && !e.cancelled && e.end > timeMin && e.start < timeMax)
        .map((e) => ({ start: e.start, end: e.end }));
    },

    async createEvent(ev) {
      const n = Number(String(ev.private.part || '1/1').split('/')[0]) || 1;
      const id = idFor(ev.private.code, n);
      const body = buildEvent({ uid: id, summary: ev.summary, description: ev.description, start: ev.start, end: ev.end, data: ev.private, stamp: now() });
      await put(id, body, { 'If-None-Match': '*' });
      return { id };
    },

    async findByCode(code) {
      const r = await getRaw(idFor(code, 1));
      return r ? normalize(idFor(code, 1), r.ev) : null;
    },

    async findAllByCode(code) {
      const first = await getRaw(idFor(code, 1));
      if (!first) return [];
      const total = Number(String(first.ev.data.part || '1/1').split('/')[1]) || 1;
      const out = [normalize(idFor(code, 1), first.ev)];
      for (let n = 2; n <= total; n++) {
        const r = await getRaw(idFor(code, n));
        if (r) out.push(normalize(idFor(code, n), r.ev));
      }
      return out;
    },

    /** Брони сайта (не чужие события) с началом в [from, to) */
    async listBookings(from, to) {
      const items = await query(from, to, false);
      return items.filter((x) => x.ev.data.managed === '1' && x.ev.start && x.ev.start >= from && x.ev.start < to).map((x) => normalize(x.id, x.ev));
    },

    async listPending() {
      const t = now();
      const from = new Date(t.getTime() - 2 * 86400000);
      const to = new Date(t.getTime() + (cfg.horizonDays + 2) * 86400000);
      const items = await query(from, to, false);
      return items
        .filter((x) => x.ev.data.managed === '1' && x.ev.data.status === 'pending')
        .map((x) => normalize(x.id, x.ev));
    },

    async patchEvent(id, patch) {
      const r = await getRaw(id);
      if (!r) return;
      const e = r.ev;
      const body = buildEvent({
        uid: id,
        summary: patch.summary !== undefined ? patch.summary : e.summary,
        description: e.description,
        start: e.start, end: e.end,
        data: patch.private ? patch.private : e.data,
        stamp: now(),
      });
      // If-Match не шлём: Яндекс отдаёт ETag с хвостом «--gzip», который сам же не принимает.
      // Сервер работает в одном экземпляре и меняет брони под замком, гонки с собой нет.
      await put(id, body);
    },

    async deleteEvent(id) {
      await req('DELETE', await hrefFor(id), { ok: [200, 204, 404, 410] });
      remember(id, null);
    },

    discover,
    calendarUrl,
  };
}

module.exports = { createCalDavCalendar, _xml: { tag, responses, xmlDecode } };

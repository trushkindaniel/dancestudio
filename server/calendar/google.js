'use strict';
/* Google Calendar через сервисный аккаунт. Без внешних библиотек: подписываем JWT сами. */
const crypto = require('node:crypto');
const fs = require('node:fs');

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function loadCredentials(cfg) {
  const raw = cfg.googleServiceAccountJson || fs.readFileSync(cfg.googleServiceAccountFile, 'utf8');
  const j = JSON.parse(raw);
  if (!j.client_email || !j.private_key) throw new Error('В ключе сервисного аккаунта нет client_email или private_key');
  return { email: j.client_email, key: j.private_key, tokenUri: j.token_uri || 'https://oauth2.googleapis.com/token' };
}

/**
 * @param cfg настройки
 * @param deps.fetch  можно подменить в тестах
 * @param deps.now    можно подменить в тестах
 */
function createGoogleCalendar(cfg, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const now = deps.now || (() => new Date());
  const creds = deps.credentials || loadCredentials(cfg);
  const calId = encodeURIComponent(cfg.googleCalendarId);
  let token = null;
  let tokenExp = 0;

  async function getToken() {
    const t = Math.floor(now().getTime() / 1000);
    if (token && t < tokenExp - 60) return token;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: creds.email, scope: SCOPE, aud: creds.tokenUri, iat: t, exp: t + 3600 }));
    const sig = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(creds.key);
    const res = await fetchFn(creds.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claim}.${b64url(sig)}` }),
    });
    if (!res.ok) throw new Error(`Google не выдал токен: ${res.status} ${await res.text()}`);
    const j = await res.json();
    token = j.access_token;
    tokenExp = t + (j.expires_in || 3600);
    return token;
  }

  async function call(method, path, { query, body } = {}) {
    const url = new URL(`${API}/calendars/${calId}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.append(k, v);
    const res = await fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Google Calendar ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  const normalize = (e) => ({
    id: e.id,
    summary: e.summary || '',
    colorId: e.colorId || '',
    private: (e.extendedProperties && e.extendedProperties.private) || {},
  });

  return {
    driver: 'google',

    async listBusy(timeMin, timeMax) {
      const res = await fetchFn(`${API}/freeBusy`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: cfg.googleCalendarId }] }),
      });
      if (!res.ok) throw new Error(`Google freeBusy: ${res.status} ${await res.text()}`);
      const j = await res.json();
      const cal = j.calendars && j.calendars[cfg.googleCalendarId];
      if (!cal) throw new Error('Google freeBusy: нет данных по календарю, проверьте GOOGLE_CALENDAR_ID и доступ сервисного аккаунта');
      if (cal.errors && cal.errors.length) throw new Error(`Google freeBusy: ${JSON.stringify(cal.errors)}`);
      return (cal.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
    },

    async createEvent(ev) {
      const e = await call('POST', '/events', {
        body: {
          summary: ev.summary,
          description: ev.description,
          colorId: ev.colorId,
          start: { dateTime: ev.localStart, timeZone: cfg.tz },
          end: { dateTime: ev.localEnd, timeZone: cfg.tz },
          extendedProperties: { private: ev.private },
          reminders: { useDefault: false },
        },
      });
      return { id: e.id };
    },

    async findByCode(code) {
      const j = await call('GET', '/events', { query: { privateExtendedProperty: `code=${code}`, maxResults: '5' } });
      return j.items && j.items.length ? normalize(j.items[0]) : null;
    },

    async findAllByCode(code) {
      const j = await call('GET', '/events', { query: { privateExtendedProperty: `code=${code}`, singleEvents: 'true', maxResults: '50' } });
      return (j.items || []).map(normalize);
    },

    async listPending() {
      const j = await call('GET', '/events', { query: { privateExtendedProperty: 'status=pending', singleEvents: 'true', maxResults: '250' } });
      return (j.items || []).map(normalize);
    },

    async patchEvent(id, patch) {
      const body = {};
      if (patch.summary !== undefined) body.summary = patch.summary;
      if (patch.colorId !== undefined) body.colorId = patch.colorId;
      if (patch.private) body.extendedProperties = { private: patch.private };
      await call('PATCH', `/events/${encodeURIComponent(id)}`, { body });
    },

    async deleteEvent(id) {
      await call('DELETE', `/events/${encodeURIComponent(id)}`);
    },
  };
}

module.exports = { createGoogleCalendar };

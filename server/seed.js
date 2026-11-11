'use strict';
/* Демо-занятость для режима разработки: чтобы календарь не был пустым. */
const T = require('./time');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

async function seedDemoBusy(calendar, cfg, now = new Date(), days = 30) {
  const today = T.nowInTz(now, cfg.tz).date;
  let n = 0;
  for (let i = 0; i < days; i++) {
    const d = T.addDays(today, i);
    for (let h = cfg.openHour; h < cfg.closeHour; h++) {
      if (hash(`${d}-${h}`) % 100 < (h >= cfg.peakFrom ? 35 : 18)) {
        await calendar.createEvent({
          summary: 'Демо: занято', description: '', colorId: '8',
          start: T.zonedToUtc(d, h, cfg.tz), end: T.zonedToUtc(d, h + 1, cfg.tz),
          localStart: T.localDateTime(d, h), localEnd: T.localDateTime(d, h + 1),
          private: { managed: '1', status: 'demo' },
        });
        n++;
      }
    }
  }
  return n;
}

module.exports = { seedDemoBusy };

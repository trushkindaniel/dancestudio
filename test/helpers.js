'use strict';
const { buildConfig } = require('../server/config');
const { createMemoryCalendar } = require('../server/calendar/memory');
const { createBookingService } = require('../server/booking');
const { createFakePayments } = require('../server/payments');

// Понедельник, 9 ноября 2026, 10:00 по Москве
const NOW = new Date('2026-11-09T07:00:00Z');

// По умолчанию оплата переводом (старые тесты). Для онлайн-оплаты: makeEnv({ PAYMENT_PROVIDER: 'fake' })
function makeEnv(extra = {}) {
  // Часы в тестах заданы по Москве (NOW = 10:00 МСК), поэтому пояс фиксируем явно
  const cfg = buildConfig({ CALENDAR_DRIVER: 'memory', PAYMENT_PROVIDER: 'transfer', STUDIO_TZ: 'Europe/Moscow', SLOT_HOURS: '1', ...extra });
  const payments = cfg.payment.provider === 'fake' ? createFakePayments(cfg) : null;
  const calendar = createMemoryCalendar();
  const sent = [];
  const notify = {
    created: async (b) => sent.push(['created', b]),
    paid: async (b) => sent.push(['paid', b]),
    expired: async (b) => sent.push(['expired', b]),
    cancelled: async (b) => sent.push(['cancelled', b]),
    refunded: async (b) => sent.push(['refunded', b]),
  };
  const clock = { now: NOW };
  const booking = createBookingService({ calendar, cfg, notify, payments, now: () => clock.now, log: { error() {}, log() {} }, releaseTimers: false });
  return { cfg, calendar, notify, sent, clock, booking, payments };
}

const valid = (over = {}) => ({
  date: '2026-11-13', hours: [18, 19], name: 'Анна', phone: '+7 900 123-45-67',
  email: 'anna@example.com', note: '', consent: true, pdConsent: true, website: '', ...over,
});

module.exports = { NOW, makeEnv, valid };

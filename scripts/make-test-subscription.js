'use strict';
/*
 * Тестовая постоянная бронь для показа личного кабинета (модерация ЮKassa): node scripts/make-test-subscription.js
 * Запись настоящая (кабинет, отвязка и привязка карты, отмена работают через сервер), но с пометкой test:
 * не занимает часы в календаре, ничего не списывает и не продлевается. Письма уходят администратору.
 * После запуска перезапустить приложение (сервер держит записи в памяти). Печатает ссылку на кабинет.
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { loadDotEnv, buildConfig, root } = require('../server/config');
const { createJsonStore } = require('../server/store');
const T = require('../server/time');

loadDotEnv(path.join(root, '.env'));
const cfg = buildConfig(process.env);
const store = createJsonStore(cfg.subscriptions.file);

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n) => Array.from(crypto.randomBytes(n), (b) => ALPHA[b % ALPHA.length]).join('');

// ближайшая среда не раньше чем через 4 дня, 19:00–20:00
const today = T.nowInTz(new Date(), cfg.tz).date;
let date = T.addDays(today, 4);
while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 3) date = T.addDays(date, 1);
const hour = 19;
const total = hour >= cfg.peakFrom ? cfg.pricePeak : cfg.priceDay;

const now = new Date().toISOString();
const sub = {
  id: `S${rnd(6)}`, token: crypto.randomBytes(12).toString('hex'), status: 'active', createdAt: now, test: true, linkMode: true,
  name: 'Проверка ЮKassa', phone: cfg.venue.phone || '', email: cfg.adminEmail, purpose: '', people: '', note: 'тестовая запись для показа личного кабинета',
  slots: [{ date, first: hour, last: hour, total }], weekTotal: total,
  weeks: Array.from({ length: cfg.subscriptions.weeks }, (_, k) => ({ k, code: `T${rnd(3)}`, status: 'reserved', paymentId: null, attempts: 0, nextTryAt: null })),
  paymentMethod: { id: null, title: 'Bank card *4444' },
  autopayConsentAt: now, pdConsentAt: now,
};
store.put(sub);
console.log(`${cfg.baseUrl.replace(/\/$/, '')}/subscription?id=${sub.id}&t=${sub.token}`);

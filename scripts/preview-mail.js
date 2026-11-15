'use strict';
// Сохраняет все письма в docs/mail-preview/*.html на тестовой брони. Ничего не отправляет.
//   node scripts/preview-mail.js
const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, buildConfig, root } = require('../server/config');
const { templates } = require('../server/mail');

loadDotEnv(path.join(root, '.env'));
const cfg = buildConfig({ ...process.env, CALENDAR_DRIVER: 'memory', PAYMENT_PROVIDER: 'fake', NODE_ENV: 'development' });
const b = {
  code: 'AB23', name: 'Анна', email: 'anna@example.com', phone: '+7 900 123-45-67', total: 2000,
  date: '2026-11-13', startHour: 18, endHour: 20, purpose: 'репетиция', people: '8',
  start: new Date('2026-11-13T12:00:00Z'), end: new Date('2026-11-13T14:00:00Z'),
  dateLabel: 'пятница, 13 ноября', timeLabel: '18:00–20:00', online: true, deadlineLabel: '12 ноября в 18:30',
};
const out = path.join(root, 'docs', 'mail-preview');
fs.mkdirSync(out, { recursive: true });
for (const [name, fn] of Object.entries(templates)) {
  const m = fn(cfg, { ...b, reason: name === 'clientExpired' ? 'expired' : undefined });
  fs.writeFileSync(path.join(out, `${name}.html`), m.html);
  fs.writeFileSync(path.join(out, `${name}.txt`), `Тема: ${m.subject}\n\n${m.text}\n`);
  if (m.attachments) for (const a of m.attachments) fs.writeFileSync(path.join(out, a.filename), a.content);
  console.log(`${name}: ${m.subject}`);
}
console.log(`Готово: ${out}`);

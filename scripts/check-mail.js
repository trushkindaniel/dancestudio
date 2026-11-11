'use strict';
// Проверка SMTP из .env. Без аргументов только входит на сервер, письмо не отправляет.
//   node scripts/check-mail.js                 проверить логин
//   node scripts/check-mail.js you@example.com  отправить тестовое письмо
const path = require('node:path');
const { loadDotEnv, buildConfig, root } = require('../server/config');
loadDotEnv(path.join(root, '.env'));
const cfg = buildConfig();
const nodemailer = require('nodemailer');

const t = nodemailer.createTransport({
  host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465,
  auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
});
const to = process.argv[2];
(async () => {
  await t.verify();
  console.log(`SMTP: вход на ${cfg.smtp.host}:${cfg.smtp.port} как ${cfg.smtp.user} прошёл`);
  if (to) {
    await t.sendMail({ from: cfg.smtp.from, to, subject: 'Проверка почты сайта', text: `Письмо отправлено сайтом ${cfg.studioName}. Почта настроена.` });
    console.log(`Тестовое письмо отправлено на ${to}`);
  }
})().catch((e) => { console.error('SMTP не работает:', e.message); process.exit(1); });

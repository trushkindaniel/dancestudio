'use strict';
/* Настройки из переменных окружения и файла .env (без внешних библиотек). */
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

function num(env, key, def) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Переменная ${key} должна быть числом, а там «${v}»`);
  return n;
}

function buildConfig(env = process.env) {
  const cfg = {
    port: num(env, 'PORT', 3000),
    baseUrl: env.BASE_URL || 'http://localhost:3000',
    tz: env.STUDIO_TZ || 'Asia/Omsk',
    studioName: env.STUDIO_NAME || 'Зал «Пульс»',

    openHour: num(env, 'OPEN_HOUR', 9),
    closeHour: num(env, 'CLOSE_HOUR', 21),
    peakFrom: num(env, 'PEAK_FROM', 17),
    priceDay: num(env, 'PRICE_DAY', 800),
    pricePeak: num(env, 'PRICE_PEAK', 1000),
    holdMinutes: num(env, 'HOLD_MINUTES', 120),
    horizonDays: num(env, 'HORIZON_DAYS', 60),
    maxHours: num(env, 'MAX_HOURS', 8),
    minLeadMinutes: num(env, 'MIN_LEAD_MINUTES', 60),
    maxSlotsRangeDays: 14,

    // цвета событий в Google Календаре: 5 = «Банан» (жёлтый), 10 = «Базилик» (зелёный)
    pendingColorId: env.PENDING_COLOR_ID || '5',
    paidColorId: env.PAID_COLOR_ID || '10',

    sweepIntervalSec: num(env, 'SWEEP_INTERVAL_SEC', 300),

    calendarDriver: env.CALENDAR_DRIVER || 'memory',
    googleCalendarId: env.GOOGLE_CALENDAR_ID || '',
    googleServiceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || '',

    smtp: {
      host: env.SMTP_HOST || '',
      port: num(env, 'SMTP_PORT', 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.MAIL_FROM || '',
    },
    adminEmail: env.ADMIN_EMAIL || '',
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },

    payment: {
      provider: env.PAYMENT_PROVIDER || (env.YOOKASSA_SHOP_ID ? 'yookassa' : (env.NODE_ENV === 'production' ? '' : 'fake')),
      shopId: env.YOOKASSA_SHOP_ID || '',
      secretKey: env.YOOKASSA_SECRET_KEY || '',
      receipt: env.YOOKASSA_RECEIPT === '1',
      vatCode: num(env, 'YOOKASSA_VAT_CODE', 1),
    },

    requisites: {
      recipient: env.REQUISITES_RECIPIENT || '[ФИО или ИП — заполнить в .env]',
      account: env.REQUISITES_ACCOUNT || '[номер счёта]',
      bank: env.REQUISITES_BANK || '[банк, БИК]',
    },

    isProduction: env.NODE_ENV === 'production',
  };

  if (cfg.openHour >= cfg.closeHour) throw new Error('OPEN_HOUR должен быть меньше CLOSE_HOUR');
  if (!['memory', 'google'].includes(cfg.calendarDriver)) throw new Error('CALENDAR_DRIVER: memory или google');
  const pay = cfg.payment;
  if (!['yookassa', 'fake', 'transfer'].includes(pay.provider)) throw new Error('PAYMENT_PROVIDER: yookassa, fake или transfer');
  if (pay.provider === 'yookassa' && (!pay.shopId || !pay.secretKey)) throw new Error('Для yookassa нужны YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY');
  if (pay.provider === 'fake' && cfg.isProduction) throw new Error('PAYMENT_PROVIDER=fake нельзя включать в production');
  if (cfg.calendarDriver === 'google') {
    if (!cfg.googleCalendarId) throw new Error('Для google нужен GOOGLE_CALENDAR_ID');
    if (!cfg.googleServiceAccountFile && !cfg.googleServiceAccountJson) throw new Error('Для google нужен GOOGLE_SERVICE_ACCOUNT_FILE или GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  return cfg;
}

/** Часть настроек, которую можно отдать браузеру. Ничего секретного. */
function publicConfig(cfg) {
  return {
    studioName: cfg.studioName,
    openHour: cfg.openHour,
    closeHour: cfg.closeHour,
    peakFrom: cfg.peakFrom,
    priceDay: cfg.priceDay,
    pricePeak: cfg.pricePeak,
    holdMinutes: cfg.holdMinutes,
    horizonDays: cfg.horizonDays,
    maxHours: cfg.maxHours,
    minLeadMinutes: cfg.minLeadMinutes,
    payment: cfg.payment.provider, // yookassa | fake | transfer
  };
}

module.exports = { loadDotEnv, buildConfig, publicConfig, root: path.resolve(__dirname, '..') };

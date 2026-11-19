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
    // число — TCP-порт; иначе путь к сокет-файлу (так запускает Node.js панель ISPmanager)
    // ISPmanager передаёт путь к сокету в SOCKET
    port: env.SOCKET || (/^\d*$/.test(env.PORT || '') ? num(env, 'PORT', 3000) : env.PORT),
    baseUrl: env.BASE_URL || 'http://localhost:3000',
    tz: env.STUDIO_TZ || 'Asia/Omsk',
    studioName: env.STUDIO_NAME || 'Аренда зала 55',

    openHour: num(env, 'OPEN_HOUR', 9),
    closeHour: num(env, 'CLOSE_HOUR', 21),
    peakFrom: num(env, 'PEAK_FROM', 17),
    priceDay: num(env, 'PRICE_DAY', 800),
    pricePeak: num(env, 'PRICE_PEAK', 1000),
    holdMinutes: num(env, 'HOLD_MINUTES', 120),
    horizonDays: num(env, 'HORIZON_DAYS', 60),
    maxHours: num(env, 'MAX_HOURS', 8),
    // бронь блоками по SLOT_HOURS часов: 1 = 09–10, 10–11, …; 2 = 09–11, 11–13, …
    slotHours: num(env, 'SLOT_HOURS', 1),
    maxRanges: num(env, 'MAX_RANGES', 10),   // сколько промежутков (в разные дни) можно взять за одну бронь
    minLeadMinutes: num(env, 'MIN_LEAD_MINUTES', 60),
    maxSlotsRangeDays: 14,

    // цвета событий в Google Календаре: 5 = «Банан» (жёлтый), 10 = «Базилик» (зелёный)
    pendingColorId: env.PENDING_COLOR_ID || '5',
    paidColorId: env.PAID_COLOR_ID || '10',

    sweepIntervalSec: num(env, 'SWEEP_INTERVAL_SEC', 300),

    // memory | yandex (CalDAV, Яндекс Календарь) | caldav (любой CalDAV) | google
    calendarDriver: env.CALENDAR_DRIVER === 'yandex' ? 'caldav' : (env.CALENDAR_DRIVER || 'memory'),
    caldav: {
      url: env.CALDAV_URL || 'https://caldav.yandex.ru/',
      user: env.CALDAV_USER || env.YANDEX_LOGIN || '',
      password: env.CALDAV_PASSWORD || env.YANDEX_APP_PASSWORD || '',
      // название календаря или его полный адрес; пусто — первый календарь пользователя
      calendar: env.CALDAV_CALENDAR || env.YANDEX_CALENDAR || '',
    },
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
    // куда слать «оплата прошла»; пока адрес не задан, письмо уходит на ящик отправителя
    adminEmail: env.ADMIN_EMAIL || env.SMTP_USER || '',

    // что клиент получает в письме после оплаты
    venue: {
      address: env.VENUE_ADDRESS || 'Омск, ул. Фрунзе, 1 корпус 4, 11 этаж, помещение 1131',
      mapUrl: env.VENUE_MAP_URL || 'https://yandex.ru/maps/66/omsk/?ll=73.356270%2C54.993439&z=17&pt=73.356270%2C54.993439%2Cpm2rdm',
      phone: env.VENUE_PHONE || '8 913 658-19-00',
      keyPickup: env.KEY_PICKUP || 'офис ITB, 3 этаж, офис 307',
      keyReturn: env.KEY_RETURN || 'стойку ресепшена',
      arriveBeforeMin: num(env, 'ARRIVE_BEFORE_MIN', 15),
    },
    telegram: { token: env.TELEGRAM_BOT_TOKEN || '', chatId: env.TELEGRAM_CHAT_ID || '' },

    payment: {
      provider: env.PAYMENT_PROVIDER || (env.YOOKASSA_SHOP_ID ? 'yookassa' : (env.NODE_ENV === 'production' ? '' : 'fake')),
      shopId: env.YOOKASSA_SHOP_ID || '',
      secretKey: env.YOOKASSA_SECRET_KEY || '',
      receipt: env.YOOKASSA_RECEIPT === '1',
      vatCode: num(env, 'YOOKASSA_VAT_CODE', 1),
      fakeNoRecurring: env.FAKE_NO_RECURRING === '1',   // разработка: имитация «автоплатежи не включены»
    },

    requisites: {
      recipient: env.REQUISITES_RECIPIENT || '[ФИО или ИП — заполнить в .env]',
      account: env.REQUISITES_ACCOUNT || '[номер счёта]',
      bank: env.REQUISITES_BANK || '[банк, БИК]',
    },

    // постоянная бронь «каждую неделю» с автосписанием с карты (нужны автоплатежи в магазине ЮKassa)
    // личный кабинет: вход по ссылке из письма
    auth: {
      secret: env.AUTH_SECRET || '',
      secretFile: path.join(path.resolve(__dirname, '..'), 'data', 'auth-secret'),
      accountsFile: env.ACCOUNTS_FILE || path.join(path.resolve(__dirname, '..'), 'data', 'accounts.json'),
      codeMinutes: num(env, 'LOGIN_CODE_MINUTES', 10),
      sessionDays: num(env, 'SESSION_DAYS', 30),
    },

    subscriptions: {
      enabled: env.SUBSCRIPTIONS === '1',
      weeks: num(env, 'SUB_WEEKS', 8),                 // на сколько недель вперёд закреплено время
      chargeDaysBefore: num(env, 'SUB_CHARGE_DAYS', 3), // за сколько дней до занятия списываем
      releaseHoursBefore: num(env, 'SUB_RELEASE_HOURS', 24), // не списалось к этому сроку — освобождаем
      retryHours: num(env, 'SUB_RETRY_HOURS', 24),
      file: env.SUB_FILE || path.join(path.resolve(__dirname, '..'), 'data', 'subscriptions.json'),
    },

    isProduction: env.NODE_ENV === 'production',
  };

  if (cfg.openHour >= cfg.closeHour) throw new Error('OPEN_HOUR должен быть меньше CLOSE_HOUR');
  if (!Number.isInteger(cfg.slotHours) || cfg.slotHours < 1) throw new Error('SLOT_HOURS: целое число часов, от 1');
  if ((cfg.closeHour - cfg.openHour) % cfg.slotHours) throw new Error('Часы работы должны делиться на блоки SLOT_HOURS без остатка');
  if (cfg.maxHours % cfg.slotHours) throw new Error('MAX_HOURS должен делиться на SLOT_HOURS');
  if (!['memory', 'google', 'caldav'].includes(cfg.calendarDriver)) throw new Error('CALENDAR_DRIVER: memory, yandex, caldav или google');
  if (cfg.calendarDriver === 'caldav' && (!cfg.caldav.user || !cfg.caldav.password)) throw new Error('Для Яндекс Календаря нужны YANDEX_LOGIN и YANDEX_APP_PASSWORD (пароль приложения «Календарь CalDAV»)');
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
    slotHours: cfg.slotHours,
    minLeadMinutes: cfg.minLeadMinutes,
    payment: cfg.payment.provider, // yookassa | fake | transfer
    subscriptions: cfg.subscriptions.enabled && cfg.payment.provider !== 'transfer'
      ? { weeks: cfg.subscriptions.weeks, chargeDaysBefore: cfg.subscriptions.chargeDaysBefore }
      : null,
  };
}

module.exports = { loadDotEnv, buildConfig, publicConfig, root: path.resolve(__dirname, '..') };

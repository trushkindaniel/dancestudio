'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { loadDotEnv, buildConfig, root } = require('./config');

loadDotEnv(path.join(root, '.env'));

const { createCalendar } = require('./calendar');
const { createNotifier } = require('./notify');
const { createBookingService } = require('./booking');
const { createPayments } = require('./payments');
const { createApp } = require('./app');
const { seedDemoBusy } = require('./seed');

// Сервер должен работать в одном экземпляре: защита от двойной брони и лимиты живут в памяти процесса.
// Второй запуск (в том числе кластерный режим pm2) останавливаем сразу.
const LOCK = path.join(root, 'run', 'server.lock');
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
    if (alive && pid !== process.pid) throw new Error(`уже запущен другой экземпляр (pid ${pid}). Сервер должен работать в одном экземпляре.`);
    fs.writeFileSync(LOCK, String(process.pid)); // файл остался от упавшего процесса
  }
  process.on('exit', () => {
    try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.rmSync(LOCK); } catch {}
  });
}

async function main() {
  const cfg = buildConfig();
  acquireLock();
  const calendar = createCalendar(cfg);
  const notify = createNotifier(cfg);
  const payments = createPayments(cfg);
  const booking = createBookingService({ calendar, cfg, notify, payments });
  if (payments && payments.provider === 'fake') console.log('[dev] Оплата: имитация ЮKassa, деньги не списываются.');

  if (cfg.calendarDriver === 'memory') {
    const n = await seedDemoBusy(calendar, cfg);
    console.log(`[dev] Календарь в памяти, добавлено демо-занятых часов: ${n}. Настоящий Google не подключён.`);
  }

  const server = createApp({ cfg, booking, calendar, payments, trustProxy: process.env.TRUST_PROXY === '1' });

  const runSweep = () => booking.sweep()
    .then((r) => { if (r.paid || r.expired || r.errors) console.log('[sweep]', r); })
    .catch((e) => console.error('[sweep] сбой:', e.message));
  const timer = setInterval(runSweep, cfg.sweepIntervalSec * 1000);
  timer.unref();
  runSweep();

  const onSocket = typeof cfg.port === 'string';
  if (onSocket) { try { fs.rmSync(cfg.port); } catch {} } // сокет мог остаться от прошлого запуска
  server.listen(cfg.port, () => {
    if (onSocket) fs.chmodSync(cfg.port, 0o666); // веб-сервер хостинга должен достучаться до сокета
    console.log(`Сайт: ${cfg.baseUrl.replace(/\/$/, '')}  (порт ${cfg.port}, календарь: ${cfg.calendarDriver}, оплата: ${cfg.payment.provider})`);
    if (process.send) process.send('ready'); // pm2 --wait-ready ждёт этого сигнала
  });

  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('Не удалось запустить сервер:', e.message); process.exit(1); });

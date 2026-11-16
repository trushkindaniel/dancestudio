'use strict';
// Проверка Яндекс Календаря (CalDAV) из .env.
//   node scripts/check-calendar.js         вход, список календарей, какой выбран
//   node scripts/check-calendar.js --write  ещё создать, прочитать и удалить тестовое событие
const path = require('node:path');
const { loadDotEnv, buildConfig, root } = require('../server/config');
loadDotEnv(path.join(root, '.env'));
const { createCalDavCalendar } = require('../server/calendar/caldav');

(async () => {
  const d = process.env.CALENDAR_DRIVER;
  const cfg = buildConfig({ ...process.env, CALENDAR_DRIVER: !d || d === 'memory' ? 'yandex' : d });
  if (cfg.calendarDriver !== 'caldav') throw new Error('CALENDAR_DRIVER должен быть yandex');
  const cal = createCalDavCalendar(cfg);
  const list = await cal.discover();
  console.log(`Вход в ${cfg.caldav.url} как ${cfg.caldav.user} прошёл. Календари:`);
  for (const c of list) console.log(`  «${c.name}»  ${c.url}`);
  const url = await cal.calendarUrl();
  console.log(`Брони пойдут в: ${url}${cfg.caldav.calendar ? '' : '  (YANDEX_CALENDAR пуст — взят первый календарь)'}`);

  const from = new Date(); const to = new Date(Date.now() + 7 * 86400000);
  const busy = await cal.listBusy(from, to);
  console.log(`Занятых промежутков на неделю вперёд: ${busy.length}`);

  if (process.argv.includes('--write')) {
    const code = 'TEST' + Date.now().toString(36).toUpperCase();
    const start = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1, 5));
    const priv = { managed: '1', code, status: 'pending', part: '1/1', check: 'проверка, «кавычки»; точка с запятой' };
    await cal.createEvent({ summary: `⏳ ${code} · проверка сайта`, description: 'Тестовое событие, удалится сразу', start, end: new Date(start.getTime() + 3600000), private: priv });
    const [ev] = await cal.findAllByCode(code);
    const ok = ev && ev.private.check === priv.check;
    await cal.patchEvent(ev.id, { summary: ev.summary.replace('⏳', '✅'), private: { ...ev.private, status: 'paid' } });
    const [ev2] = await cal.findAllByCode(code);
    await cal.deleteEvent(ev.id);
    const gone = !(await cal.findByCode(code));
    console.log(`Запись: ${ok ? 'данные брони сохранились' : 'ДАННЫЕ ПОТЕРЯЛИСЬ'}; изменение: ${ev2 && ev2.private.status === 'paid' && ev2.summary.startsWith('✅') ? 'ок' : 'НЕ ПРОШЛО'}; удаление: ${gone ? 'ок' : 'НЕ ПРОШЛО'}`);
    if (!ok || !gone) process.exit(1);
  }
})().catch((e) => { console.error('Календарь не работает:', e.message); process.exit(1); });

'use strict';
/* Небольшое хранилище записей в JSON-файле (постоянные брони). Сервер работает в одном экземпляре,
   поэтому достаточно держать всё в памяти и после каждого изменения атомарно перезаписывать файл. */
const fs = require('node:fs');
const path = require('node:path');

/** @param file путь к файлу; null — только в памяти (тесты) */
function createJsonStore(file) {
  let items = {};
  if (file && fs.existsSync(file)) {
    try { items = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { throw new Error(`Не читается ${file}: ${e.message}`); }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file); // атомарно: при сбое останется прежний файл
  }
  return {
    all: () => Object.values(items),
    get: (id) => items[id] || null,
    put(item) { items[item.id] = item; save(); return item; },
    remove(id) { delete items[id]; save(); },
  };
}

module.exports = { createJsonStore };

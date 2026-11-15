'use strict';
/* Календарь в памяти. Для разработки и тестов, вместо настоящего Google. */
const crypto = require('node:crypto');

function createMemoryCalendar() {
  const events = new Map();

  const clone = (e) => JSON.parse(JSON.stringify(e));

  return {
    driver: 'memory',

    async listBusy(timeMin, timeMax) {
      const out = [];
      for (const e of events.values()) {
        const s = new Date(e.start);
        const en = new Date(e.end);
        if (en > timeMin && s < timeMax) out.push({ start: s, end: en });
      }
      return out;
    },

    async createEvent(ev) {
      const id = crypto.randomBytes(8).toString('hex');
      events.set(id, {
        id, summary: ev.summary, description: ev.description, colorId: ev.colorId,
        start: ev.start.toISOString(), end: ev.end.toISOString(), private: { ...ev.private },
      });
      return { id };
    },

    async findByCode(code) {
      for (const e of events.values()) if (e.private.code === code) return clone(e);
      return null;
    },

    /** Все события одной брони (бронь может состоять из нескольких промежутков) */
    async findAllByCode(code) {
      return [...events.values()].filter((e) => e.private.code === code).map(clone);
    },

    async listPending() {
      return [...events.values()].filter((e) => e.private.status === 'pending').map(clone);
    },

    async patchEvent(id, patch) {
      const e = events.get(id);
      if (!e) return;
      if (patch.summary !== undefined) e.summary = patch.summary;
      if (patch.colorId !== undefined) e.colorId = patch.colorId;
      if (patch.private) e.private = { ...e.private, ...patch.private };
    },

    async deleteEvent(id) {
      events.delete(id);
    },

    /** Только для разработки: имитация «администратор покрасил событие в зелёный». */
    _paint(id, colorId) {
      const e = events.get(id);
      if (e) e.colorId = colorId;
    },
    _size: () => events.size,
  };
}

module.exports = { createMemoryCalendar };

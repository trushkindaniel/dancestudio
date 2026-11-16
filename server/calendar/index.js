'use strict';
const { createMemoryCalendar } = require('./memory');
const { createGoogleCalendar } = require('./google');
const { createCalDavCalendar } = require('./caldav');

function createCalendar(cfg) {
  if (cfg.calendarDriver === 'google') return createGoogleCalendar(cfg);
  if (cfg.calendarDriver === 'caldav') return createCalDavCalendar(cfg);
  return createMemoryCalendar();
}

module.exports = { createCalendar };

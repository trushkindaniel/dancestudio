'use strict';
const { createMemoryCalendar } = require('./memory');
const { createGoogleCalendar } = require('./google');

function createCalendar(cfg) {
  return cfg.calendarDriver === 'google' ? createGoogleCalendar(cfg) : createMemoryCalendar();
}

module.exports = { createCalendar };

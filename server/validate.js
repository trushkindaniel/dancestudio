'use strict';
const { isDateKey, daysBetween, nowInTz } = require('./time');
const { AppError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Для чего арендуют зал. Необязательно, помогает администратору подготовить зал
const PURPOSES = {
  class: 'тренировка или класс', rehearsal: 'репетиция', masterclass: 'мастер-класс', shoot: 'фото- или видеосъёмка', other: 'другое',
};

/**
 * Проверяет заявку и возвращает очищенный объект.
 * При ошибке бросает AppError(400) со списком полей.
 */
function validateBooking(input, cfg, now) {
  const f = {}; // ошибки по полям
  const src = input && typeof input === 'object' ? input : {};

  const date = typeof src.date === 'string' ? src.date : '';
  const name = typeof src.name === 'string' ? src.name.trim() : '';
  const phone = typeof src.phone === 'string' ? src.phone.trim() : '';
  const email = typeof src.email === 'string' ? src.email.trim() : '';
  const note = typeof src.note === 'string' ? src.note.trim() : '';
  const hours = Array.isArray(src.hours) ? src.hours : [];
  const purpose = Object.prototype.hasOwnProperty.call(PURPOSES, src.purpose) ? src.purpose : '';
  const people = src.people === null || src.people === undefined || src.people === '' ? null : src.people;

  // ловушка для ботов: настоящий человек это поле не видит и не заполняет
  if (typeof src.website === 'string' && src.website.trim() !== '') {
    throw new AppError(400, 'spam', 'Заявка отклонена');
  }

  if (name.length < 2 || name.length > 80) f.name = 'Введите имя (2–80 символов)';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15 || phone.length > 30) f.phone = 'Введите телефон полностью';
  if (!EMAIL_RE.test(email) || email.length > 120) f.email = 'Проверьте почту, например name@mail.ru';
  if (note.length > 500) f.note = 'Комментарий не длиннее 500 символов';
  if (people !== null && !(Number.isInteger(people) && people >= 1 && people <= 60)) f.people = 'Число людей от 1 до 60';
  if (src.consent !== true) f.consent = 'Нужно согласие, чтобы оформить бронь';

  let okHours = hours.length > 0 && hours.length <= cfg.maxHours && hours.every((h) => Number.isInteger(h));
  if (okHours) {
    const sorted = [...hours].sort((a, b) => a - b);
    okHours = sorted.every((h, i) => h >= cfg.openHour && h < cfg.closeHour && (i === 0 || h === sorted[i - 1] + 1));
    if (okHours) hours.splice(0, hours.length, ...sorted);
  }
  if (!okHours) f.hours = `Выберите от 1 до ${cfg.maxHours} часов подряд в пределах ${cfg.openHour}:00–${cfg.closeHour}:00`;

  if (!isDateKey(date)) {
    f.date = 'Некорректная дата';
  } else if (okHours) {
    const t = nowInTz(now, cfg.tz);
    const ahead = daysBetween(t.date, date);
    if (ahead < 0 || ahead > cfg.horizonDays) f.date = `Запись открыта на ${cfg.horizonDays} дней вперёд`;
    else if (ahead === 0 && hours[0] * 60 < t.minutes + cfg.minLeadMinutes) f.hours = 'Это время уже недоступно, выберите позже';
  }

  if (Object.keys(f).length) throw new AppError(400, 'validation', 'Проверьте заполнение формы', f);
  return { date, hours, name, phone, email, note, purpose, purposeLabel: PURPOSES[purpose] || '', people };
}

module.exports = { validateBooking, PURPOSES };

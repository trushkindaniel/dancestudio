'use strict';
/* Цены. Считает только сервер, браузеру верить нельзя. */

const hourPrice = (h, cfg) => (h >= cfg.peakFrom ? cfg.pricePeak : cfg.priceDay);

function priceFor(hours, cfg) {
  let dayHours = 0;
  let peakHours = 0;
  for (const h of hours) (h >= cfg.peakFrom ? peakHours++ : dayHours++);
  return {
    dayHours,
    peakHours,
    total: dayHours * cfg.priceDay + peakHours * cfg.pricePeak,
  };
}

module.exports = { hourPrice, priceFor };

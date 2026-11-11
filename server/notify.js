'use strict';
/* Уведомления: письмо клиенту (SMTP) и сообщение администратору в Telegram.
   Если ничего не настроено, пишем в консоль. Сбой уведомления не ломает бронь. */

function createNotifier(cfg, deps = {}) {
  const log = deps.log || console;
  const fetchFn = deps.fetch || fetch;
  let transport = null;

  function getTransport() {
    if (transport !== null) return transport;
    transport = false;
    if (cfg.smtp.host && cfg.smtp.from) {
      try {
        const nodemailer = require('nodemailer');
        transport = nodemailer.createTransport({
          host: cfg.smtp.host,
          port: cfg.smtp.port,
          secure: cfg.smtp.port === 465,
          auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
        });
      } catch {
        log.warn('[mail] SMTP настроен, но пакет nodemailer не установлен. Выполните: npm install');
      }
    }
    return transport;
  }

  async function mail(to, subject, text) {
    try {
      const t = getTransport();
      if (!t) { log.log(`[mail:dev] → ${to}\n  ${subject}\n  ${text.replace(/\n/g, '\n  ')}`); return; }
      await t.sendMail({ from: cfg.smtp.from, to, subject, text });
    } catch (e) {
      log.error('[mail] не удалось отправить письмо:', e.message);
    }
  }

  async function telegramAdmin(text) {
    const { token, chatId } = cfg.telegram;
    if (!token || !chatId) { log.log(`[telegram:dev] ${text.replace(/\n/g, ' | ')}`); return; }
    try {
      const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) log.error('[telegram] ответ', res.status);
    } catch (e) {
      log.error('[telegram] не удалось отправить:', e.message);
    }
  }

  async function adminMail(subject, text) {
    if (cfg.adminEmail) await mail(cfg.adminEmail, subject, text);
  }

  return {
    async created(b) {
      const when = `${b.dateLabel}, ${b.timeLabel}`;
      const howToPay = b.online
        ? `Оплатите бронь в форме ЮKassa на сайте (она открылась после нажатия «Забронировать»).
` +
          `Слот держится до ${b.deadlineLabel}, потом освободится автоматически.
Как только оплата пройдёт, мы пришлём письмо с подтверждением.`
        : `Переведите сумму по реквизитам:
  Получатель: ${cfg.requisites.recipient}
  Счёт: ${cfg.requisites.account}
  Банк: ${cfg.requisites.bank}
` +
          `  Назначение: Аренда зала, бронь ${b.code}

Слот держится до ${b.deadlineLabel}, потом освободится автоматически.
` +
          `Когда администратор подтвердит оплату, мы пришлём ещё одно письмо.`;
      await Promise.all([
        mail(b.email, `Бронь ${b.code}: ${when}`,
          `Здравствуйте, ${b.name}!

Бронь ${b.code} создана: ${when}.
К оплате: ${b.total} ₽.

${howToPay}

${cfg.studioName}`),
        telegramAdmin(`Новая бронь ${b.code}
${when}
${b.name}, ${b.phone}
Сумма ${b.total} ₽
` +
          (b.purpose || b.people ? `${[b.purpose, b.people ? `${b.people} чел.` : ''].filter(Boolean).join(', ')}\n` : '') +
          (b.online ? 'Ждём оплату через ЮKassa, подтвердится само.' : 'Как подтвердить: покрасьте событие в календаре в зелёный.')),
        adminMail(`Новая бронь ${b.code}`, `${when}
${b.name}, ${b.phone}, ${b.email}
Сумма ${b.total} ₽`),
      ]);
    },
    async paid(b) {
      await Promise.all([
        mail(b.email, `Оплата брони ${b.code} подтверждена`,
          `Здравствуйте, ${b.name}!\n\nОплата получена. Ждём вас: ${b.dateLabel}, ${b.timeLabel}.\n\n${cfg.studioName}`),
        telegramAdmin(`Оплачена бронь ${b.code}: ${b.dateLabel}, ${b.timeLabel}, ${b.name}, ${b.total} ₽.`),
      ]);
    },
    async refunded(b) {
      await Promise.all([
        b.email ? mail(b.email, `Возврат оплаты за бронь ${b.code}`,
          `Здравствуйте!\n\nОплата за бронь ${b.code} пришла после того, как бронь была снята, поэтому мы вернули ${b.total} ₽.\n` +
          `Деньги вернутся тем же способом, обычно за несколько дней. Чтобы записаться снова, выберите время на сайте.\n\n${cfg.studioName}`) : null,
        telegramAdmin(`Возврат ${b.total} ₽ по брони ${b.code}: оплата пришла после снятия брони (${b.date}, часы ${b.hours}).`),
      ]);
    },
    async expired(b) {
      const failed = b.reason === 'payment_canceled';
      await Promise.all([
        mail(b.email, `Бронь ${b.code} снята`,
          `Здравствуйте, ${b.name}!\n\n` +
          (failed
            ? `Оплата за бронь ${b.code} (${b.dateLabel}, ${b.timeLabel}) не прошла, слот освобождён.\nЧтобы записаться, оформите бронь заново на сайте.`
            : `Оплата за бронь ${b.code} (${b.dateLabel}, ${b.timeLabel}) не поступила в срок, слот освобождён.\nЕсли вы уже оплатили, напишите нам. Если нет, оформите бронь заново на сайте.`) +
          `\n\n${cfg.studioName}`),
        telegramAdmin(`Бронь ${b.code} снята: ${failed ? 'оплата не прошла' : 'нет оплаты в срок'} (${b.dateLabel}, ${b.timeLabel}).`),
      ]);
    },
    async cancelled(b) {
      await telegramAdmin(`Клиент отменил бронь ${b.code} (${b.dateLabel}, ${b.timeLabel}).`);
    },
  };
}

module.exports = { createNotifier };

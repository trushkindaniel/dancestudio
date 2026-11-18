'use strict';
/* Уведомления.
   Почта (SMTP, nodemailer): клиенту — бронь создана / оплачена с инструкцией / снята / возврат;
   администратору — «оплата прошла» и новая бронь.
   Telegram: короткие сообщения администратору.
   Если почта или Telegram не настроены, сообщения печатаются в консоль. Сбой уведомления не ломает бронь. */
const { templates, subTemplates, adminSub } = require('./mail');

/**
 * @param deps.transport  объект с sendMail(opts) — для тестов и предпросмотра; иначе создаётся SMTP-транспорт
 */
function createNotifier(cfg, deps = {}) {
  const log = deps.log || console;
  const fetchFn = deps.fetch || fetch;
  let transport = deps.transport || null;

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

  /** Отправляет письмо по шаблону. Возвращает true, если ушло через SMTP. */
  async function send(to, msg) {
    if (!to) return false;
    try {
      const t = getTransport();
      if (!t) {
        log.log(`[mail:dev] → ${to}\n  ${msg.subject}\n  ${msg.text.replace(/\n/g, '\n  ')}${msg.attachments ? `\n  [вложение: ${msg.attachments.map((a) => a.filename).join(', ')}]` : ''}`);
        return false;
      }
      await t.sendMail({ from: cfg.smtp.from, to, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments });
      return true;
    } catch (e) {
      log.error(`[mail] не удалось отправить «${msg.subject}» на ${to}:`, e.message);
      return false;
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

  const when = (b) => (Array.isArray(b.ranges) && b.ranges.length ? b.ranges.map((r) => `${r.dateLabel}, ${r.timeLabel}`).join('; ') : `${b.dateLabel}, ${b.timeLabel}`);
  const extra = (b) => [b.purpose, b.people ? `${b.people} чел.` : ''].filter(Boolean).join(', ');

  return {
    async created(b) {
      await Promise.all([
        send(b.email, templates.clientCreated(cfg, b)),
        telegramAdmin(`Новая бронь ${b.code}\n${when(b)}\n${b.name}, ${b.phone}\nСумма ${b.total} ₽\n` +
          (extra(b) ? `${extra(b)}\n` : '') +
          (b.online ? 'Ждём оплату через ЮKassa, подтвердится само.' : 'Как подтвердить: покрасьте событие в календаре в зелёный.')),
      ]);
    },
    async paid(b) {
      await Promise.all([
        send(b.email, templates.clientPaid(cfg, b)),
        send(cfg.adminEmail, templates.adminPaid(cfg, b)),
        telegramAdmin(`Оплачена бронь ${b.code}: ${when(b)}, ${b.name}, ${b.phone}, ${b.total} ₽.${extra(b) ? ' ' + extra(b) + '.' : ''}`),
      ]);
    },
    async refunded(b) {
      await Promise.all([
        b.email ? send(b.email, templates.clientRefunded(cfg, b)) : null,
        telegramAdmin(`Возврат ${b.total} ₽ по брони ${b.code}: оплата пришла после снятия брони (${b.date}, часы ${b.hours}).`),
      ]);
    },
    async expired(b) {
      await Promise.all([
        send(b.email, templates.clientExpired(cfg, b)),
        telegramAdmin(`Бронь ${b.code} снята: ${b.reason === 'payment_canceled' ? 'оплата не прошла' : 'нет оплаты в срок'} (${when(b)}).`),
      ]);
    },
    /** Постоянная бронь: kind = started | card_not_saved | charge_failed | paused | skipped | cancelled */
    async subscription(kind, s) {
      await Promise.all([
        subTemplates[kind] && s.email ? send(s.email, subTemplates[kind](cfg, s)) : null,
        send(cfg.adminEmail, adminSub(cfg, kind, s)),
        telegramAdmin(adminSub(cfg, kind, s).subject),
      ]);
    },
    async cancelled(b) {
      await telegramAdmin(`Клиент отменил бронь ${b.code} (${when(b)}).`);
    },
  };
}

module.exports = { createNotifier };

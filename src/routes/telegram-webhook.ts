/**
 * Webhook для приёма входящих сообщений боту в ЛС.
 * Все сообщения из лички пересылаются в админ-чат (TELEGRAM_ADMIN_CHAT_ID).
 *
 * Переменные окружения:
 *   TELEGRAM_ADMIN_CHAT_ID — ID чата (личка или группа), куда пересылать сообщения.
 *   TELEGRAM_WEBHOOK_SECRET — (опционально) секрет для заголовка X-Telegram-Bot-Api-Secret-Token.
 *
 * Регистрация webhook (HTTPS обязателен):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/api/telegram/webhook"
 *   С секретом: .../setWebhook?url=...&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 */

import { Router, Request, Response } from 'express';
import { sendFormattedMessageToAdmin, sendTelegramMessage } from '../services/telegram';

const DEFAULT_REPLY = `Организаторы свяжутся с вами в ближайшее время!
Предлагаю вам открыть наше приложение и посмотреть изучить Афишу :)`;

/** Минимальный тип для входящего Update от Telegram */
interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
  };
}

const router = Router();

router.post('/webhook', (req: Request, res: Response) => {
  // Отвечаем 200 сразу, чтобы Telegram не повторял запрос
  res.sendStatus(200);

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret?.trim() && req.header('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return;
  }

  const body = req.body as TelegramUpdate;
  const message = body?.message;
  if (!message || message.chat?.type !== 'private' || !message.from) {
    return;
  }

  const text = message.text ?? message.caption ?? '[медиа]';
  void sendFormattedMessageToAdmin(
    {
      id: message.from.id,
      username: message.from.username,
      first_name: message.from.first_name,
      last_name: message.from.last_name,
    },
    text
  );
  void sendTelegramMessage(message.chat.id, DEFAULT_REPLY);
});

export default router;

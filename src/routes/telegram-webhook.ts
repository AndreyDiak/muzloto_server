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

import { Request, Response, Router } from 'express';
import { sendFormattedMessageToAdmin, sendTelegramMessage } from '../services/telegram';

const DEFAULT_REPLY = `Организаторы свяжутся с вами в ближайшее время!
А пока вы ждете, предлагаю открыть наше приложение и посмотреть Афишу :)`;

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

router.post('/webhook', async (req: Request, res: Response) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const headerSecret = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (secret?.trim() && headerSecret !== secret) {
    console.warn('[telegram-webhook] Секрет не совпадает или не передан. Задайте secret_token в setWebhook или уберите TELEGRAM_WEBHOOK_SECRET.');
    res.sendStatus(200);
    return;
  }

  const body = req.body as TelegramUpdate;
  const message = body?.message;
  if (!message || message.chat?.type !== 'private' || !message.from) {
    if (body?.message) {
      console.log('[telegram-webhook] Игнор: не личное сообщение, chat.type=', body.message.chat?.type);
    }
    res.sendStatus(200);
    return;
  }

  const text = message.text ?? message.caption ?? '[медиа]';
  console.log('[telegram-webhook] ЛС от', message.from.id, message.from.username ?? '-', ':', text.slice(0, 50));

  // /start shop-XXXXX — код покупки: открываем чат с ботом, чтобы потом бот мог отправить подтверждение в ЛС
  const shopStartMatch = text.match(/^\/start\s+(shop-[A-Za-z0-9]{5})$/i);
  if (shopStartMatch) {
    const payload = shopStartMatch[1];
    const appBaseUrl = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (appBaseUrl) {
      const webAppUrl = `${appBaseUrl}?code=${encodeURIComponent(payload)}`;
      await sendTelegramMessage(message.chat.id, '🛒 Нажмите кнопку ниже, чтобы открыть приложение и оформить покупку по коду.', {
        webAppButton: { text: 'Открыть приложение', url: webAppUrl },
      });
    } else {
      await sendTelegramMessage(message.chat.id, 'Откройте приложение из меню бота и введите код вручную в разделе «Профиль».');
    }
    res.sendStatus(200);
    return;
  }

  // На Vercel функция завершается после ответа — дожидаемся пересылки и ответа, потом отдаём 200
  await sendFormattedMessageToAdmin(
    {
      id: message.from.id,
      username: message.from.username,
      first_name: message.from.first_name,
      last_name: message.from.last_name,
    },
    text
  );
  await sendTelegramMessage(message.chat.id, DEFAULT_REPLY);

  res.sendStatus(200);
});

export default router;

/**
 * Webhook для приёма входящих сообщений боту в ЛС.
 * Обрабатывает: Профиль, Мероприятия, callback от inline-кнопок регистрации.
 * Остальные сообщения пересылаются в админ-чат (TELEGRAM_ADMIN_CHAT_ID).
 *
 * Переменные окружения:
 *   TELEGRAM_ADMIN_CHAT_ID — ID чата, куда пересылать сообщения.
 *   TELEGRAM_WEBHOOK_SECRET — (опционально) секрет для заголовка X-Telegram-Bot-Api-Secret-Token.
 *
 * Регистрация webhook (HTTPS обязателен):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/api/telegram/webhook"
 */

import { Request, Response, Router } from 'express';
import { applyVisitReward } from './events';
import { supabase } from '../services/supabase';
import {
  answerCallbackQuery,
  sendFormattedMessageToAdmin,
  sendTelegramMessage,
} from '../services/telegram';

const DEFAULT_REPLY = `Организаторы свяжутся с вами в ближайшее время!
А пока вы ждете, предлагаю открыть наше приложение и посмотреть Афишу :)`;

/** Постоянная клавиатура под полем ввода */
const BOT_REPLY_KEYBOARD = [['Профиль', 'Мероприятия']];

const REG_CALLBACK_PREFIX = 'reg_';

/** Минимальные типы для входящего Update от Telegram */
interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string; last_name?: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

function formatEventDate(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

const router = Router();

router.post('/webhook', async (req: Request, res: Response) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const headerSecret = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (secret?.trim() && headerSecret !== secret) {
    console.warn(
      '[telegram-webhook] Секрет не совпадает или не передан. Задайте secret_token в setWebhook или уберите TELEGRAM_WEBHOOK_SECRET.'
    );
    res.sendStatus(200);
    return;
  }

  const body = req.body as TelegramUpdate;

  // ——— Обработка нажатия inline-кнопки (регистрация на мероприятие) ———
  if (body?.callback_query) {
    const cq = body.callback_query;
    const telegramId = cq.from?.id;
    const data = cq.data ?? '';
    if (!telegramId || !data.startsWith(REG_CALLBACK_PREFIX)) {
      await answerCallbackQuery(cq.id, { text: 'Неизвестная кнопка' });
      res.sendStatus(200);
      return;
    }

    const eventId = data.slice(REG_CALLBACK_PREFIX.length);
    const chatId = cq.message?.chat?.id ?? telegramId;

    try {
      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('id, title')
        .eq('id', eventId)
        .single();

      if (eventError || !event) {
        await answerCallbackQuery(cq.id, { text: 'Мероприятие не найдено' });
        await sendTelegramMessage(chatId, 'Мероприятие не найдено.', {
          replyKeyboard: BOT_REPLY_KEYBOARD,
          parseMode: false,
        });
        res.sendStatus(200);
        return;
      }

      const { data: existing } = await supabase
        .from('registrations')
        .select('id')
        .eq('event_id', event.id)
        .eq('telegram_id', telegramId)
        .maybeSingle();

      if (existing) {
        await answerCallbackQuery(cq.id, { text: 'Вы уже зарегистрированы' });
        await sendTelegramMessage(chatId, `Вы уже зарегистрированы на «${event.title}».`, {
          replyKeyboard: BOT_REPLY_KEYBOARD,
          parseMode: false,
        });
        res.sendStatus(200);
        return;
      }

      const { error: insertError } = await supabase.from('registrations').insert({
        event_id: event.id,
        telegram_id: telegramId,
        status: 'confirmed',
      });

      if (insertError) {
        await answerCallbackQuery(cq.id, { text: 'Ошибка регистрации' });
        await sendTelegramMessage(chatId, 'Не удалось зарегистрироваться. Попробуйте позже.', {
          replyKeyboard: BOT_REPLY_KEYBOARD,
          parseMode: false,
        });
        res.sendStatus(200);
        return;
      }

      const result = await applyVisitReward(telegramId);
      await answerCallbackQuery(cq.id, { text: 'Вы зарегистрированы!' });

      const coinsLine =
        result.coinsEarned > 0
          ? `За регистрацию начислено ${result.coinsEarned} монет. `
          : '';
      const text = `Вы зарегистрированы на «${event.title}». ${coinsLine}Хорошего вечера! 😊`;
      await sendTelegramMessage(chatId, text, {
        replyKeyboard: BOT_REPLY_KEYBOARD,
        parseMode: false,
      });
    } catch (e) {
      console.error('[telegram-webhook] callback register error:', e);
      await answerCallbackQuery(cq.id, { text: 'Ошибка' });
      await sendTelegramMessage(chatId, 'Произошла ошибка. Попробуйте позже.', {
        replyKeyboard: BOT_REPLY_KEYBOARD,
        parseMode: false,
      });
    }
    res.sendStatus(200);
    return;
  }

  // ——— Обычное сообщение ———
  const message = body?.message;
  if (!message || message.chat?.type !== 'private' || !message.from) {
    if (body?.message) {
      console.log('[telegram-webhook] Игнор: не личное сообщение, chat.type=', body.message.chat?.type);
    }
    res.sendStatus(200);
    return;
  }

  const text = (message.text ?? message.caption ?? '').trim();
  const chatId = message.chat.id;
  const telegramId = message.from.id;
  console.log('[telegram-webhook] ЛС от', telegramId, message.from.username ?? '-', ':', text.slice(0, 50));

  // ——— /start без параметров — приветствие и кнопки сразу при заходе в чат ———
  if (text === '/start') {
    await sendTelegramMessage(chatId, 'Привет! 👋 Выберите действие:', {
      replyKeyboard: BOT_REPLY_KEYBOARD,
      parseMode: false,
    });
    res.sendStatus(200);
    return;
  }

  // ——— /start shop-XXXXX — код покупки ———
  const shopStartMatch = text.match(/^\/start\s+(shop-[A-Za-z0-9]{5})$/i);
  if (shopStartMatch) {
    const payload = shopStartMatch[1];
    const appBaseUrl = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (appBaseUrl) {
      const webAppUrl = `${appBaseUrl}?code=${encodeURIComponent(payload)}`;
      await sendTelegramMessage(chatId, '🛒 Нажмите кнопку ниже, чтобы открыть приложение и оформить покупку по коду.', {
        webAppButton: { text: 'Открыть приложение', url: webAppUrl },
      });
      await sendTelegramMessage(chatId, ' ', { replyKeyboard: BOT_REPLY_KEYBOARD });
    } else {
      await sendTelegramMessage(chatId, 'Откройте приложение из меню бота и введите код вручную в разделе «Профиль».', {
        replyKeyboard: BOT_REPLY_KEYBOARD,
      });
    }
    res.sendStatus(200);
    return;
  }

  // ——— Профиль: баланс и посещения ———
  if (text === 'Профиль' || text === '/profile') {
    const [profileRes, statsRes] = await Promise.all([
      supabase.from('profiles').select('balance').eq('telegram_id', telegramId).maybeSingle(),
      supabase.from('user_stats').select('games_visited').eq('telegram_id', telegramId).maybeSingle(),
    ]);
    const balance = profileRes.data ? Number(profileRes.data.balance) ?? 0 : 0;
    const visits = statsRes.data ? Number(statsRes.data.games_visited) ?? 0 : 0;
    const reply =
      `💰 <b>Баланс:</b> ${balance} монет\n` +
      `📅 <b>Посещений мероприятий:</b> ${visits}`;
    await sendTelegramMessage(chatId, reply, { replyKeyboard: BOT_REPLY_KEYBOARD });
    res.sendStatus(200);
    return;
  }

  // ——— Мероприятия: список предстоящих и кнопки регистрации ———
  if (text === 'Мероприятия' || text === '/events') {
    const now = new Date().toISOString();
    const { data: events, error: eventsError } = await supabase
      .from('events')
      .select('id, title, event_date')
      .gte('event_date', now)
      .order('event_date', { ascending: true })
      .limit(10);

    if (eventsError || !events?.length) {
      await sendTelegramMessage(chatId, 'Пока нет предстоящих мероприятий. Загляните позже! 🙂', {
        replyKeyboard: BOT_REPLY_KEYBOARD,
        parseMode: false,
      });
      res.sendStatus(200);
      return;
    }

    const lines = events.map((e, i) => `${i + 1}. ${e.title} — ${formatEventDate(e.event_date)}`);
    const intro = '📅 <b>Предстоящие мероприятия:</b>\n\n' + lines.join('\n');
    const inlineKeyboard = events.map((e) => [
      { text: `Зарегистрироваться: ${e.title.slice(0, 30)}${e.title.length > 30 ? '…' : ''}`, callback_data: REG_CALLBACK_PREFIX + e.id },
    ]);

    await sendTelegramMessage(chatId, intro, { inlineKeyboard });
    res.sendStatus(200);
    return;
  }

  // ——— Остальные сообщения: переслать админу и ответить ———
  await sendFormattedMessageToAdmin(
    {
      id: message.from.id,
      username: message.from.username,
      first_name: message.from.first_name,
      last_name: message.from.last_name,
    },
    text || '[медиа]'
  );
  await sendTelegramMessage(chatId, DEFAULT_REPLY, {
    replyKeyboard: BOT_REPLY_KEYBOARD,
    parseMode: false,
  });

  res.sendStatus(200);
});

export default router;

/**
 * Отправка личного сообщения пользователю в Telegram через Bot API.
 * chat_id для личного чата равен telegram_id пользователя (если он уже писал боту / start).
 * Пересылка входящих ЛС в админ-чат по webhook.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Inline-кнопка с Web App (открывает мини-приложение по URL). */
export interface TelegramWebAppButton {
  text: string;
  url: string;
}

/** Inline-кнопка с callback_data (до 64 байт). */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/** Reply-клавиатура: массив рядов кнопок (текст кнопки = то, что придёт в сообщении). */
export type ReplyKeyboard = string[][];

/**
 * Отправляет сообщение пользователю в личку.
 * webAppButton — одна inline-кнопка «Открыть приложение».
 * replyKeyboard — постоянная клавиатура под полем ввода (например [["Профиль", "Мероприятия"]]).
 * inlineKeyboard — inline-кнопки под сообщением (например для «Зарегистрироваться» по мероприятиям).
 * parseMode: false — обычный текст, \n сохраняются.
 * Не бросает ошибку — при отсутствии токена или ошибке API только логирует.
 */
export async function sendTelegramMessage(
  telegramId: number,
  text: string,
  options?: {
    webAppButton?: TelegramWebAppButton;
    replyKeyboard?: ReplyKeyboard;
    inlineKeyboard?: TelegramInlineButton[][];
    parseMode?: 'HTML' | false;
  }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token?.trim()) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN не задан, сообщение не отправлено');
    return false;
  }

  const body: Record<string, unknown> = {
    chat_id: telegramId,
    text,
  };
  if (options?.parseMode !== false) {
    body.parse_mode = 'HTML';
  }
  if (options?.webAppButton) {
    body.reply_markup = {
      inline_keyboard: [
        [{ text: options.webAppButton.text, web_app: { url: options.webAppButton.url } }],
      ],
    };
  } else if (options?.replyKeyboard?.length) {
    body.reply_markup = {
      keyboard: options.replyKeyboard.map((row) => row.map((t) => ({ text: t }))),
      resize_keyboard: true,
      persistent: true,
    };
  } else if (options?.inlineKeyboard?.length) {
    body.reply_markup = {
      inline_keyboard: options.inlineKeyboard,
    };
  }

  try {
    const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[telegram] sendMessage failed:', res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[telegram] sendMessage error:', e);
    return false;
  }
}

/**
 * Ответ на нажатие inline-кнопки (убирает «часики» и опционально показывает всплывающий текст).
 */
export async function answerCallbackQuery(
  callbackQueryId: string,
  options?: { text?: string }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token?.trim()) return false;
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(options?.text && { text: options.text }),
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[telegram] answerCallbackQuery error:', e);
    return false;
  }
}

/** Данные отправителя для форматирования в админ-чате */
export interface MessageSender {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/**
 * Отправляет в админ-чат сообщение в формате:
 * Отправитель: ссылка/тег на юзера
 * Текст: содержимое сообщения
 */
export async function sendFormattedMessageToAdmin(
  from: MessageSender,
  text: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token?.trim()) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN не задан, отправка отменена');
    return false;
  }
  if (!adminChatId?.trim()) {
    console.warn('[telegram] TELEGRAM_ADMIN_CHAT_ID не задан, отправка отменена');
    return false;
  }

  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || `ID ${from.id}`;
  const link = from.username ? `https://t.me/${from.username}` : `tg://user?id=${from.id}`;
  const senderLabel = from.username
    ? `${escapeHtml(name)} (https://t.me/${from.username})`
    : `<a href="${link}">${escapeHtml(name)}</a>`;
  const escapedText = escapeHtml(text || '[без текста]');

  const body = `Отправитель: ${senderLabel}\n\nТекст: ${escapedText}`;

  try {
    const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId.trim(),
        text: body,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[telegram] sendFormattedMessageToAdmin failed:', res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[telegram] sendFormattedMessageToAdmin error:', e);
    return false;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

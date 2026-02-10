/**
 * Отправка личного сообщения пользователю в Telegram через Bot API.
 * chat_id для личного чата равен telegram_id пользователя (если он уже писал боту / start).
 * Пересылка входящих ЛС в админ-чат по webhook.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * Отправляет сообщение пользователю в личку.
 * Не бросает ошибку — при отсутствии токена или ошибке API только логирует.
 */
export async function sendTelegramMessage(
  telegramId: number,
  text: string
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token?.trim()) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN не задан, сообщение не отправлено');
    return false;
  }

  try {
    const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramId,
        text,
        parse_mode: 'HTML',
      }),
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Отправка личного сообщения пользователю в Telegram через Bot API.
 * chat_id для личного чата равен telegram_id пользователя (если он уже писал боту / start).
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

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
import {
  VISIT_REWARD_COINS,
  VISIT_REWARD_EVERY,
  PURCHASE_ACHIEVEMENT_REWARDS,
} from '../constants';
import { applyVisitReward } from './events';
import {
  grantSinglePurchaseAchievementReward,
} from '../services/achievements';
import { incrementUserStat } from '../services/user-stats';
import { supabase } from '../services/supabase';
import {
  answerCallbackQuery,
  sendFormattedMessageToAdmin,
  sendTelegramMessage,
  escapeHtml,
} from '../services/telegram';

const DEFAULT_REPLY = `Организаторы свяжутся с вами в ближайшее время!
А пока вы ждете, предлагаю открыть наше приложение и посмотреть Афишу :)`;

/** Постоянная клавиатура под полем ввода (с эмодзи для каждой кнопки) */
const BOT_REPLY_KEYBOARD = [
  ['👤 Профиль', '📅 Мероприятия'],
  ['🍀 Лавка удачи', '🏆 Награды'],
  ['⌨️ Ввести код'],
];

const REG_CALLBACK_PREFIX = 'reg_';
const ALREADY_CALLBACK_PREFIX = 'already_';
const CLAIM_VISIT_CALLBACK = 'claim_visit';
const CLAIM_PURCHASE_PREFIX = 'claim_p_'; // claim_p_1, claim_p_3, claim_p_5
const CONFIRM_PURCHASE_PREFIX = 'buy_'; // buy_12345 (5-digit code)

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

const MOSCOW_TZ = 'Europe/Moscow';

/** Начало текущего дня (00:00) в Москве — для фильтрации прошедших мероприятий */
function getStartOfTodayMoscow(): Date {
  const now = new Date();
  const moscowDateStr = now.toLocaleDateString('sv-SE', { timeZone: MOSCOW_TZ });
  return new Date(`${moscowDateStr}T00:00:00+03:00`);
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

  // ——— Обработка нажатия inline-кнопки (регистрация или «уже зарегистрирован») ———
  if (body?.callback_query) {
    const cq = body.callback_query;
    const telegramId = cq.from?.id;
    const data = cq.data ?? '';
    const chatId = cq.message?.chat?.id ?? telegramId;
    if (!telegramId) {
      await answerCallbackQuery(cq.id, { text: 'Ошибка' });
      res.sendStatus(200);
      return;
    }

    // Кнопка «Вы зарегистрированы» — только сообщение, без повторной регистрации
    if (data.startsWith(ALREADY_CALLBACK_PREFIX)) {
      const eventId = data.slice(ALREADY_CALLBACK_PREFIX.length);
      const { data: event } = await supabase
        .from('events')
        .select('title')
        .eq('id', eventId)
        .maybeSingle();
      await answerCallbackQuery(cq.id, { text: 'Вы уже зарегистрированы' });
      await sendTelegramMessage(
        chatId,
        event?.title
          ? `Вы уже зарегистрированы на «${event.title}». Ждём вас! 🙂`
          : 'Вы уже зарегистрированы на это мероприятие.',
        { replyKeyboard: BOT_REPLY_KEYBOARD, parseMode: false }
      );
      res.sendStatus(200);
      return;
    }

    // ——— Забрать награду за посещения ———
    if (data === CLAIM_VISIT_CALLBACK) {
      try {
        const { data: stats } = await supabase
          .from('user_stats')
          .select('games_visited, visit_rewards_claimed')
          .eq('telegram_id', telegramId)
          .single();
        const every = VISIT_REWARD_EVERY;
        const gamesVisited = stats?.games_visited ?? 0;
        const visitRewardsClaimed = stats?.visit_rewards_claimed ?? 0;
        const progress = gamesVisited - visitRewardsClaimed * every;
        if (progress < every) {
          await answerCallbackQuery(cq.id, { text: 'Нет доступной награды' });
          res.sendStatus(200);
          return;
        }
        const { data: profile } = await supabase
          .from('profiles')
          .select('balance')
          .eq('telegram_id', telegramId)
          .single();
        if (!profile) {
          await answerCallbackQuery(cq.id, { text: 'Ошибка' });
          res.sendStatus(200);
          return;
        }
        const newBalance = (Number(profile.balance) ?? 0) + VISIT_REWARD_COINS;
        await Promise.all([
          supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId),
          supabase
            .from('user_stats')
            .update({ visit_rewards_claimed: visitRewardsClaimed + 1 })
            .eq('telegram_id', telegramId),
        ]);
        await answerCallbackQuery(cq.id, { text: `+${VISIT_REWARD_COINS} монет!` });
        await sendTelegramMessage(
          chatId,
          `✅ Награда за посещения получена: <b>+${VISIT_REWARD_COINS}</b> монет. Баланс: ${newBalance}`,
          { replyKeyboard: BOT_REPLY_KEYBOARD }
        );
      } catch (e) {
        console.error('[telegram-webhook] claim_visit error:', e);
        await answerCallbackQuery(cq.id, { text: 'Ошибка' });
      }
      res.sendStatus(200);
      return;
    }

    // ——— Забрать награду за покупки (1, 3 или 5) ———
    if (data.startsWith(CLAIM_PURCHASE_PREFIX)) {
      const thresholdStr = data.slice(CLAIM_PURCHASE_PREFIX.length);
      const threshold = thresholdStr === '1' ? 1 : thresholdStr === '3' ? 3 : thresholdStr === '5' ? 5 : 0;
      if (![1, 3, 5].includes(threshold)) {
        await answerCallbackQuery(cq.id, { text: 'Неизвестная кнопка' });
        res.sendStatus(200);
        return;
      }
      try {
        const result = await grantSinglePurchaseAchievementReward(telegramId, threshold as 1 | 3 | 5);
        if (result.coinsAdded === 0) {
          await answerCallbackQuery(cq.id, { text: 'Награда уже получена или недоступна' });
          res.sendStatus(200);
          return;
        }
        await answerCallbackQuery(cq.id, { text: `+${result.coinsAdded} монет!` });
        await sendTelegramMessage(
          chatId,
          `✅ Награда получена: <b>+${result.coinsAdded}</b> монет. Баланс: ${result.newBalance ?? 0}`,
          { replyKeyboard: BOT_REPLY_KEYBOARD }
        );
      } catch (e) {
        console.error('[telegram-webhook] claim_purchase error:', e);
        await answerCallbackQuery(cq.id, { text: 'Ошибка' });
      }
      res.sendStatus(200);
      return;
    }

    // ——— Отмена покупки (cancel_12345) ———
    if (data.startsWith('cancel_')) {
      await answerCallbackQuery(cq.id, { text: 'Отменено' });
      res.sendStatus(200);
      return;
    }

    // ——— Подтверждение покупки по коду (buy_12345) ———
    if (data.startsWith(CONFIRM_PURCHASE_PREFIX)) {
      const code = data.slice(CONFIRM_PURCHASE_PREFIX.length);
      if (code.length !== 5 || !/^\d+$/.test(code)) {
        await answerCallbackQuery(cq.id, { text: 'Неверный код' });
        res.sendStatus(200);
        return;
      }
      try {
        const { data: purchaseRow } = await supabase
          .from('codes')
          .select('id, catalog_item_id, used_at')
          .eq('code', code)
          .eq('type', 'purchase')
          .maybeSingle();
        if (!purchaseRow?.catalog_item_id || purchaseRow.used_at) {
          await answerCallbackQuery(cq.id, { text: 'Код недействителен или уже использован' });
          res.sendStatus(200);
          return;
        }
        const { data: item } = await supabase
          .from('catalog')
          .select('id, name, description, price')
          .eq('id', purchaseRow.catalog_item_id)
          .single();
        if (!item) {
          await answerCallbackQuery(cq.id, { text: 'Товар не найден' });
          res.sendStatus(200);
          return;
        }
        const price = Number(item.price);
        const { data: profile } = await supabase
          .from('profiles')
          .select('balance')
          .eq('telegram_id', telegramId)
          .single();
        if (!profile || (Number(profile.balance) ?? 0) < price) {
          await answerCallbackQuery(cq.id, { text: 'Недостаточно монет' });
          res.sendStatus(200);
          return;
        }
        const newBalance = (Number(profile.balance) ?? 0) - price;
        await supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId);
        await supabase
          .from('codes')
          .update({ used_at: new Date().toISOString(), owner_telegram_id: telegramId })
          .eq('id', purchaseRow.id);
        await incrementUserStat(telegramId, 'tickets_purchased');
        const { checkAndUnlockAchievements } = await import('../services/achievements');
        await checkAndUnlockAchievements(telegramId);
        await answerCallbackQuery(cq.id, { text: 'Покупка оформлена!' });
        await sendTelegramMessage(
          chatId,
          `✅ Покупка по коду оформлена!\n\nТовар: <b>${escapeHtml(item.name)}</b>\nЦена: ${price} монет\nОстаток: ${newBalance} монет`,
          { replyKeyboard: BOT_REPLY_KEYBOARD }
        );
      } catch (e) {
        console.error('[telegram-webhook] confirm_purchase error:', e);
        await answerCallbackQuery(cq.id, { text: 'Ошибка оформления' });
      }
      res.sendStatus(200);
      return;
    }

    if (!data.startsWith(REG_CALLBACK_PREFIX)) {
      await answerCallbackQuery(cq.id, { text: 'Неизвестная кнопка' });
      res.sendStatus(200);
      return;
    }

    const eventId = data.slice(REG_CALLBACK_PREFIX.length);

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

  // ——— /start без параметров — приветствие и кнопки ———
  if (text === '/start') {
    await sendTelegramMessage(
      chatId,
      'Привет! 👋 Выберите действие или введите <b>5 цифр</b> кода (мероприятие или покупка).',
      { replyKeyboard: BOT_REPLY_KEYBOARD }
    );
    res.sendStatus(200);
    return;
  }

  // ——— /start shop-12345 — код покупки (5 цифр) ———
  const shopStartMatch = text.match(/^\/start\s+(shop-\d{5})$/);
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

  // ——— Профиль: баланс, посещения и текущая регистрация ———
  if (text === 'Профиль' || text === '👤 Профиль' || text === '/profile') {
    const [profileRes, statsRes, regRes] = await Promise.all([
      supabase.from('profiles').select('balance').eq('telegram_id', telegramId).maybeSingle(),
      supabase.from('user_stats').select('games_visited').eq('telegram_id', telegramId).maybeSingle(),
      supabase
        .from('registrations')
        .select('event_id, registered_at')
        .eq('telegram_id', telegramId)
        .order('registered_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const balance = profileRes.data ? Number(profileRes.data.balance) ?? 0 : 0;
    const visits = statsRes.data ? Number(statsRes.data.games_visited) ?? 0 : 0;

    let registrationLine: string;
    if (regRes.data?.event_id) {
      const { data: eventData } = await supabase
        .from('events')
        .select('id, title, event_date')
        .eq('id', regRes.data.event_id)
        .single();
      const startOfToday = getStartOfTodayMoscow();
      const isUpcoming =
        eventData?.event_date && new Date(eventData.event_date) >= startOfToday;
      if (isUpcoming && eventData?.title) {
        registrationLine = `📋 <b>Текущая регистрация:</b> ${eventData.title}`;
      } else {
        registrationLine = `📋 <b>Текущая регистрация:</b> нет`;
      }
    } else {
      registrationLine = `📋 <b>Текущая регистрация:</b> нет`;
    }

    const reply =
      `💰 <b>Баланс:</b> ${balance} монет\n` +
      `📅 <b>Посещений мероприятий:</b> ${visits}\n` +
      registrationLine;
    await sendTelegramMessage(chatId, reply, { replyKeyboard: BOT_REPLY_KEYBOARD });
    res.sendStatus(200);
    return;
  }

  // ——— Мероприятия: список предстоящих, кнопка регистрации только если ещё не зареган ———
  if (text === 'Мероприятия' || text === '📅 Мероприятия' || text === '/events') {
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

    const eventIds = events.map((e) => e.id);
    const { data: myRegs } = await supabase
      .from('registrations')
      .select('event_id')
      .eq('telegram_id', telegramId)
      .in('event_id', eventIds);
    const registeredEventIds = new Set((myRegs ?? []).map((r) => r.event_id));

    const lines = events.map((e, i) => `${i + 1}. ${e.title} — ${formatEventDate(e.event_date)}`);
    const intro = '📅 <b>Предстоящие мероприятия:</b>\n\n' + lines.join('\n');
    const inlineKeyboard = events.map((e) => {
      const isRegistered = registeredEventIds.has(e.id);
      const shortTitle = e.title.slice(0, 28) + (e.title.length > 28 ? '…' : '');
      return [
        isRegistered
          ? { text: `✓ Вы зарегистрированы: ${shortTitle}`, callback_data: ALREADY_CALLBACK_PREFIX + e.id }
          : { text: `Зарегистрироваться: ${shortTitle}`, callback_data: REG_CALLBACK_PREFIX + e.id },
      ];
    });

    await sendTelegramMessage(chatId, intro, { inlineKeyboard });
    res.sendStatus(200);
    return;
  }

  // ——— Лавка удачи: полный каталог в сообщении ———
  if (text === 'Лавка удачи' || text === '🍀 Лавка удачи' || text === '/catalog') {
    const { data: items } = await supabase
      .from('catalog')
      .select('id, name, description, price')
      .order('price', { ascending: true });

    let body = '🍀 <b>Лавка удачи</b>\n\nТовары за монеты:\n\n';
    if (items?.length) {
      for (const item of items) {
        const name = escapeHtml(item.name ?? '');
        const desc = item.description?.trim()
          ? '\n   ' + escapeHtml(item.description).replace(/\n/g, '\n   ')
          : '';
        body += `• <b>${name}</b> — ${Number(item.price) ?? 0} монет${desc}\n\n`;
      }
    } else {
      body += 'Пока каталог пуст.\n\n';
    }
    body += 'Чтобы купить, получите код у организатора или в приложении и введите 5 цифр кода (кнопка «Ввести код» или просто отправьте код).';

    await sendTelegramMessage(chatId, body, { replyKeyboard: BOT_REPLY_KEYBOARD });
    const appBaseUrl = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (appBaseUrl) {
      await sendTelegramMessage(chatId, 'Открыть Лавку в приложении:', {
        webAppButton: { text: 'Открыть приложение', url: `${appBaseUrl}/catalog` },
      });
      await sendTelegramMessage(chatId, ' ', { replyKeyboard: BOT_REPLY_KEYBOARD });
    }
    res.sendStatus(200);
    return;
  }

  // ——— Награды: полный контент + кнопки «Забрать награду» ———
  if (text === 'Награды' || text === '🏆 Награды' || text === '/achievements') {
    const { data: stats } = await supabase
      .from('user_stats')
      .select(
        'games_visited, visit_rewards_claimed, tickets_purchased, purchase_reward_1_claimed_at, purchase_reward_3_claimed_at, purchase_reward_5_claimed_at'
      )
      .eq('telegram_id', telegramId)
      .single();

    const every = VISIT_REWARD_EVERY;
    const gamesVisited = stats?.games_visited ?? 0;
    const visitRewardsClaimed = stats?.visit_rewards_claimed ?? 0;
    const visitProgress = gamesVisited - visitRewardsClaimed * every;
    const visitRewardPending = visitProgress >= every;
    const ticketsPurchased = stats?.tickets_purchased ?? 0;

    const purchaseConfig = [
      { threshold: 1, name: 'Первая покупка', badge: '🛒', key: 'purchase_reward_1_claimed_at' as const },
      { threshold: 3, name: 'Три покупки', badge: '🛍️', key: 'purchase_reward_3_claimed_at' as const },
      { threshold: 5, name: 'Пять покупок', badge: '⭐', key: 'purchase_reward_5_claimed_at' as const },
    ];

    let body = '🏆 <b>Награды</b>\n\n';
    body += `📅 <b>Посещения:</b> ${gamesVisited}. Каждые ${every} — награда ${VISIT_REWARD_COINS} монет.\n`;
    body += `   Прогресс: ${Math.min(visitProgress, every)}/${every}`;
    if (visitRewardPending) body += ' — можно забрать!';
    body += '\n\n';
    body += '🛒 <b>Достижения за покупки:</b>\n';
    for (const a of purchaseConfig) {
      const claimed = stats?.[a.key];
      const coins = PURCHASE_ACHIEVEMENT_REWARDS[a.threshold] ?? 0;
      const done = ticketsPurchased >= a.threshold;
      body += `   ${a.badge} ${a.name}: ${Math.min(ticketsPurchased, a.threshold)}/${a.threshold}`;
      if (done) body += claimed ? ` — ✓ получено ${coins} монет` : ` — ${coins} монет, можно забрать!`;
      body += '\n';
    }

    const inlineButtons: { text: string; callback_data: string }[] = [];
    if (visitRewardPending) inlineButtons.push({ text: 'Забрать награду за посещения', callback_data: CLAIM_VISIT_CALLBACK });
    for (const a of purchaseConfig) {
      const claimed = stats?.[a.key];
      if (ticketsPurchased >= a.threshold && !claimed) {
        inlineButtons.push({
          text: `Забрать награду: ${a.name}`,
          callback_data: CLAIM_PURCHASE_PREFIX + a.threshold,
        });
      }
    }

    if (inlineButtons.length > 0) {
      await sendTelegramMessage(chatId, body, {
        inlineKeyboard: inlineButtons.map((b) => [b]),
      });
    } else {
      await sendTelegramMessage(chatId, body, { replyKeyboard: BOT_REPLY_KEYBOARD });
    }
    const appBaseUrl = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
    if (appBaseUrl) {
      await sendTelegramMessage(chatId, 'Открыть раздел Награды в приложении:', {
        webAppButton: { text: 'Открыть приложение', url: `${appBaseUrl}/achievements` },
      });
      await sendTelegramMessage(chatId, ' ', { replyKeyboard: BOT_REPLY_KEYBOARD });
    }
    res.sendStatus(200);
    return;
  }

  // ——— Ввести код ———
  if (text === 'Ввести код' || text === '⌨️ Ввести код') {
    await sendTelegramMessage(chatId, 'Введите код из 5 цифр.', {
      replyKeyboard: BOT_REPLY_KEYBOARD,
    });
    res.sendStatus(200);
    return;
  }

  // ——— Ручной ввод кода: 5 цифр — мероприятие или покупка ———
  if (/^\d{5}$/.test(text)) {
    const code = text;

    // 1) Пробуем как код мероприятия (регистрация)
    const { data: codeRow } = await supabase
      .from('codes')
      .select('event_id')
      .eq('code', code)
      .eq('type', 'registration')
      .maybeSingle();

    if (codeRow?.event_id) {
      const { data: event } = await supabase
        .from('events')
        .select('id, title, event_date')
        .eq('id', codeRow.event_id)
        .single();
      if (event) {
        const startOfToday = getStartOfTodayMoscow();
        const isPast = !event.event_date || new Date(event.event_date) < startOfToday;
        if (isPast) {
          await sendTelegramMessage(
            chatId,
            'Мероприятие уже прошло. Регистрация недоступна.',
            { replyKeyboard: BOT_REPLY_KEYBOARD, parseMode: false }
          );
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
          await sendTelegramMessage(
            chatId,
            `Вы уже зарегистрированы на «${escapeHtml(event.title)}».`,
            { replyKeyboard: BOT_REPLY_KEYBOARD }
          );
          res.sendStatus(200);
          return;
        }
        const { error: insertErr } = await supabase.from('registrations').insert({
          event_id: event.id,
          telegram_id: telegramId,
          status: 'confirmed',
        });
        if (insertErr) {
          await sendTelegramMessage(chatId, 'Не удалось зарегистрироваться. Попробуйте позже.', {
            replyKeyboard: BOT_REPLY_KEYBOARD,
            parseMode: false,
          });
          res.sendStatus(200);
          return;
        }
        const result = await applyVisitReward(telegramId);
        const coinsLine = result.coinsEarned > 0 ? ` За регистрацию начислено ${result.coinsEarned} монет.` : '';
        await sendTelegramMessage(
          chatId,
          `✅ Вы зарегистрированы на «${escapeHtml(event.title)}».${coinsLine}`,
          { replyKeyboard: BOT_REPLY_KEYBOARD }
        );
        res.sendStatus(200);
        return;
      }
    }

    // 2) Пробуем как код покупки (Лавка удачи)
    const { data: purchaseRow } = await supabase
      .from('codes')
      .select('id, catalog_item_id, used_at')
      .eq('code', code)
      .eq('type', 'purchase')
      .maybeSingle();

    if (purchaseRow?.catalog_item_id && !purchaseRow.used_at) {
      const { data: item } = await supabase
        .from('catalog')
        .select('id, name, price')
        .eq('id', purchaseRow.catalog_item_id)
        .single();
      if (item) {
        const price = Number(item.price);
        const { data: profile } = await supabase
          .from('profiles')
          .select('balance')
          .eq('telegram_id', telegramId)
          .single();
        const balance = Number(profile?.balance ?? 0);
        if (balance < price) {
          await sendTelegramMessage(
            chatId,
            `Товар «${escapeHtml(item.name)}» — ${price} монет. У вас ${balance} монет. Недостаточно для покупки.`,
            { replyKeyboard: BOT_REPLY_KEYBOARD }
          );
          res.sendStatus(200);
          return;
        }
        await sendTelegramMessage(chatId, `🛒 Вы покупаете: <b>${escapeHtml(item.name)}</b>\nЦена: ${price} монет\nБаланс: ${balance} монет`, {
          inlineKeyboard: [
            [
              { text: 'Подтвердить покупку', callback_data: CONFIRM_PURCHASE_PREFIX + code },
              { text: 'Отмена', callback_data: 'cancel_' + code },
            ],
          ],
        });
        res.sendStatus(200);
        return;
      }
    }

    // Код не найден ни как мероприятие, ни как покупка
    await sendTelegramMessage(chatId, 'Код не найден или уже использован. Проверьте 5 цифр и попробуйте снова.', {
      replyKeyboard: BOT_REPLY_KEYBOARD,
      parseMode: false,
    });
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

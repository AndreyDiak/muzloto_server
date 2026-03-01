import { randomInt } from 'crypto';
import { Response, Router } from 'express';
import { RAFFLE_WINNER_COINS, REGISTRATION_REWARD } from '../constants';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { sendTelegramMessage, sendTelegramPhotoByUrl } from '../services/telegram';

const router = Router();

const MOSCOW_TZ = 'Europe/Moscow';

function getStartOfTodayMoscow(): Date {
  const now = new Date();
  const moscowDateStr = now.toLocaleDateString('sv-SE', { timeZone: MOSCOW_TZ });
  return new Date(`${moscowDateStr}T00:00:00+03:00`);
}

export interface VisitRewardResult {
  finalBalance: number;
  coinsEarned: number;
  newlyUnlockedAchievements: Awaited<ReturnType<typeof checkAndUnlockAchievements>>['newlyUnlocked'];
}

/** Увеличивает games_visited, начисляет монеты за регистрацию. Используется при регистрации на мероприятие (API и бот). */
export async function applyVisitReward(telegramId: number): Promise<VisitRewardResult> {
  // Увеличиваем games_visited при регистрации; награда за каждые N посещений — в achievements (constants: VISIT_REWARD_EVERY, VISIT_REWARD_COINS)
  let { data: statsRow } = await supabase
    .from('user_stats')
    .select('games_visited')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (!statsRow) {
    const { error: insertError } = await supabase.from('user_stats').insert({
      telegram_id: telegramId,
      games_visited: 1,
      tickets_purchased: 0,
      bingo_collected: 0,
      visit_rewards_claimed: 0,
    });
    if (insertError) {
      throw new Error(`Failed to create user_stats: ${insertError.message}`);
    }
  } else {
    const { error: updateStatsError } = await supabase
      .from('user_stats')
      .update({
        games_visited: (statsRow?.games_visited ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('telegram_id', telegramId);
    if (updateStatsError) {
      throw new Error(`Failed to update user_stats: ${updateStatsError.message}`);
    }
  }

  const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || profile == null) {
    throw new Error('Профиль не найден');
  }

  const registrationCoins = REGISTRATION_REWARD;
  const currentBalance = Number(profile.balance) ?? 0;
  const newBalance = currentBalance + registrationCoins;

  const { error: updateBalanceError } = await supabase
    .from('profiles')
    .update({ balance: newBalance })
    .eq('telegram_id', telegramId);

  if (updateBalanceError) {
    throw new Error(`Не удалось начислить монеты: ${updateBalanceError.message}`);
  }

  return {
    finalBalance: newBalance,
    coinsEarned: registrationCoins,
    newlyUnlockedAchievements,
  };
}

/** GET /api/events/my-registration — текущая регистрация пользователя (последняя по дате) */
router.get('/my-registration', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const { data: reg, error: regError } = await supabase
      .from('registrations')
      .select('event_id, registered_at')
      .eq('telegram_id', telegramId)
      .order('registered_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (regError) throw new Error(regError.message);
    if (!reg) {
      return res.json({ registration: null });
    }

    const { data: eventData } = await supabase
      .from('events')
      .select('id, title, event_date')
      .eq('id', reg.event_id)
      .single();

    res.json({
      registration: {
        event: eventData ? { id: eventData.id, title: eventData.title, event_date: eventData.event_date } : null,
        registered_at: reg.registered_at,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/** POST /api/events/validate-code — проверить код мероприятия и вернуть информацию + команды */
router.post('/validate-code', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 цифр.' });
    }
    const normalizedCode = code.trim().replace(/\D/g, '');
    if (normalizedCode.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 цифр.' });
    }

    if (normalizedCode === '00000') {
      return res.json({
        event: { id: 'test', title: 'Тестовое событие' },
        teams: [],
        alreadyRegistered: false,
        coinsReward: REGISTRATION_REWARD,
      });
    }

    const { data: codeRow, error: codeError } = await supabase
      .from('codes')
      .select('event_id')
      .eq('code', normalizedCode)
      .eq('type', 'registration')
      .maybeSingle();

    if (codeError || !codeRow?.event_id) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, event_date')
      .eq('id', codeRow.event_id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    const startOfToday = getStartOfTodayMoscow();
    if (!event.event_date || new Date(event.event_date) < startOfToday) {
      return res.status(404).json({ error: 'Мероприятие уже прошло. Регистрация недоступна.' });
    }

    const { data: existingRegistration } = await supabase
      .from('registrations')
      .select('id')
      .eq('event_id', event.id)
      .eq('telegram_id', telegramId)
      .maybeSingle();

    res.json({
      event: { id: event.id, title: event.title },
      teams: [],
      alreadyRegistered: !!existingRegistration,
      coinsReward: REGISTRATION_REWARD,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/** POST /api/events/register — зарегистрироваться на мероприятие */
router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 цифр.' });
    }
    const normalizedCode = code.trim().replace(/\D/g, '');
    if (normalizedCode.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 цифр.' });
    }

    if (normalizedCode === '00000') {
      const result = await applyVisitReward(telegramId);
      const msg =
        result.coinsEarned > 0
          ? `Тестовый код обработан. Начислено ${result.coinsEarned} монет!`
          : 'Тестовый код обработан.';
      return res.json({
        success: true,
        message: msg,
        event: { id: 'test', title: 'Тестовое событие' },
        newBalance: result.finalBalance,
        coinsEarned: result.coinsEarned,
        newlyUnlockedAchievements: result.newlyUnlockedAchievements,
      });
    }

    const { data: codeRow, error: codeError } = await supabase
      .from('codes')
      .select('event_id')
      .eq('code', normalizedCode)
      .eq('type', 'registration')
      .maybeSingle();

    if (codeError || !codeRow?.event_id) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, event_date')
      .eq('id', codeRow.event_id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    const startOfToday = getStartOfTodayMoscow();
    if (!event.event_date || new Date(event.event_date) < startOfToday) {
      return res.status(400).json({ error: 'Мероприятие уже прошло. Регистрация недоступна.' });
    }

    const { data: existingRegistration } = await supabase
      .from('registrations')
      .select('id')
      .eq('event_id', event.id)
      .eq('telegram_id', telegramId)
      .single();

    if (existingRegistration) {
      return res.status(409).json({ error: 'Вы уже зарегистрированы на это мероприятие.' });
    }

    const { error: registrationError } = await supabase.from('registrations').insert({
      event_id: event.id,
      telegram_id: telegramId,
      status: 'confirmed',
    });

    if (registrationError) {
      throw new Error(`Failed to create registration: ${registrationError.message}`);
    }

    const result = await applyVisitReward(telegramId);

    const coinsText =
      result.coinsEarned > 0
        ? `За регистрацию начислил ${result.coinsEarned} монет. `
        : 'До награды за посещения осталось ещё несколько визитов — заглядывай в приложение. ';
    const tgText = `Привет! Записал тебя на <b>«${event.title}»</b> — хорошего вечера! :) 😊\n\n${coinsText}\n\nЗаглядывай в приложение, там можно обменять монеты на призы!`;
    void sendTelegramMessage(telegramId, tgText).catch(() => {});

    const message =
      result.coinsEarned > 0
        ? `Вы зарегистрированы. Начислено ${result.coinsEarned} монет!`
        : 'Вы зарегистрированы на мероприятие.';
    res.json({
      success: true,
      message,
      event: { id: event.id, title: event.title },
      newBalance: result.finalBalance,
      coinsEarned: result.coinsEarned,
      newlyUnlockedAchievements: result.newlyUnlockedAchievements,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/** GET /api/events/:eventId/registrations — список участников мероприятия (только root) */
router.get(
  '/:eventId/registrations',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: regs, error: regError } = await supabase
        .from('registrations')
        .select('telegram_id, registered_at, status')
        .eq('event_id', eventId)
        .order('registered_at', { ascending: false });

      if (regError) {
        throw new Error(regError.message);
      }

      if (!regs?.length) {
        return res.json({ registrations: [] });
      }

      const telegramIds = [...new Set(regs.map((r) => String(r.telegram_id)))];
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('telegram_id, first_name, username, avatar_url')
        .in('telegram_id', telegramIds);

      if (profilesError) {
        throw new Error(profilesError.message);
      }

      const profileByTgId = new Map(
        (profiles ?? []).map((p) => [String(p.telegram_id), p])
      );

      const registrations = regs.map((r) => ({
        telegram_id: r.telegram_id,
        registered_at: r.registered_at,
        status: r.status,
        first_name: profileByTgId.get(String(r.telegram_id))?.first_name ?? null,
        username: profileByTgId.get(String(r.telegram_id))?.username ?? null,
        avatar_url: profileByTgId.get(String(r.telegram_id))?.avatar_url ?? null,
      }));

      res.json({ registrations });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

const BROADCAST_FEEDBACK_MESSAGE =
  'Спасибо, что был с нами в этот вечер — мы очень рады! ❤️\n\n' +
  'Нам важно именно твоё мнение: напиши, что понравилось и что можно улучшить. Рады любой обратной связи! 🙏';

function formatEventDateForAnnounce(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    return d.toLocaleDateString('ru-RU', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

/** POST /api/events/:eventId/broadcast-announce — рассылка анонса мероприятия выбранным пользователям (только root) */
router.post(
  '/:eventId/broadcast-announce',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const body = req.body as {
        telegram_ids?: number[];
        text?: string;
        photo_path?: string;
      };
      const telegramIds = Array.isArray(body.telegram_ids)
        ? [...new Set(body.telegram_ids)].filter((id) => typeof id === 'number' && id > 0)
        : [];
      if (telegramIds.length === 0) {
        return res.status(400).json({ error: 'Выберите хотя бы одного получателя.' });
      }

      const { data: event, error: eventError } = await supabase
        .from('events')
        .select('id, title, event_date, location')
        .eq('id', eventId)
        .single();

      if (eventError || !event) {
        return res.status(404).json({ error: 'Мероприятие не найдено.' });
      }

      const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim() : null;
      if (!text) {
        return res.status(400).json({ error: 'Введите текст анонса.' });
      }
      const photoPath = typeof body.photo_path === 'string' ? body.photo_path.trim() : null;
      let photoSignedUrl: string | null = null;
      if (photoPath && !photoPath.includes('..')) {
        const t0 = Date.now();
        const { data: signed, error: signError } = await supabase.storage
          .from('announce-photos')
          .createSignedUrl(photoPath, 120);
        const signedUrlMs = Date.now() - t0;
        if (signError) {
          console.warn('[broadcast-announce] createSignedUrl failed:', signError.message);
        } else if (signed?.signedUrl) {
          photoSignedUrl = signed.signedUrl;
          console.log('[broadcast-announce] signedUrl created in', signedUrlMs, 'ms');
        }
      }

      let sent = 0;
      let failed = 0;
      const CONCURRENCY = 10;
      const tSend = Date.now();
      for (let i = 0; i < telegramIds.length; i += CONCURRENCY) {
        const chunk = telegramIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          chunk.map((telegramId) =>
            photoSignedUrl
              ? sendTelegramPhotoByUrl(telegramId, photoSignedUrl, text, { parseMode: false })
              : sendTelegramMessage(telegramId, text, { parseMode: false })
          )
        );
        sent += results.filter(Boolean).length;
        failed += results.filter((r) => !r).length;
      }
      console.log('[broadcast-announce] sendPhoto/sendMessage in', Date.now() - tSend, 'ms, recipients:', telegramIds.length);

      if (photoPath) {
        await supabase.storage.from('announce-photos').remove([photoPath]);
      }

      return res.json({
        total: telegramIds.length,
        sent,
        failed,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/broadcast-feedback — рассылка просьбы об обратной связи всем зарегистрированным (только root) */
router.post(
  '/:eventId/broadcast-feedback',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: regs, error: regError } = await supabase
        .from('registrations')
        .select('telegram_id')
        .eq('event_id', eventId)
        .eq('status', 'confirmed');

      if (regError) throw new Error(regError.message);

      const telegramIds = [...new Set((regs ?? []).map((r) => Number(r.telegram_id)).filter(Boolean))];
      let sent = 0;
      let failed = 0;
      for (const telegramId of telegramIds) {
        const ok = await sendTelegramMessage(telegramId, BROADCAST_FEEDBACK_MESSAGE, {
          parseMode: false,
        });
        if (ok) sent++;
        else failed++;
      }

      return res.json({
        total: telegramIds.length,
        sent,
        failed,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** GET /api/events/:eventId/raffle — получить победителя розыгрыша (если уже проведён), только root */
router.get(
  '/:eventId/raffle',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: row, error } = await supabase
        .from('event_raffle_winners')
        .select('winner_telegram_id, drawn_at')
        .eq('event_id', eventId)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (!row) return res.json({ winner: null });

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('telegram_id, first_name, username, avatar_url')
        .eq('telegram_id', row.winner_telegram_id)
        .single();

      if (profileError || !profile) {
        return res.json({
          winner: {
            telegram_id: row.winner_telegram_id,
            first_name: null,
            username: null,
            avatar_url: null,
          },
          drawn_at: row.drawn_at,
          winner_coins: RAFFLE_WINNER_COINS,
        });
      }

      res.json({
        winner: {
          telegram_id: profile.telegram_id,
          first_name: profile.first_name ?? null,
          username: profile.username ?? null,
          avatar_url: profile.avatar_url ?? null,
        },
        drawn_at: row.drawn_at,
        winner_coins: RAFFLE_WINNER_COINS,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/raffle/roll — выдать случайного победителя без сохранения (реролл), только root */
router.post(
  '/:eventId/raffle/roll',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;

      const { data: regs, error: regError } = await supabase
        .from('registrations')
        .select('telegram_id')
        .eq('event_id', eventId);

      if (regError) throw new Error(regError.message);
      if (!regs?.length) {
        return res.status(400).json({ error: 'Нет участников для розыгрыша' });
      }

      const winnerIndex = randomInt(0, regs.length);
      const winnerTelegramId = regs[winnerIndex].telegram_id;

      const { data: profile } = await supabase
        .from('profiles')
        .select('telegram_id, first_name, username, avatar_url')
        .eq('telegram_id', winnerTelegramId)
        .single();

      const winnerPayload = profile
        ? {
            telegram_id: profile.telegram_id,
            first_name: profile.first_name ?? null,
            username: profile.username ?? null,
            avatar_url: profile.avatar_url ?? null,
          }
        : {
            telegram_id: winnerTelegramId,
            first_name: null,
            username: null,
            avatar_url: null,
          };

      res.json({ winner: winnerPayload });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/raffle/confirm — сохранить победителя розыгрыша, только root */
router.post(
  '/:eventId/raffle/confirm',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const winnerTelegramId = req.body?.winner_telegram_id;
      if (winnerTelegramId == null || typeof winnerTelegramId !== 'number') {
        return res.status(400).json({ error: 'Нужен winner_telegram_id' });
      }

      const { data: existing, error: existingError } = await supabase
        .from('event_raffle_winners')
        .select('winner_telegram_id')
        .eq('event_id', eventId)
        .maybeSingle();

      if (existingError) throw new Error(existingError.message);
      if (existing) {
        return res.status(409).json({ error: 'Розыгрыш уже проведён' });
      }

      const { data: regs, error: regError } = await supabase
        .from('registrations')
        .select('telegram_id')
        .eq('event_id', eventId);

      if (regError) throw new Error(regError.message);
      const inRegs = regs?.some((r) => r.telegram_id === winnerTelegramId);
      if (!inRegs) {
        return res.status(400).json({ error: 'Участник не найден в регистрациях' });
      }

      const { data: inserted, error: insertError } = await supabase
        .from('event_raffle_winners')
        .insert({ event_id: eventId, winner_telegram_id: winnerTelegramId })
        .select('drawn_at')
        .single();

      if (insertError) throw new Error(insertError.message);

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('telegram_id, first_name, username, avatar_url, balance')
        .eq('telegram_id', winnerTelegramId)
        .single();

      if (!profileError && profile) {
        const newBalance = (Number(profile.balance) ?? 0) + RAFFLE_WINNER_COINS;
        await supabase
          .from('profiles')
          .update({ balance: newBalance })
          .eq('telegram_id', winnerTelegramId);
        const msg =
          `Поздравляем с победой в розыгрыше! На твой счёт начислено <b>${RAFFLE_WINNER_COINS.toLocaleString('ru-RU')}</b> монет. Загляни в приложение — там можно обменять их на крутые призы! 🎉`;
        void sendTelegramMessage(winnerTelegramId, msg).catch(() => {});
      }

      const winnerPayload = profile
        ? {
            telegram_id: profile.telegram_id,
            first_name: profile.first_name ?? null,
            username: profile.username ?? null,
            avatar_url: profile.avatar_url ?? null,
          }
        : {
            telegram_id: winnerTelegramId,
            first_name: null,
            username: null,
            avatar_url: null,
          };

      res.status(201).json({
        winner: winnerPayload,
        drawn_at: inserted?.drawn_at ?? new Date().toISOString(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/raffle — провести розыгрыш (один победитель) и сразу сохранить, только root */
router.post(
  '/:eventId/raffle',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;

      const { data: existing, error: existingError } = await supabase
        .from('event_raffle_winners')
        .select('winner_telegram_id, drawn_at')
        .eq('event_id', eventId)
        .maybeSingle();

      if (existingError) throw new Error(existingError.message);
      if (existing) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('telegram_id, first_name, username, avatar_url')
          .eq('telegram_id', existing.winner_telegram_id)
          .single();
        return res.status(409).json({
          error: 'Розыгрыш уже проведён',
          winner: profile
            ? {
                telegram_id: profile.telegram_id,
                first_name: profile.first_name ?? null,
                username: profile.username ?? null,
                avatar_url: profile.avatar_url ?? null,
              }
            : {
                telegram_id: existing.winner_telegram_id,
                first_name: null,
                username: null,
                avatar_url: null,
              },
          drawn_at: existing.drawn_at,
        });
      }

      const { data: regs, error: regError } = await supabase
        .from('registrations')
        .select('telegram_id')
        .eq('event_id', eventId);

      if (regError) throw new Error(regError.message);
      if (!regs?.length) {
        return res.status(400).json({ error: 'Нет участников для розыгрыша' });
      }

      const winnerIndex = randomInt(0, regs.length);
      const winnerTelegramId = regs[winnerIndex].telegram_id;

      const { data: inserted, error: insertError } = await supabase
        .from('event_raffle_winners')
        .insert({ event_id: eventId, winner_telegram_id: winnerTelegramId })
        .select('drawn_at')
        .single();

      if (insertError) throw new Error(insertError.message);

      const { data: profile } = await supabase
        .from('profiles')
        .select('telegram_id, first_name, username, avatar_url')
        .eq('telegram_id', winnerTelegramId)
        .single();

      const winnerPayload = profile
        ? {
            telegram_id: profile.telegram_id,
            first_name: profile.first_name ?? null,
            username: profile.username ?? null,
            avatar_url: profile.avatar_url ?? null,
          }
        : {
            telegram_id: winnerTelegramId,
            first_name: null,
            username: null,
            avatar_url: null,
          };

      res.status(201).json({
        winner: winnerPayload,
        drawn_at: inserted?.drawn_at ?? new Date().toISOString(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

export default router;

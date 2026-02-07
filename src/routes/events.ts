import { Response, Router } from 'express';
import { REWARDS_CONFIG } from '../config/rewards';
import { REGISTRATION_REWARD } from '../constants';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const router = Router();

interface VisitRewardResult {
  finalBalance: number;
  coinsEarned: number;
  newlyUnlockedAchievements: Awaited<ReturnType<typeof checkAndUnlockAchievements>>['newlyUnlocked'];
}

async function applyVisitReward(telegramId: number): Promise<VisitRewardResult> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || !profile) {
    throw new Error(`Failed to fetch profile: ${profileError?.message || 'Profile not found'}`);
  }

  const newBalance = (profile.balance || 0) + REGISTRATION_REWARD;
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ balance: newBalance })
    .eq('telegram_id', telegramId);

  if (updateError) {
    throw new Error(`Failed to update balance: ${updateError.message}`);
  }

  await incrementUserStat(telegramId, 'games_visited');
  const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

  return {
    finalBalance: newBalance,
    coinsEarned: REGISTRATION_REWARD,
    newlyUnlockedAchievements,
  };
}

router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 символов.' });
    }

    const normalizedCode = code.toUpperCase();

    if (normalizedCode === '00000') {
      const result = await applyVisitReward(telegramId);
      return res.json({
        success: true,
        message: `Тестовый код обработан. Начислено ${REGISTRATION_REWARD} монет!`,
        event: { id: 'test', title: 'Тестовое событие' },
        newBalance: result.finalBalance,
        coinsEarned: result.coinsEarned,
        newlyUnlockedAchievements: result.newlyUnlockedAchievements,
      });
    }

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, code')
      .eq('code', normalizedCode)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
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
    res.json({
      success: true,
      message: `Вы зарегистрированы на мероприятие. Начислено ${REGISTRATION_REWARD} монет!`,
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

const REWARD_TYPES: Record<string, number> = {
  personal_bingo: REWARDS_CONFIG.bingo_rewards.personal_bingo,
  team_bingo: REWARDS_CONFIG.bingo_rewards.team_bingo,
};

/** POST /api/events/award-coins — начислить монеты участнику мероприятия (только root) */
router.post(
  '/award-coins',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { event_id, telegram_id, reward_type, amount: amountFromBody } = req.body as {
        event_id?: string;
        telegram_id?: number;
        reward_type?: string;
        amount?: number;
      };

      if (!event_id || telegram_id == null) {
        return res.status(400).json({
          error: 'Укажите event_id и telegram_id.',
        });
      }

      let amount: number;
      if (reward_type && reward_type in REWARD_TYPES) {
        amount = REWARD_TYPES[reward_type];
      } else if (amountFromBody != null && amountFromBody >= 1) {
        amount = amountFromBody;
      } else {
        return res.status(400).json({
          error: 'Укажите reward_type (personal_bingo, team_bingo) или amount (положительное число).',
        });
      }

      const { data: reg } = await supabase
        .from('registrations')
        .select('id')
        .eq('event_id', event_id)
        .eq('telegram_id', telegram_id)
        .maybeSingle();

      if (!reg) {
        return res.status(404).json({
          error: 'Участник не зарегистрирован на это мероприятие.',
        });
      }

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('balance')
        .eq('telegram_id', telegram_id)
        .single();

      if (profileError || !profile) {
        throw new Error('Профиль не найден.');
      }

      const newBalance = (profile.balance ?? 0) + amount;
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ balance: newBalance })
        .eq('telegram_id', telegram_id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      res.json({
        success: true,
        newBalance,
        amount,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/prize-codes — сгенерировать код приза за бинго (только root) */
router.post(
  '/:eventId/prize-codes',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { BINGO_REWARD } = await import('../constants');
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const randomPart = () => {
        let s = 'B';
        for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      };
      let code = randomPart();
      for (let attempt = 0; attempt < 50; attempt++) {
        const [{ data: existingPrize }, { data: existingTicket }] = await Promise.all([
          supabase.from('event_prize_codes').select('id').eq('code', code).maybeSingle(),
          supabase.from('tickets').select('id').eq('code', code).maybeSingle(),
        ]);
        if (!existingPrize && !existingTicket) break;
        code = randomPart();
      }
      const { data: inserted, error: insertError } = await supabase
        .from('event_prize_codes')
        .insert({
          event_id: eventId,
          code,
          coins_amount: BINGO_REWARD,
          created_by_telegram_id: req.telegramId!,
        })
        .select('code, id, created_at')
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      res.status(201).json({ code: inserted.code, id: inserted.id, created_at: inserted.created_at });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** GET /api/events/:eventId/bingo-winners — сохранённые победители бинго (только root) */
router.get(
  '/:eventId/bingo-winners',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: rows, error } = await supabase
        .from('event_bingo_winners')
        .select('slot_type, slot_index, telegram_id, team_name')
        .eq('event_id', eventId);

      if (error) {
        throw new Error(error.message);
      }

      const personal: (number | null)[] = [null, null, null, null];
      const team: (string | null)[] = [null, null, null];
      (rows ?? []).forEach((r: { slot_type: string; slot_index: number; telegram_id: number | null; team_name: string | null }) => {
        if (r.slot_type === 'personal' && r.slot_index >= 0 && r.slot_index < 4) {
          personal[r.slot_index] = r.telegram_id;
        }
        if (r.slot_type === 'team' && r.slot_index >= 0 && r.slot_index < 3) {
          team[r.slot_index] = r.team_name;
        }
      });

      const telegramIds = personal.filter((id): id is number => id != null);
      let profileByTgId = new Map<string, { telegram_id: number; first_name: string | null; username: string | null; avatar_url: string | null }>();
      if (telegramIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('telegram_id, first_name, username, avatar_url')
          .in('telegram_id', telegramIds);
        (profiles ?? []).forEach((p) => profileByTgId.set(String(p.telegram_id), p));
      }

      const personalWithProfile = personal.map((tgId) => {
        if (tgId == null) return null;
        const p = profileByTgId.get(String(tgId));
        return p
          ? {
              telegram_id: tgId,
              first_name: p.first_name,
              username: p.username,
              avatar_url: p.avatar_url,
              registered_at: '',
              status: '',
            }
          : { telegram_id: tgId, first_name: null, username: null, avatar_url: null, registered_at: '', status: '' };
      });

      res.json({ personal: personalWithProfile, team });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** PUT /api/events/:eventId/bingo-winners — сохранить победителей бинго (только root) */
router.put(
  '/:eventId/bingo-winners',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { personal, team } = req.body as {
        personal?: (number | null)[];
        team?: (string | null)[];
      };

      const toUpsert: { event_id: string; slot_type: string; slot_index: number; telegram_id?: number | null; team_name?: string | null }[] = [];
      (personal ?? []).slice(0, 4).forEach((telegram_id, slot_index) => {
        toUpsert.push({
          event_id: eventId,
          slot_type: 'personal',
          slot_index,
          telegram_id: telegram_id ?? null,
          team_name: null,
        });
      });
      (team ?? []).slice(0, 3).forEach((team_name, slot_index) => {
        toUpsert.push({
          event_id: eventId,
          slot_type: 'team',
          slot_index,
          telegram_id: null,
          team_name: team_name?.trim() || null,
        });
      });

      for (const row of toUpsert) {
        const { error: upsertError } = await supabase.from('event_bingo_winners').upsert(row, {
          onConflict: 'event_id,slot_type,slot_index',
          ignoreDuplicates: false,
        });
        if (upsertError) throw new Error(upsertError.message);
      }

      res.json({ success: true });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

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

export default router;

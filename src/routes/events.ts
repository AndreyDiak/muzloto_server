import { Response, Router } from 'express';
import { REWARDS_CONFIG } from '../config/rewards';
import { REGISTRATION_REWARD } from '../constants';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const router = Router();

const PERSONAL_SLOTS = 4;
const TEAM_SLOTS = 3;

interface BingoWinnerRow {
  slot_type: string;
  slot_index: number;
  telegram_id: number | null;
  team_name: string | null;
  team_id: string | null;
  prize_code: string | null;
}

interface ProfileBrief {
  telegram_id: number;
  first_name: string | null;
  username: string | null;
  avatar_url: string | null;
}

async function fetchProfileMap(telegramIds: number[]): Promise<Map<string, ProfileBrief>> {
  const map = new Map<string, ProfileBrief>();
  if (telegramIds.length === 0) return map;
  const { data: profiles } = await supabase
    .from('profiles')
    .select('telegram_id, first_name, username, avatar_url')
    .in('telegram_id', telegramIds);
  for (const p of profiles ?? []) {
    map.set(String(p.telegram_id), p as ProfileBrief);
  }
  return map;
}

interface PrizeCodeInfo {
  telegram_id: number | null;
  used_at: string | null;
}

function buildPersonalResponse(
  slot: { telegram_id: number | null; prize_code: string | null },
  profileMap: Map<string, ProfileBrief>,
  prizeCodeMap: Map<string, PrizeCodeInfo>,
) {
  if (slot.prize_code) {
    const prizeInfo = prizeCodeMap.get(slot.prize_code);
    const redeemed = prizeInfo?.telegram_id != null;
    const redeemerProfile = redeemed ? profileMap.get(String(prizeInfo!.telegram_id)) : null;
    return {
      code: slot.prize_code,
      redeemed,
      redeemed_at: prizeInfo?.used_at ?? null,
      redeemed_by: redeemed
        ? {
            telegram_id: prizeInfo!.telegram_id,
            first_name: redeemerProfile?.first_name ?? null,
            username: redeemerProfile?.username ?? null,
            avatar_url: redeemerProfile?.avatar_url ?? null,
          }
        : null,
    };
  }
  if (slot.telegram_id == null) return null;
  const p = profileMap.get(String(slot.telegram_id));
  return {
    telegram_id: slot.telegram_id,
    first_name: p?.first_name ?? null,
    username: p?.username ?? null,
    avatar_url: p?.avatar_url ?? null,
    registered_at: '',
    status: '',
  };
}

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

/** GET /api/events/my-registration — текущая регистрация пользователя (последняя по дате) */
router.get('/my-registration', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const { data: reg, error: regError } = await supabase
      .from('registrations')
      .select('event_id, team_id, registered_at')
      .eq('telegram_id', telegramId)
      .order('registered_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (regError) throw new Error(regError.message);
    if (!reg) {
      return res.json({ registration: null });
    }

    // Параллельно: событие + команда (если есть)
    const [eventResult, teamResult] = await Promise.all([
      supabase.from('events').select('id, title').eq('id', reg.event_id).single(),
      reg.team_id
        ? supabase.from('event_teams').select('id, name').eq('id', reg.team_id).single()
        : Promise.resolve({ data: null }),
    ]);

    res.json({
      registration: {
        event: eventResult.data ? { id: eventResult.data.id, title: eventResult.data.title } : null,
        team: teamResult.data ? { id: teamResult.data.id, name: teamResult.data.name } : null,
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

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 символов.' });
    }

    const normalizedCode = code.toUpperCase();

    if (normalizedCode === '00000') {
      return res.json({
        event: { id: 'test', title: 'Тестовое событие' },
        teams: [],
        alreadyRegistered: false,
        coinsReward: REGISTRATION_REWARD,
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

    const [{ data: existingRegistration }, { data: teams }] = await Promise.all([
      supabase
        .from('registrations')
        .select('id')
        .eq('event_id', event.id)
        .eq('telegram_id', telegramId)
        .maybeSingle(),
      supabase
        .from('event_teams')
        .select('id, name')
        .eq('event_id', event.id)
        .order('name'),
    ]);

    res.json({
      event: { id: event.id, title: event.title },
      teams: (teams ?? []).map((t) => ({ id: t.id, name: t.name })),
      alreadyRegistered: !!existingRegistration,
      coinsReward: REGISTRATION_REWARD,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

/** POST /api/events/register — зарегистрироваться на мероприятие (с выбором команды) */
router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code, team_id } = req.body as { code?: string; team_id?: string };
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

    // Если у мероприятия есть команды, team_id обязателен
    if (team_id) {
      const { data: teamRow } = await supabase
        .from('event_teams')
        .select('id')
        .eq('id', team_id)
        .eq('event_id', event.id)
        .maybeSingle();
      if (!teamRow) {
        return res.status(400).json({ error: 'Указанная команда не найдена для этого мероприятия.' });
      }
    }

    const { error: registrationError } = await supabase.from('registrations').insert({
      event_id: event.id,
      telegram_id: telegramId,
      status: 'confirmed',
      ...(team_id ? { team_id } : {}),
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
  personal_bingo_horizontal: REWARDS_CONFIG.bingo_rewards.personal.horizontal,
  personal_bingo_vertical: REWARDS_CONFIG.bingo_rewards.personal.vertical,
  personal_bingo_diagonal: REWARDS_CONFIG.bingo_rewards.personal.diagonal,
  personal_bingo_full_card: REWARDS_CONFIG.bingo_rewards.personal.full_card,
  team_bingo_horizontal: REWARDS_CONFIG.bingo_rewards.team.horizontal,
  team_bingo_vertical: REWARDS_CONFIG.bingo_rewards.team.vertical,
  team_bingo_full_card: REWARDS_CONFIG.bingo_rewards.team.full_card,
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

const TEAM_REWARD_TYPES = ['team_bingo_horizontal', 'team_bingo_vertical', 'team_bingo_full_card'];

/** POST /api/events/award-team-coins — начислить монеты всем участникам команды поровну (только root) */
router.post(
  '/award-team-coins',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { event_id, team_id, reward_type } = req.body as {
        event_id?: string;
        team_id?: string;
        reward_type?: string;
      };

      if (!event_id || !team_id) {
        return res.status(400).json({
          error: 'Укажите event_id и team_id.',
        });
      }

      if (!reward_type || !TEAM_REWARD_TYPES.includes(reward_type) || !(reward_type in REWARD_TYPES)) {
        return res.status(400).json({
          error: 'Укажите reward_type: team_bingo_horizontal, team_bingo_vertical или team_bingo_full_card.',
        });
      }

      const amount = REWARD_TYPES[reward_type] as number;

      const { data: regs, error: regsError } = await supabase
        .from('registrations')
        .select('telegram_id')
        .eq('event_id', event_id)
        .eq('team_id', team_id);

      if (regsError) throw new Error(regsError.message);

      const members = (regs ?? []).map((r) => r.telegram_id);
      if (members.length === 0) {
        return res.status(404).json({
          error: 'В команде нет зарегистрированных участников.',
        });
      }

      const perMember = Math.floor(amount / members.length);

      for (const telegramId of members) {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('balance')
          .eq('telegram_id', telegramId)
          .single();

        if (profileError || !profile) continue;

        const newBalance = (profile.balance ?? 0) + perMember;
        await supabase
          .from('profiles')
          .update({ balance: newBalance })
          .eq('telegram_id', telegramId);
      }

      const { data: existingStats } = await supabase
        .from('event_team_stats')
        .select('id, total_coins_earned, bingo_wins_count')
        .eq('event_id', event_id)
        .eq('team_id', team_id)
        .maybeSingle();

      const now = new Date().toISOString();
      if (existingStats) {
        await supabase
          .from('event_team_stats')
          .update({
            total_coins_earned: existingStats.total_coins_earned + amount,
            bingo_wins_count: existingStats.bingo_wins_count + 1,
            updated_at: now,
          })
          .eq('event_id', event_id)
          .eq('team_id', team_id);
      } else {
        await supabase.from('event_team_stats').insert({
          event_id,
          team_id,
          total_coins_earned: amount,
          bingo_wins_count: 1,
          updated_at: now,
        });
      }

      res.json({
        success: true,
        amount,
        membersCount: members.length,
        perMember,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** GET /api/events/:eventId/teams — список команд мероприятия (все участники) */
router.get(
  '/:eventId/teams',
  verifyTelegramAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: teams, error } = await supabase
        .from('event_teams')
        .select('id, name')
        .eq('event_id', eventId)
        .order('name');

      if (error) throw new Error(error.message);
      res.json({ teams: teams ?? [] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

/** POST /api/events/:eventId/teams — создать команду для мероприятия (только root) */
router.post(
  '/:eventId/teams',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { name } = req.body as { name?: string };

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Укажите название команды.' });
      }

      const trimmedName = name.trim();

      const { data: inserted, error } = await supabase
        .from('event_teams')
        .insert({ event_id: eventId, name: trimmedName })
        .select('id, name')
        .single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ error: 'Команда с таким названием уже существует.' });
        }
        throw new Error(error.message);
      }

      res.status(201).json({ team: inserted });
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
      const { reward_type } = req.body ?? {};
      const { BINGO_REWARD } = await import('../constants');
      const coinsAmount =
        typeof reward_type === 'string' && reward_type in REWARD_TYPES
          ? REWARD_TYPES[reward_type]
          : BINGO_REWARD;
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
          coins_amount: coinsAmount,
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

/** GET /api/events/:eventId/bingo-winners — сохранённые победители бинго (все участники) */
router.get(
  '/:eventId/bingo-winners',
  verifyTelegramAuth,
  async (req: AuthRequest, res: Response) => {
    try {
      const { eventId } = req.params;
      const { data: rows, error } = await supabase
        .from('event_bingo_winners')
        .select('slot_type, slot_index, telegram_id, team_name, team_id, prize_code')
        .eq('event_id', eventId);

      if (error) throw new Error(error.message);

      const personal = Array.from({ length: PERSONAL_SLOTS }, () => ({
        telegram_id: null as number | null,
        prize_code: null as string | null,
      }));
      const teamRaw = Array.from({ length: TEAM_SLOTS }, () => ({
        team_id: null as string | null,
        team_name: null as string | null,
        prize_code: null as string | null,
      }));

      // Собираем team_id для резолва имён команд
      const teamIds: string[] = [];
      for (const r of (rows ?? []) as BingoWinnerRow[]) {
        if (r.slot_type === 'personal' && r.slot_index >= 0 && r.slot_index < PERSONAL_SLOTS) {
          personal[r.slot_index] = { telegram_id: r.telegram_id, prize_code: r.prize_code };
        } else if (r.slot_type === 'team' && r.slot_index >= 0 && r.slot_index < TEAM_SLOTS) {
          if (r.team_id) teamIds.push(r.team_id);
          teamRaw[r.slot_index] = { team_id: r.team_id, team_name: r.team_name, prize_code: r.prize_code };
        }
      }

      // Резолвим имена команд по team_id
      const teamNameMap = new Map<string, string>();
      if (teamIds.length > 0) {
        const { data: teamRows } = await supabase
          .from('event_teams')
          .select('id, name')
          .in('id', teamIds);
        for (const t of teamRows ?? []) {
          teamNameMap.set(t.id, t.name);
        }
      }

      // Собираем все prize_code из слотов (personal + team) для поиска информации о погашении
      const prizeCodes = [
        ...personal.map((s) => s.prize_code),
        ...teamRaw.map((s) => s.prize_code),
      ].filter((c): c is string => c != null);

      const prizeCodeMap = new Map<string, PrizeCodeInfo>();
      if (prizeCodes.length > 0) {
        const { data: prizeRows } = await supabase
          .from('event_prize_codes')
          .select('code, telegram_id, used_at')
          .in('code', prizeCodes);
        for (const pr of prizeRows ?? []) {
          prizeCodeMap.set(pr.code, { telegram_id: pr.telegram_id, used_at: pr.used_at });
        }
      }

      // Собираем telegram_id победителей + telegram_id тех, кто погасил коды
      const telegramIds = [
        ...personal.map((s) => s.telegram_id).filter((id): id is number => id != null),
        ...[...prizeCodeMap.values()].map((v) => v.telegram_id).filter((id): id is number => id != null),
      ];
      const uniqueTelegramIds = [...new Set(telegramIds)];

      const profileMap = await fetchProfileMap(uniqueTelegramIds);
      const personalResponse = personal.map((slot) => buildPersonalResponse(slot, profileMap, prizeCodeMap));

      // Формируем team response: команда, код, или null
      const teamResponse = teamRaw.map((slot) => {
        if (slot.prize_code) {
          const prizeInfo = prizeCodeMap.get(slot.prize_code);
          const redeemed = prizeInfo?.telegram_id != null;
          const redeemerProfile = redeemed ? profileMap.get(String(prizeInfo!.telegram_id)) : null;
          return {
            code: slot.prize_code,
            redeemed,
            redeemed_at: prizeInfo?.used_at ?? null,
            redeemed_by: redeemed
              ? {
                  telegram_id: prizeInfo!.telegram_id,
                  first_name: redeemerProfile?.first_name ?? null,
                  username: redeemerProfile?.username ?? null,
                  avatar_url: redeemerProfile?.avatar_url ?? null,
                }
              : null,
          };
        }
        if (slot.team_id) {
          return { id: slot.team_id, name: teamNameMap.get(slot.team_id) ?? slot.team_name ?? '' };
        }
        if (slot.team_name) {
          return { id: '', name: slot.team_name };
        }
        return null;
      });

      res.json({ personal: personalResponse, team: teamResponse });
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
        personal?: (number | null | { code: string })[];
        team?: ({ id: string; name: string } | { code: string } | string | null)[];
      };

      const toUpsert: { event_id: string; slot_type: string; slot_index: number; telegram_id?: number | null; team_name?: string | null; team_id?: string | null; prize_code?: string | null }[] = [];
      (personal ?? []).slice(0, 4).forEach((item, slot_index) => {
        const isCode = item != null && typeof item === 'object' && 'code' in item;
        toUpsert.push({
          event_id: eventId,
          slot_type: 'personal',
          slot_index,
          telegram_id: isCode ? null : (typeof item === 'number' ? item : null),
          team_name: null,
          team_id: null,
          prize_code: isCode && typeof (item as { code?: string }).code === 'string' ? (item as { code: string }).code : null,
        });
      });
      (team ?? []).slice(0, 3).forEach((item, slot_index) => {
        const isCode = item != null && typeof item === 'object' && 'code' in item && !('id' in item);
        const isTeamObj = item != null && typeof item === 'object' && 'id' in item;
        toUpsert.push({
          event_id: eventId,
          slot_type: 'team',
          slot_index,
          telegram_id: null,
          team_id: isTeamObj ? (item as { id: string }).id || null : null,
          team_name: isTeamObj ? (item as { name: string }).name?.trim() || null : (typeof item === 'string' ? item.trim() || null : null),
          prize_code: isCode ? (item as { code: string }).code : null,
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
        .select('telegram_id, registered_at, status, team_id')
        .eq('event_id', eventId)
        .order('registered_at', { ascending: false });

      if (regError) {
        throw new Error(regError.message);
      }

      if (!regs?.length) {
        return res.json({ registrations: [] });
      }

      // Параллельно: профили + команды
      const telegramIds = [...new Set(regs.map((r) => String(r.telegram_id)))];
      const teamIds = [...new Set(regs.map((r) => r.team_id).filter((id): id is string => !!id))];

      const [{ data: profiles, error: profilesError }, teamResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('telegram_id, first_name, username, avatar_url')
          .in('telegram_id', telegramIds),
        teamIds.length > 0
          ? supabase.from('event_teams').select('id, name').in('id', teamIds)
          : Promise.resolve({ data: [] as { id: string; name: string }[] }),
      ]);

      if (profilesError) {
        throw new Error(profilesError.message);
      }

      const profileByTgId = new Map(
        (profiles ?? []).map((p) => [String(p.telegram_id), p])
      );
      const teamById = new Map(
        ((teamResult as { data: { id: string; name: string }[] }).data ?? []).map((t) => [t.id, t.name])
      );

      const registrations = regs.map((r) => ({
        telegram_id: r.telegram_id,
        registered_at: r.registered_at,
        status: r.status,
        first_name: profileByTgId.get(String(r.telegram_id))?.first_name ?? null,
        username: profileByTgId.get(String(r.telegram_id))?.username ?? null,
        avatar_url: profileByTgId.get(String(r.telegram_id))?.avatar_url ?? null,
        team: r.team_id ? { id: r.team_id, name: teamById.get(r.team_id) ?? null } : null,
      }));

      res.json({ registrations });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  }
);

export default router;

import { Response, Router } from 'express';
import { ACHIEVEMENTS } from '../config/achievements';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

export interface AchievementWithUnlocked {
  slug: string;
  badge: string;
  name: string;
  description: string;
  label: string;
  stat_key: 'games_visited' | 'tickets_purchased' | 'bingo_collected';
  unlocked: boolean;
  unlocked_at: string | null;
  reward_claimed_at: string | null;
  threshold: number;
  current_value: number;
  coin_reward: number | null;
}

router.get('/', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const [
      { data: unlockedRows, error: unlockedError },
      { data: stats, error: statsError },
    ] = await Promise.all([
      supabase
        .from('user_achievements')
        .select('achievement_slug, unlocked_at, reward_claimed_at')
        .eq('telegram_id', telegramId),
      supabase
        .from('user_stats')
        .select('games_visited, tickets_purchased, bingo_collected')
        .eq('telegram_id', telegramId)
        .single(),
    ]);

    if (unlockedError) {
      throw new Error(`Failed to fetch user achievements: ${unlockedError.message}`);
    }

    const unlockedMap = new Map<string, { unlocked_at: string; reward_claimed_at: string | null }>(
      (unlockedRows ?? []).map((r) => [
        r.achievement_slug,
        { unlocked_at: r.unlocked_at, reward_claimed_at: r.reward_claimed_at ?? null },
      ])
    );

    const statsMap = {
      games_visited: stats?.games_visited ?? 0,
      tickets_purchased: stats?.tickets_purchased ?? 0,
      bingo_collected: stats?.bingo_collected ?? 0,
    };

    const list: AchievementWithUnlocked[] = ACHIEVEMENTS.map((a) => {
      const row = unlockedMap.get(a.slug);
      return {
        slug: a.slug,
        badge: a.badge,
        name: a.name,
        description: a.description,
        label: a.label,
        stat_key: a.statKey,
        unlocked: unlockedMap.has(a.slug),
        unlocked_at: row?.unlocked_at ?? null,
        reward_claimed_at: row?.reward_claimed_at ?? null,
        threshold: a.threshold,
        current_value: statsMap[a.statKey],
        coin_reward: a.coinReward ?? null,
      };
    });

    if (statsError && statsError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch user stats: ${statsError.message}`);
    }

    res.json({ achievements: list });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

router.post('/claim', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;
    const { achievement_slug } = req.body;

    if (!achievement_slug || typeof achievement_slug !== 'string') {
      return res.status(400).json({ error: 'Укажите achievement_slug.' });
    }

    const ach = ACHIEVEMENTS.find((a) => a.slug === achievement_slug);
    if (!ach || (ach.coinReward ?? 0) <= 0) {
      return res.status(400).json({ error: 'Достижение не найдено или без награды.' });
    }

    const { data: row, error: rowError } = await supabase
      .from('user_achievements')
      .select('achievement_slug, reward_claimed_at')
      .eq('telegram_id', telegramId)
      .eq('achievement_slug', achievement_slug)
      .single();

    if (rowError || !row) {
      return res.status(404).json({ error: 'Достижение не разблокировано.' });
    }
    if (row.reward_claimed_at) {
      return res.status(409).json({ error: 'Награда уже получена.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Профиль не найден.' });
    }

    const currentBalance = Number(profile.balance) ?? 0;
    const newBalance = currentBalance + ach.coinReward!;

    const [{ error: updateBalanceError }, { error: updateClaimError }] = await Promise.all([
      supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId),
      supabase
        .from('user_achievements')
        .update({ reward_claimed_at: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('achievement_slug', achievement_slug),
    ]);

    if (updateBalanceError || updateClaimError) {
      throw new Error(updateBalanceError?.message ?? updateClaimError?.message ?? 'Ошибка обновления');
    }

    res.json({
      success: true,
      coinsAdded: ach.coinReward,
      newBalance,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

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
        .select('achievement_slug, unlocked_at')
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

    const unlockedMap = new Map<string, string>(
      (unlockedRows ?? []).map((r) => [r.achievement_slug, r.unlocked_at])
    );

    const statsMap = {
      games_visited: stats?.games_visited ?? 0,
      tickets_purchased: stats?.tickets_purchased ?? 0,
      bingo_collected: stats?.bingo_collected ?? 0,
    };

    const list: AchievementWithUnlocked[] = ACHIEVEMENTS.map((a) => ({
      slug: a.slug,
      badge: a.badge,
      name: a.name,
      description: a.description,
      label: a.label,
      stat_key: a.statKey,
      unlocked: unlockedMap.has(a.slug),
      unlocked_at: unlockedMap.get(a.slug) ?? null,
      threshold: a.threshold,
      current_value: statsMap[a.statKey],
      coin_reward: a.coinReward ?? null,
    }));

    if (statsError && statsError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch user stats: ${statsError.message}`);
    }

    res.json({ achievements: list });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

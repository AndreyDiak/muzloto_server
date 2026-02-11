import { Response, Router } from 'express';
import { VISIT_REWARD_COINS, VISIT_REWARD_EVERY } from '../constants';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

router.get('/', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const { data: stats, error: statsError } = await supabase
      .from('user_stats')
      .select('games_visited, visit_rewards_claimed')
      .eq('telegram_id', telegramId)
      .single();

    if (statsError && statsError.code !== 'PGRST116') {
      throw new Error(`Failed to fetch user stats: ${statsError.message}`);
    }

    const every = VISIT_REWARD_EVERY;
    const gamesVisited = stats?.games_visited ?? 0;
    const visitRewardsClaimed = stats?.visit_rewards_claimed ?? 0;
    const visitRewardProgress = gamesVisited - visitRewardsClaimed * every;
    const visitRewardPending = visitRewardProgress >= every;

    res.json({
      achievements: [],
      games_visited: gamesVisited,
      visit_reward_progress: Math.min(visitRewardProgress, every),
      visit_reward_pending: visitRewardPending,
      visit_reward_coins: VISIT_REWARD_COINS,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

router.post('/claim-visit-reward', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const { data: stats, error: statsError } = await supabase
      .from('user_stats')
      .select('games_visited, visit_rewards_claimed')
      .eq('telegram_id', telegramId)
      .single();

    if (statsError || !stats) {
      return res.status(404).json({ error: 'Статистика не найдена.' });
    }

    const every = VISIT_REWARD_EVERY;
    const gamesVisited = stats.games_visited ?? 0;
    const visitRewardsClaimed = stats.visit_rewards_claimed ?? 0;
    const visitRewardProgress = gamesVisited - visitRewardsClaimed * every;

    if (visitRewardProgress < every) {
      return res.status(400).json({ error: 'Нет доступной награды за посещения.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Профиль не найден.' });
    }

    const newBalance = (Number(profile.balance) ?? 0) + VISIT_REWARD_COINS;

    const [{ error: updateBalanceError }, { error: updateStatsError }] = await Promise.all([
      supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId),
      supabase
        .from('user_stats')
        .update({ visit_rewards_claimed: visitRewardsClaimed + 1 })
        .eq('telegram_id', telegramId),
    ]);

    if (updateBalanceError || updateStatsError) {
      throw new Error(updateBalanceError?.message ?? updateStatsError?.message ?? 'Ошибка обновления');
    }

    res.json({
      success: true,
      coinsAdded: VISIT_REWARD_COINS,
      newBalance,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

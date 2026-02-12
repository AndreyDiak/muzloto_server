import { Response, Router } from 'express';
import { PURCHASE_ACHIEVEMENT_REWARDS, VISIT_REWARD_COINS, VISIT_REWARD_EVERY } from '../constants';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { grantPurchaseAchievementRewards } from '../services/achievements';
import { supabase } from '../services/supabase';

const router = Router();

const PURCHASE_CLAIMED_KEYS: Record<number, keyof { purchase_reward_1_claimed_at: string; purchase_reward_3_claimed_at: string; purchase_reward_5_claimed_at: string }> = {
  1: 'purchase_reward_1_claimed_at',
  3: 'purchase_reward_3_claimed_at',
  5: 'purchase_reward_5_claimed_at',
};

router.get('/', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;

    const { data: stats, error: statsError } = await supabase
      .from('user_stats')
      .select(
        'games_visited, visit_rewards_claimed, tickets_purchased, purchase_reward_1_claimed_at, purchase_reward_3_claimed_at, purchase_reward_5_claimed_at'
      )
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
    const ticketsPurchased = stats?.tickets_purchased ?? 0;

    // Достижения за покупки: 1, 3, 5 покупок
    const purchaseAchievementsConfig = [
      { threshold: 1, name: 'Первая покупка', description: 'Совершите 1 покупку в магазине', badge: '🛒' },
      { threshold: 3, name: 'Три покупки', description: 'Совершите 3 покупки в магазине', badge: '🛍️' },
      { threshold: 5, name: 'Пять покупок', description: 'Совершите 5 покупок в магазине', badge: '⭐' },
    ];
    const purchaseAchievements = purchaseAchievementsConfig.map((ach) => {
      const rewardClaimedAt = stats?.[PURCHASE_CLAIMED_KEYS[ach.threshold] as keyof typeof stats] ?? null;
      const coinReward = PURCHASE_ACHIEVEMENT_REWARDS[ach.threshold] ?? null;
      return {
        slug: `purchases_${ach.threshold}`,
        badge: ach.badge,
        name: ach.name,
        description: ach.description,
        label: ach.threshold === 1 ? '1 покупка' : ach.threshold === 5 ? '5 покупок' : '3 покупки',
        stat_key: 'tickets_purchased' as const,
        threshold: ach.threshold,
        current_value: ticketsPurchased,
        coin_reward: coinReward,
        reward_claimed_at: rewardClaimedAt,
        unlocked: ticketsPurchased >= ach.threshold,
        unlocked_at: ticketsPurchased >= ach.threshold ? new Date().toISOString() : null,
      };
    });

    res.json({
      achievements: purchaseAchievements,
      games_visited: gamesVisited,
      tickets_purchased: ticketsPurchased,
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

/** POST /api/achievements/claim-purchase-rewards — забрать награды за достижения по покупкам (1, 3, 5), если порог достигнут и награда ещё не получена. */
router.post('/claim-purchase-rewards', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const telegramId = req.telegramId!;
    const { coinsAdded, newBalance } = await grantPurchaseAchievementRewards(telegramId);

    if (coinsAdded === 0) {
      return res.status(400).json({ error: 'Нет доступных наград за покупки.' });
    }

    res.json({
      success: true,
      coinsAdded,
      newBalance: newBalance ?? 0,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

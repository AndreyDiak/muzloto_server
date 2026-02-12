import { PURCHASE_ACHIEVEMENT_REWARDS } from '../constants';
import { supabase } from './supabase';

export interface NewlyUnlockedAchievement {
  slug: string;
  badge: string;
  name: string;
  description: string;
  label: string;
  coinReward?: number;
}

export interface CheckAndUnlockResult {
  newlyUnlocked: NewlyUnlockedAchievement[];
  totalCoinReward: number;
}

/** Таблица достижений удалена; функция оставлена для совместимости, всегда возвращает пустой результат */
export async function checkAndUnlockAchievements(
  _telegramId: number
): Promise<CheckAndUnlockResult> {
  return { newlyUnlocked: [], totalCoinReward: 0 };
}

const PURCHASE_CLAIMED_KEYS = {
  1: 'purchase_reward_1_claimed_at',
  3: 'purchase_reward_3_claimed_at',
  5: 'purchase_reward_5_claimed_at',
} as const;

/** Начисляет монеты за достижения по покупкам (1, 3, 5), если порог достигнут и награда ещё не выдана. Вызывать после incrementUserStat('tickets_purchased'). */
export async function grantPurchaseAchievementRewards(
  telegramId: number
): Promise<{ coinsAdded: number; newBalance?: number }> {
  const { data: stats, error: statsError } = await supabase
    .from('user_stats')
    .select(
      'tickets_purchased, purchase_reward_1_claimed_at, purchase_reward_3_claimed_at, purchase_reward_5_claimed_at'
    )
    .eq('telegram_id', telegramId)
    .single();

  if (statsError || !stats) return { coinsAdded: 0, newBalance: undefined };

  const ticketsPurchased = stats.tickets_purchased ?? 0;
  let totalCoins = 0;
  type Threshold = keyof typeof PURCHASE_CLAIMED_KEYS;
  const toClaim: { threshold: Threshold; coins: number }[] = [];

  for (const threshold of [1, 3, 5] as const) {
    const claimedAt = stats[PURCHASE_CLAIMED_KEYS[threshold]];
    const coins = PURCHASE_ACHIEVEMENT_REWARDS[threshold];
    if (coins != null && ticketsPurchased >= threshold && !claimedAt) {
      totalCoins += coins;
      toClaim.push({ threshold, coins });
    }
  }

  if (totalCoins === 0) return { coinsAdded: 0, newBalance: undefined };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || !profile) return { coinsAdded: 0, newBalance: undefined };

  const newBalance = (Number(profile.balance) ?? 0) + totalCoins;
  const now = new Date().toISOString();
  const updateStats: Record<string, string | null> = {};
  for (const { threshold } of toClaim) {
    updateStats[PURCHASE_CLAIMED_KEYS[threshold]] = now;
  }

  const [balanceRes, statsRes] = await Promise.all([
    supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId),
    supabase.from('user_stats').update(updateStats).eq('telegram_id', telegramId),
  ]);

  if (balanceRes.error || statsRes.error) return { coinsAdded: 0, newBalance: undefined };
  return { coinsAdded: totalCoins, newBalance };
}

type PurchaseThreshold = 1 | 3 | 5;

/** Начисляет монеты только за один порог (1, 3 или 5 покупок), если достигнут и награда ещё не выдана. */
export async function grantSinglePurchaseAchievementReward(
  telegramId: number,
  threshold: PurchaseThreshold
): Promise<{ coinsAdded: number; newBalance?: number }> {
  const key = PURCHASE_CLAIMED_KEYS[threshold];
  const coins = PURCHASE_ACHIEVEMENT_REWARDS[threshold];
  if (coins == null) return { coinsAdded: 0, newBalance: undefined };

  const { data: stats, error: statsError } = await supabase
    .from('user_stats')
    .select(`tickets_purchased, ${key}`)
    .eq('telegram_id', telegramId)
    .single();

  if (statsError || !stats) return { coinsAdded: 0, newBalance: undefined };

  const ticketsPurchased = stats.tickets_purchased ?? 0;
  const claimedAt = stats[key as keyof typeof stats];
  if (ticketsPurchased < threshold || claimedAt) return { coinsAdded: 0, newBalance: undefined };

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || !profile) return { coinsAdded: 0, newBalance: undefined };

  const newBalance = (Number(profile.balance) ?? 0) + coins;
  const now = new Date().toISOString();

  const [balanceRes, statsRes] = await Promise.all([
    supabase.from('profiles').update({ balance: newBalance }).eq('telegram_id', telegramId),
    supabase.from('user_stats').update({ [key]: now }).eq('telegram_id', telegramId),
  ]);

  if (balanceRes.error || statsRes.error) return { coinsAdded: 0, newBalance: undefined };
  return { coinsAdded: coins, newBalance };
}

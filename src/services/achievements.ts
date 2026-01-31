import { ACHIEVEMENTS, type AchievementDefinition } from '../config/achievements';
import { supabase } from './supabase';

export interface NewlyUnlockedAchievement {
  slug: string;
  badge: string;
  name: string;
  description: string;
  label: string;
  /** Награда монетами за эту ачивку (если задана в конфиге) */
  coinReward?: number;
}

export interface CheckAndUnlockResult {
  newlyUnlocked: NewlyUnlockedAchievement[];
  totalCoinReward: number;
}

/**
 * Проверяет пороги по user_stats, записывает новые разблокировки в user_achievements.
 * Возвращает список только что разблокированных ачивок и сумму наград монетами.
 */
export async function checkAndUnlockAchievements(
  telegramId: number
): Promise<CheckAndUnlockResult> {
  const { data: stats, error: statsError } = await supabase
    .from('user_stats')
    .select('games_visited, tickets_purchased, bingo_collected')
    .eq('telegram_id', telegramId)
    .single();

  if (statsError && statsError.code !== 'PGRST116') {
    throw new Error(`Failed to fetch user_stats: ${statsError.message}`);
  }

  const gamesVisited = stats?.games_visited ?? 0;
  const ticketsPurchased = stats?.tickets_purchased ?? 0;
  const bingoCollected = stats?.bingo_collected ?? 0;

  const statsMap = {
    games_visited: gamesVisited,
    tickets_purchased: ticketsPurchased,
    bingo_collected: bingoCollected,
  };

  const newlyUnlocked: NewlyUnlockedAchievement[] = [];
  let totalCoinReward = 0;

  for (const ach of ACHIEVEMENTS) {
    const value = statsMap[ach.statKey];
    if (value < ach.threshold) continue;

    const { error: insertError } = await supabase
      .from('user_achievements')
      .insert({
        telegram_id: telegramId,
        achievement_slug: ach.slug,
        unlocked_at: new Date().toISOString(),
      });

    if (insertError) {
      if (insertError.code === '23505') {
        continue;
      }
      throw new Error(`Failed to insert user_achievement: ${insertError.message}`);
    }

    const reward = ach.coinReward ?? 0;
    if (reward > 0) totalCoinReward += reward;

    newlyUnlocked.push({
      slug: ach.slug,
      badge: ach.badge,
      name: ach.name,
      description: ach.description,
      label: ach.label,
      ...(reward > 0 && { coinReward: reward }),
    });
  }

  return { newlyUnlocked, totalCoinReward };
}

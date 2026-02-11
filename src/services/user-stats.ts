import { supabase } from './supabase';

/** Ключи счётчиков в user_stats (для RPC increment_user_stat) */
type AchievementStatKey = 'games_visited' | 'tickets_purchased' | 'bingo_collected';

/**
 * Увеличивает счётчик пользователя на 1.
 * Создаёт запись в user_stats при первом вызове для данного telegram_id.
 */
export async function incrementUserStat(
  telegramId: number,
  statKey: AchievementStatKey
): Promise<void> {
  const { error } = await supabase.rpc('increment_user_stat', {
    p_telegram_id: telegramId,
    p_stat: statKey,
  });

  if (error) {
    throw new Error(`Failed to increment user stat ${statKey}: ${error.message}`);
  }
}

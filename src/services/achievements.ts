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

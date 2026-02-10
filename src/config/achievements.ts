import { getAchievementCoinReward } from './rewards';

/**
 * Конфиг достижений: пороговые значения и описания.
 * statKey — поле в user_stats, по которому проверяем условие.
 * threshold — минимальное значение для разблокировки.
 * Награды монетами берутся из config/rewards.ts по ключам.
 */
export type AchievementStatKey = 'games_visited' | 'tickets_purchased' | 'bingo_collected';

export interface AchievementDefinition {
  /** Уникальный slug для API и отображения */
  slug: string;
  /** Эмодзи уровня (🥉, 🥈, 🥇 и т.д.) */
  badge: string;
  /** Название ачивки */
  name: string;
  /** За что даётся: «1 посещение», «5 посещений» */
  description: string;
  /** Смехотворная приставка / подпись */
  label: string;
  /** Поле в user_stats для проверки */
  statKey: AchievementStatKey;
  /** Минимальное значение для разблокировки */
  threshold: number;
  /** Награда монетами при разблокировке (из config/rewards) */
  coinReward?: number;
}

const DEFS: Omit<AchievementDefinition, 'coinReward'>[] = [
  {
    slug: 'visit_1',
    badge: '🥉',
    name: 'Первый куплет',
    description: 'Посетить мероприятие 1 раз',
    label: 'Ты вышел к микрофону. Всё только начинается.',
    statKey: 'games_visited',
    threshold: 1,
  },
  {
    slug: 'visit_5',
    badge: '🥈',
    name: 'Вошёл в ритм',
    description: 'Посетить мероприятие 5 раз',
    label: 'Уже не оглядываешься на экран — ловишь бит.',
    statKey: 'games_visited',
    threshold: 5,
  },
  {
    slug: 'visit_10',
    badge: '🥇',
    name: 'Припев пошёл',
    description: 'Посетить мероприятие 10 раз',
    label: 'Теперь тебя слышно. И подпевают тоже.',
    statKey: 'games_visited',
    threshold: 10,
  },
  {
    slug: 'visit_25',
    badge: '⭐',
    name: 'Бридж',
    description: 'Посетить мероприятие 25 раз',
    label: 'Момент, когда стиль уже есть, а голос — узнают.',
    statKey: 'games_visited',
    threshold: 25,
  },
  {
    slug: 'visit_50',
    badge: '🔥',
    name: 'Финальный припев',
    description: 'Посетить мероприятие 50 раз',
    label: 'Зал качает. Ты — часть легенды вечеринок.',
    statKey: 'games_visited',
    threshold: 50,
  },
  {
    slug: 'visit_100',
    badge: '👑',
    name: 'Легенда КараокеЛото',
    description: 'Посетить мероприятие 100 раз',
    label: 'Твой голос — часть истории.',
    statKey: 'games_visited',
    threshold: 100,
  },
  {
    slug: 'shop_3',
    badge: '🥉',
    name: 'Покупатель',
    description: 'Сделать 3 покупки в магазине',
    label: 'Каталог уже не чужой.',
    statKey: 'tickets_purchased',
    threshold: 3,
  },
  {
    slug: 'shop_5',
    badge: '🥈',
    name: 'Постоянный клиент',
    description: 'Сделать 5 покупок в магазине',
    label: 'Ты знаешь, что брать.',
    statKey: 'tickets_purchased',
    threshold: 5,
  },
  {
    slug: 'shop_10',
    badge: '🥇',
    name: 'Друг магазина',
    description: 'Сделать 10 покупок в магазине',
    label: 'Магазин рад тебя видеть.',
    statKey: 'tickets_purchased',
    threshold: 10,
  },
];

/** Достижения с наградами из config/rewards.ts (по slug) */
export const ACHIEVEMENTS: AchievementDefinition[] = DEFS.map((d) => ({
  ...d,
  coinReward: getAchievementCoinReward(d.slug),
}));

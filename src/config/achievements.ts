/**
 * Конфиг достижений: пороговые значения и описания.
 * statKey — поле в user_stats, по которому проверяем условие.
 * threshold — минимальное значение для разблокировки.
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
  /** Награда монетами при разблокировке (опционально) */
  coinReward?: number;
}

export const ACHIEVEMENTS: AchievementDefinition[] = [
  {
    slug: 'first_verse',
    badge: '🥉',
    name: 'Первый куплет',
    description: 'Посетить мероприятие 1 раз',
    label: 'Ты вышел к микрофону. Всё только начинается.',
    statKey: 'games_visited',
    threshold: 1,
  },
  {
    slug: 'in_rhythm',
    badge: '🥈',
    name: 'Вошёл в ритм',
    description: 'Посетить мероприятие 5 раз',
    label: 'Уже не оглядываешься на экран — ловишь бит.',
    statKey: 'games_visited',
    threshold: 5,
    coinReward: 15,
  },
  {
    slug: 'chorus_going',
    badge: '🥇',
    name: 'Припев пошёл',
    description: 'Посетить мероприятие 10 раз',
    label: 'Теперь тебя слышно. И подпевают тоже.',
    statKey: 'games_visited',
    threshold: 10,
  },
  {
    slug: 'bridge',
    badge: '⭐',
    name: 'Бридж',
    description: 'Посетить мероприятие 25 раз',
    label: 'Момент, когда стиль уже есть, а голос — узнают.',
    statKey: 'games_visited',
    threshold: 25,
    coinReward: 50,
  },
  {
    slug: 'final_chorus',
    badge: '🔥',
    name: 'Финальный припев',
    description: 'Посетить мероприятие 50 раз',
    label: 'Зал качает. Ты — часть легенды вечеринок.',
    statKey: 'games_visited',
    threshold: 50,
  },
  {
    slug: 'karaoke_legend',
    badge: '👑',
    name: 'Легенда КараокеЛото',
    description: 'Посетить мероприятие 100 раз',
    label: 'Твой голос — часть истории.',
    statKey: 'games_visited',
    threshold: 100,
    coinReward: 100,
  },
  // По количеству купленных билетов
  {
    slug: 'has_ticket',
    badge: '🥉',
    name: 'Есть билетик',
    description: 'Купить 1 билет',
    label: 'Решился. Значит, будет громко.',
    statKey: 'tickets_purchased',
    threshold: 1,
  },
  {
    slug: 'buying_for_friends',
    badge: '🥈',
    name: 'Беру друзьям',
    description: 'Купить 5 билетов',
    label: 'Когда одного микрофона уже мало.',
    statKey: 'tickets_purchased',
    threshold: 5,
    coinReward: 50
  },
  {
    slug: 'karaoke_magnate',
    badge: '🥇',
    name: 'Караоке-магнат',
    description: 'Купить 10 билетов',
    label: 'Ты не просто играешь — ты запускаешь вечеринку 😎',
    statKey: 'tickets_purchased',
    threshold: 10,
  },
  // По победам в бинго
  {
    slug: 'first_bingo',
    badge: '🥉',
    name: 'Первое БИНГО',
    description: 'Собрать первое бинго',
    label: 'Поймал удачу. И микрофон тоже.',
    statKey: 'bingo_collected',
    threshold: 1,
  },
  {
    slug: 'lucky_number',
    badge: '🥈',
    name: 'Счастливый номер',
    description: 'Собрать бинго 3 раза',
    label: 'Кажется, это уже не случайность.',
    statKey: 'bingo_collected',
    threshold: 3,
    coinReward: 25
  },
  {
    slug: 'bingo_sense',
    badge: '🥇',
    name: 'Чует БИНГО',
    description: 'Собрать бинго 5 раз',
    label: 'Ты начинаешь чувствовать игру.',
    statKey: 'bingo_collected',
    threshold: 5,
  },
  {
    slug: 'bingo_master',
    badge: '⭐',
    name: 'Бинго-мастер',
    description: 'Собрать бинго 10 раз',
    label: 'Когда удача слушает тебя.',
    statKey: 'bingo_collected',
    threshold: 10,
    coinReward: 50
  },
  {
    slug: 'bingo_legend',
    badge: '👑',
    name: 'Легенда БИНГО',
    description: 'Собрать бинго 25 раз',
    label: 'Тебя боятся. Тебе аплодируют.',
    statKey: 'bingo_collected',
    threshold: 25,
  },
];

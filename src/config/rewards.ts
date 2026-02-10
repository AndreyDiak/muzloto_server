/**
 * Единый конфиг вознаграждений: посещения, ачивки, бинго, магазин и правила экономики.
 * Используется для начисления монет за посещения, разблокировку достижений и т.д.
 */

export const REWARDS_CONFIG = {
  currency: {
    name: 'coins',
    display_name: 'Монеты КараокеЛото',
    exchange_rate: {
      free_ticket: 100,
    },
  },

  game_constants: {
    ticket_price_rub: 1000,
    personal_bingo_count: 4,
    team_bingo_count: 3,
  },

  bingo_rewards: {
    personal: {
      horizontal: 75,
      vertical: 75,
      diagonal: 75,
      full_card: 100,
    },
    team: {
      horizontal: 125,
      vertical: 125,
      full_card: 150,
    },
  },

  visit_rewards: {
    per_visit: 250,
  },

  /** Награды за достижения по slug (из config/achievements) */
  achievement_rewards: {
    visit_1: 1_000,
    visit_5: 5_000,
    visit_10: 10_000,
    visit_25: 25_000,
    visit_50: 50_000,
    visit_100: 100_000,
    shop_3: 3_000,
    shop_5: 5_000,
    shop_10: 10_000,
  } as const,

  shop: {
    items: [
      { id: 'extra_card', name: 'Дополнительный бланк', price: 25 },
      { id: 'free_ticket', name: 'Бесплатный билет', price: 100 },

    ],
  },

  economy_rules: {
    coins_transferable: false,
    coins_convertible_to_money: false,
    max_free_tickets_per_month: 2,
    coins_expiration_months: 6,
    discounts_stackable: false,
  },
} as const;

/**
 * Возвращает награду монетами за достижение по slug.
 * Если в конфиге нет ключа для данного slug — возвращает undefined (награды нет).
 */
export function getAchievementCoinReward(slug: string): number | undefined {
  const rewards = REWARDS_CONFIG.achievement_rewards as Record<string, number>;
  return rewards[slug];
}

/** Монеты за одно посещение (регистрация на мероприятие) */
export function getVisitReward(): number {
  return REWARDS_CONFIG.visit_rewards.per_visit;
}

/**
 * Цена товара каталога по id из config (shop.items).
 * Используется для синхронизации цен: конфиг — единственный источник правды для цен.
 * Если товара нет в конфиге — возвращает undefined (тогда можно использовать цену из БД).
 */
export function getCatalogItemPrice(itemId: string): number | undefined {
  const item = REWARDS_CONFIG.shop.items.find((i) => i.id === itemId);
  return item?.price;
}

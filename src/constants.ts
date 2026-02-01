import { getVisitReward } from './config/rewards';

/** Монеты за регистрацию на мероприятие (из config/rewards) */
export const REGISTRATION_REWARD = getVisitReward();

/** Монеты за одно собранное бинго (пока из константы; при необходимости вынести в config/rewards) */
export const BINGO_REWARD = 100;
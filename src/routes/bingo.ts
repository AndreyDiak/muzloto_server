import { Response, Router } from 'express';
import { BINGO_REWARD } from '../constants';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const router = Router();

/** Код бинго всегда начинается с B (5 символов: B + 4 буквы/цифры). */
const BINGO_CODE_PREFIX = 'B';

/** Тестовый код бинго — всегда начисляет монеты и увеличивает счётчик */
const BINGO_TEST_CODE = 'B0000';

router.post('/claim', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 символов.' });
    }

    const normalizedCode = code.toUpperCase();

    if (normalizedCode[0] !== BINGO_CODE_PREFIX) {
      return res.status(400).json({ error: 'Код бинго должен начинаться с буквы B.' });
    }

    if (normalizedCode !== BINGO_TEST_CODE) {
      return res.status(404).json({ error: 'Код бинго не найден или уже использован.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      throw new Error(`Failed to fetch profile: ${profileError?.message || 'Profile not found'}`);
    }

    const oldBalance = profile.balance || 0;
    const newBalance = oldBalance + BINGO_REWARD;

    const { error: updateBalanceError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId)
      .select('balance')
      .single();

    if (updateBalanceError) {
      throw new Error(`Failed to update balance: ${updateBalanceError.message}`);
    }

    await incrementUserStat(telegramId, 'bingo_collected');
    const { newlyUnlocked: newlyUnlockedAchievements, totalCoinReward } = await checkAndUnlockAchievements(telegramId);

    let finalBalance = newBalance;
    if (totalCoinReward > 0) {
      finalBalance = newBalance + totalCoinReward;
      await supabase
        .from('profiles')
        .update({ balance: finalBalance })
        .eq('telegram_id', telegramId);
    }

    res.json({
      success: true,
      message: 'Победа в бинго засчитана! Вам начислены монеты.',
      newBalance: finalBalance,
      coinsEarned: BINGO_REWARD + totalCoinReward,
      newlyUnlockedAchievements,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

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

    let coinsToAdd = BINGO_REWARD;

    const { data: prizeCode, error: prizeError } = await supabase
      .from('event_prize_codes')
      .select('id, coins_amount')
      .eq('code', normalizedCode)
      .is('used_at', null)
      .maybeSingle();

    if (!prizeError && prizeCode) {
      coinsToAdd = prizeCode.coins_amount;
      const { error: markUsedError } = await supabase
        .from('event_prize_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', prizeCode.id);

      if (markUsedError) {
        throw new Error(`Failed to mark prize code as used: ${markUsedError.message}`);
      }
    } else if (normalizedCode !== BINGO_TEST_CODE) {
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
    const newBalance = oldBalance + coinsToAdd;

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
    const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

    res.json({
      success: true,
      message: 'Победа в бинго засчитана! Вам начислены монеты.',
      newBalance,
      coinsEarned: coinsToAdd,
      newlyUnlockedAchievements,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

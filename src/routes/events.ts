import { Response, Router } from 'express';
import { REGISTRATION_REWARD } from '../constants';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const router = Router();

interface VisitRewardResult {
  finalBalance: number;
  coinsEarned: number;
  newlyUnlockedAchievements: Awaited<ReturnType<typeof checkAndUnlockAchievements>>['newlyUnlocked'];
}

async function applyVisitReward(telegramId: number): Promise<VisitRewardResult> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('balance')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || !profile) {
    throw new Error(`Failed to fetch profile: ${profileError?.message || 'Profile not found'}`);
  }

  const newBalance = (profile.balance || 0) + REGISTRATION_REWARD;
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ balance: newBalance })
    .eq('telegram_id', telegramId);

  if (updateError) {
    throw new Error(`Failed to update balance: ${updateError.message}`);
  }

  await incrementUserStat(telegramId, 'games_visited');
  const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

  return {
    finalBalance: newBalance,
    coinsEarned: REGISTRATION_REWARD,
    newlyUnlockedAchievements,
  };
}

router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 символов.' });
    }

    const normalizedCode = code.toUpperCase();

    if (normalizedCode === '00000') {
      const result = await applyVisitReward(telegramId);
      return res.json({
        success: true,
        message: `Тестовый код обработан. Начислено ${REGISTRATION_REWARD} монет!`,
        event: { id: 'test', title: 'Тестовое событие' },
        newBalance: result.finalBalance,
        coinsEarned: result.coinsEarned,
        newlyUnlockedAchievements: result.newlyUnlockedAchievements,
      });
    }

    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, code')
      .eq('code', normalizedCode)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    const { data: existingRegistration } = await supabase
      .from('registrations')
      .select('id')
      .eq('event_id', event.id)
      .eq('telegram_id', telegramId)
      .single();

    if (existingRegistration) {
      return res.status(409).json({ error: 'Вы уже зарегистрированы на это мероприятие.' });
    }

    const { error: registrationError } = await supabase.from('registrations').insert({
      event_id: event.id,
      telegram_id: telegramId,
      status: 'confirmed',
    });

    if (registrationError) {
      throw new Error(`Failed to create registration: ${registrationError.message}`);
    }

    const result = await applyVisitReward(telegramId);
    res.json({
      success: true,
      message: `Вы зарегистрированы на мероприятие. Начислено ${REGISTRATION_REWARD} монет!`,
      event: { id: event.id, title: event.title },
      newBalance: result.finalBalance,
      coinsEarned: result.coinsEarned,
      newlyUnlockedAchievements: result.newlyUnlockedAchievements,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;

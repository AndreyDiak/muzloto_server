import { Response, Router } from 'express';
import { REGISTRATION_REWARD } from '../constants';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Код должен состоять из 5 символов.' });
    }

    const normalizedCode = code.toUpperCase();

    // Тестовый код - всегда начисляем монеты без проверок
    if (normalizedCode === '00000') {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('balance')
        .eq('telegram_id', telegramId)
        .single();

      if (profileError || !profile) {
        console.error('Failed to fetch profile:', profileError);
        throw new Error(`Failed to fetch profile: ${profileError?.message || 'Profile not found'}`);
      }

      const oldBalance = profile.balance || 0;
      const newBalance = oldBalance + REGISTRATION_REWARD;

      const { data: _updatedProfile, error: updateBalanceError } = await supabase
        .from('profiles')
        .update({ balance: newBalance })
        .eq('telegram_id', telegramId)
        .select('balance')
        .single();

      if (updateBalanceError) {
        throw new Error(`Failed to update balance: ${updateBalanceError.message}`);
      }

      return res.json({
        success: true,
        message: 'Test code processed. You received 10 coins!',
        event: {
          id: 'test',
          title: 'Тестовое событие',
        },
        newBalance,
        coinsEarned: REGISTRATION_REWARD,
      });
    }

    // Ищем мероприятие по коду
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, code')
      .eq('code', normalizedCode)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ error: 'Мероприятие не найдено.' });
    }

    // Проверяем, не зарегистрирован ли уже пользователь
    const { data: existingRegistration } = await supabase
      .from('registrations')
      .select('id')
      .eq('event_id', event.id)
      .eq('telegram_id', telegramId)
      .single();

    if (existingRegistration) {
      return res.status(409).json({ error: 'Вы уже зарегистрированы на это мероприятие.' });
    }

    // Создаем регистрацию
    const { error: registrationError } = await supabase
      .from('registrations')
      .insert({
        event_id: event.id,
        telegram_id: telegramId,
        status: 'confirmed',
      });

    if (registrationError) {
      throw new Error(`Failed to create registration: ${registrationError.message}`);
    }

    // Начисляем 10 монет
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      console.error('Failed to fetch profile:', profileError);
      throw new Error(`Failed to fetch profile: ${profileError?.message || 'Profile not found'}`);
    }

    const oldBalance = profile.balance || 0;
    const newBalance = oldBalance + REGISTRATION_REWARD;

    const { data: _updatedProfile, error: updateBalanceError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId)
      .select('balance')
      .single();

    if (updateBalanceError) {
      throw new Error(`Failed to update balance: ${updateBalanceError.message}`);
    }

    res.json({
      success: true,
      message: 'Successfully registered for event and received 10 coins!',
      event: {
        id: event.id,
        title: event.title,
      },
      newBalance,
      coinsEarned: REGISTRATION_REWARD
    });
  } catch (error: any) {
    console.error('Error processing event registration:', error);
    res.status(500).json({ error: error?.message || 'Internal server error' });
  }
});

export default router;

import { Router } from 'express';
import { verifyTelegramAuth, AuthRequest } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { Response } from 'express';

const router = Router();

router.post('/register', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body;
    const telegramId = req.telegramId!;

    if (!code || typeof code !== 'string' || code.length !== 5) {
      return res.status(400).json({ error: 'Invalid code format. Code must be 5 characters.' });
    }

    const normalizedCode = code.toUpperCase();

    console.log('Processing event registration:', { code: normalizedCode, telegramId });

    // Ищем мероприятие по коду
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('id, title, code')
      .eq('code', normalizedCode)
      .single();

    if (eventError || !event) {
      console.error('Event not found:', eventError);
      return res.status(404).json({ error: 'Event not found with this code.' });
    }

    console.log('Event found:', event.id, event.title);

    // Проверяем, не зарегистрирован ли уже пользователь
    const { data: existingRegistration } = await supabase
      .from('registrations')
      .select('id')
      .eq('event_id', event.id)
      .eq('telegram_id', telegramId)
      .single();

    if (existingRegistration) {
      console.log('User already registered');
      return res.status(409).json({ error: 'You are already registered for this event.' });
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
      console.error('Failed to create registration:', registrationError);
      throw new Error(`Failed to create registration: ${registrationError.message}`);
    }

    console.log('Registration created successfully');

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
    const newBalance = oldBalance + 10;

    console.log(`Updating balance for telegram_id ${telegramId}: ${oldBalance} -> ${newBalance}`);

    const { data: updatedProfile, error: updateBalanceError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId)
      .select('balance')
      .single();

    if (updateBalanceError) {
      console.error('Failed to update balance:', updateBalanceError);
      throw new Error(`Failed to update balance: ${updateBalanceError.message}`);
    }

    console.log(`Balance updated successfully. New balance: ${updatedProfile?.balance}`);

    res.json({
      success: true,
      message: 'Successfully registered for event and received 10 coins!',
      event: {
        id: event.id,
        title: event.title,
      },
      newBalance,
    });
  } catch (error: any) {
    console.error('Error processing event registration:', error);
    res.status(500).json({ error: error?.message || 'Internal server error' });
  }
});

export default router;

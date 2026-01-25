import { Response, Router } from 'express';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';
import crypto from 'crypto';

const router = Router();

// Хранилище токенов транзакций (в продакшене лучше использовать Redis)
const transactionTokens = new Map<string, { telegramId: number; amount: number; type: 'add' | 'subtract'; expiresAt: number }>();

// Генерация токена транзакции
router.post('/generate-token', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { amount, type } = req.body;
    const telegramId = req.telegramId!;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Неверная сумма. Сумма должна быть положительным числом.' });
    }

    if (!type || (type !== 'add' && type !== 'subtract')) {
      return res.status(400).json({ error: 'Неверный тип транзакции. Допустимые значения: add, subtract.' });
    }

    // Генерируем уникальный токен
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // Токен действителен 5 минут

    // Сохраняем токен
    transactionTokens.set(token, {
      telegramId,
      amount,
      type,
      expiresAt,
    });

    // Очищаем истекшие токены (простая очистка)
    const now = Date.now();
    for (const [key, value] of transactionTokens.entries()) {
      if (value.expiresAt < now) {
        transactionTokens.delete(key);
      }
    }

    return res.json({
      success: true,
      token,
      expiresAt,
      qrData: {
        type,
        amount,
        token,
        expiresAt,
      },
    });
  } catch (error) {
    console.error('Error generating transaction token:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Обработка транзакции по токену
router.post('/process', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { token } = req.body;
    const scannerTelegramId = req.telegramId!;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Токен обязателен.' });
    }

    // Получаем данные транзакции
    const transactionData = transactionTokens.get(token);

    if (!transactionData) {
      return res.status(404).json({ error: 'Токен не найден или истек.' });
    }

    if (transactionData.expiresAt < Date.now()) {
      transactionTokens.delete(token);
      return res.status(410).json({ error: 'Токен истек.' });
    }

    // Нельзя обработать свою собственную транзакцию
    if (transactionData.telegramId === scannerTelegramId) {
      return res.status(403).json({ error: 'Нельзя обработать свою собственную транзакцию.' });
    }

    const { telegramId: targetTelegramId, amount, type } = transactionData;

    // Получаем профиль целевого пользователя
    const { data: targetProfile, error: targetError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', targetTelegramId)
      .single();

    if (targetError || !targetProfile) {
      return res.status(404).json({ error: 'Профиль пользователя не найден.' });
    }

    const oldBalance = targetProfile.balance || 0;
    let newBalance: number;

    if (type === 'add') {
      newBalance = oldBalance + amount;
    } else {
      // subtract
      if (oldBalance < amount) {
        return res.status(400).json({ error: 'Недостаточно средств на балансе.' });
      }
      newBalance = oldBalance - amount;
    }

    // Обновляем баланс
    const { data: updatedProfile, error: updateError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', targetTelegramId)
      .select('balance')
      .single();

    if (updateError) {
      console.error('Failed to update balance:', updateError);
      return res.status(500).json({ error: 'Ошибка при обновлении баланса.' });
    }

    // Удаляем использованный токен
    transactionTokens.delete(token);

    return res.json({
      success: true,
      message: type === 'add' 
        ? `Начислено ${amount} монет пользователю` 
        : `Списано ${amount} монет у пользователя`,
      targetTelegramId,
      scannerTelegramId,
      amount,
      type,
      oldBalance,
      newBalance: updatedProfile.balance,
    });
  } catch (error) {
    console.error('Error processing transaction:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

export default router;

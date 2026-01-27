import { Request, Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';

export interface AuthRequest extends Request {
  telegramId?: number;
}

export async function verifyTelegramAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.substring(7);

  try {
    // Проверяем JWT токен через Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Извлекаем telegram_id из user_metadata
    const telegramId = user.user_metadata?.telegram_id;
    
    if (!telegramId) {
      return res.status(401).json({ error: 'Telegram ID not found in user metadata' });
    }

    req.telegramId = telegramId;
    next();
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

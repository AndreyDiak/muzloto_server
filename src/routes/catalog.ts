import { Response, Router } from 'express';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 5;

function generateTicketCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return s;
}

const router = Router();

router.post('/purchase', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { catalog_item_id } = req.body;
    const telegramId = req.telegramId!;

    if (!catalog_item_id || typeof catalog_item_id !== 'string') {
      return res.status(400).json({ error: 'Укажите товар (catalog_item_id).' });
    }

    const { data: item, error: itemError } = await supabase
      .from('catalog')
      .select('id, name, description, price, photo')
      .eq('id', catalog_item_id)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Товар не найден.' });
    }

    const price = Number(item.price);
    
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', telegramId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Профиль не найден.' });
    }

    const balance = Number(profile.balance) ?? 0;
    if (balance < price) {
      return res.status(400).json({ error: 'Недостаточно монет для покупки.' });
    }

    const newBalance = balance - price;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId);

    if (updateError) {
      throw new Error(`Не удалось списать монеты: ${updateError.message}`);
    }

    let code = generateTicketCode();
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { data: ticket, error: insertError } = await supabase
        .from('tickets')
        .insert({
          telegram_id: telegramId,
          catalog_item_id: item.id,
          code,
        })
        .select('id, code, created_at')
        .single();

      if (!insertError) {
        return res.json({
          success: true,
          message: 'Покупка оформлена. Сохраните код билета.',
          ticket: {
            id: ticket.id,
            code: ticket.code,
            created_at: ticket.created_at,
          },
          item: {
            id: item.id,
            name: item.name,
            description: item.description ?? null,
            price: item.price,
            photo: item.photo ?? null,
          },
          newBalance,
        });
      }

      if (insertError.code === '23505') {
        code = generateTicketCode();
        continue;
      }
      throw new Error(insertError.message);
    }

    throw new Error('Не удалось сгенерировать уникальный код билета.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка при покупке';
    res.status(500).json({ error: message });
  }
});

export default router;

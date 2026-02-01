import { Response, Router } from 'express';
import { getCatalogItemPrice } from '../config/rewards';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 5;

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  photo: string | null;
  created_at: string;
  updated_at: string;
}

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

/** Список каталога: данные из БД, цены из config/rewards (единый источник правды для цен). */
router.get('/', async (_req, res: Response) => {
  try {
    const { data: rows, error } = await supabase
      .from('catalog')
      .select('id, name, description, price, photo, created_at, updated_at')
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    const items = (rows ?? []).map((item: CatalogRow) => ({
      ...item,
      price: getCatalogItemPrice(item.id) ?? Number(item.price),
    }));

    res.json({ items });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Ошибка при загрузке каталога';
    res.status(500).json({ error: message });
  }
});

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

    const price = getCatalogItemPrice(catalog_item_id) ?? Number(item.price);
    
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
        await incrementUserStat(telegramId, 'tickets_purchased');
        const { newlyUnlocked: newlyUnlockedAchievements, totalCoinReward } = await checkAndUnlockAchievements(telegramId);

        let finalBalance = newBalance;
        if (totalCoinReward > 0) {
          finalBalance = newBalance + totalCoinReward;
          await supabase
            .from('profiles')
            .update({ balance: finalBalance })
            .eq('telegram_id', telegramId);
        }

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
            price,
            photo: item.photo ?? null,
          },
          newBalance: finalBalance,
          newlyUnlockedAchievements,
          achievementCoinsEarned: totalCoinReward > 0 ? totalCoinReward : undefined,
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

import { NextFunction, Response, Router } from 'express';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

function requireRoot(req: AuthRequest, res: Response, next: NextFunction) {
  (async () => {
    try {
      const telegramId = req.telegramId!;
      const { data } = await supabase
        .from('root_user_tags')
        .select('telegram_id')
        .eq('telegram_id', telegramId)
        .maybeSingle();
      if (!data) {
        res.status(403).json({ error: 'Доступ только для мастер-аккаунтов.' });
        return;
      }
      next();
    } catch (e) {
      next(e);
    }
  })();
}

router.post('/scan', verifyTelegramAuth, requireRoot, async (req: AuthRequest, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    const codeStr = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (codeStr.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода билета (ожидается 5 символов).' });
    }

    const { data: ticket, error: ticketError } = await supabase
      .from('tickets')
      .select('id, telegram_id, catalog_item_id, code, used_at')
      .eq('code', codeStr)
      .single();

    if (ticketError || !ticket) {
      return res.status(404).json({ error: 'Билет не найден.' });
    }

    if (ticket.used_at) {
      return res.status(400).json({ error: 'Билет уже использован.' });
    }

    const [{ data: profile, error: profileError }, { data: item, error: itemError }] = await Promise.all([
      supabase.from('profiles').select('telegram_id, username, first_name, last_name').eq('telegram_id', ticket.telegram_id).single(),
      supabase.from('catalog').select('id, name, description, price, photo').eq('id', ticket.catalog_item_id).single(),
    ]);

    if (profileError || !profile) {
      return res.status(500).json({ error: 'Не удалось загрузить данные участника.' });
    }
    if (itemError || !item) {
      return res.status(500).json({ error: 'Не удалось загрузить данные предмета.' });
    }

    const { error: updateError } = await supabase
      .from('tickets')
      .update({ used_at: new Date().toISOString() })
      .eq('id', ticket.id);

    if (updateError) {
      return res.status(500).json({ error: 'Не удалось отметить билет как использованный.' });
    }

    return res.json({
      success: true,
      participant: {
        telegram_id: profile.telegram_id,
        username: profile.username ?? null,
        first_name: profile.first_name ?? null,
        last_name: profile.last_name ?? null,
      },
      item: {
        id: item.id,
        name: item.name,
        description: item.description ?? null,
        price: item.price,
        photo: item.photo ?? null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка при сканировании';
    res.status(500).json({ error: message });
  }
});

export default router;

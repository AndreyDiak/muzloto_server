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

    // Supabase возвращает bigint как строку; для запроса к profiles используем строку, чтобы не терять точность
    const ownerId = ticket.telegram_id != null ? String(ticket.telegram_id) : null;
    const [{ data: profile, error: profileError }, { data: item, error: itemError }] = await Promise.all([
      supabase.from('profiles').select('telegram_id, username, first_name, avatar_url').eq('telegram_id', ownerId).single(),
      supabase.from('catalog').select('id, name, description, price, photo').eq('id', ticket.catalog_item_id).single(),
    ]);

    if (profileError || !profile) {
      const details = profileError?.message;
      return res.status(500).json({
        error: 'Не удалось загрузить данные участника.',
        ...(details && { details }),
      });
    }
    if (itemError || !item) {
      const details = itemError?.message;
      return res.status(500).json({
        error: 'Не удалось загрузить данные предмета.',
        ...(details && { details }),
      });
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
        avatar_url: profile.avatar_url ?? null,
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

// Отсканированные билеты за последние 24 ч (для раздела «Сканер»)
const MS_24H = 24 * 60 * 60 * 1000;

router.get('/recent', verifyTelegramAuth, requireRoot, async (_req: AuthRequest, res: Response) => {
  try {
    const since = new Date(Date.now() - MS_24H).toISOString();
    const { data: tickets, error: ticketsError } = await supabase
      .from('tickets')
      .select('id, code, used_at, telegram_id, catalog_item_id')
      .not('used_at', 'is', null)
      .gte('used_at', since)
      .order('used_at', { ascending: false });

    if (ticketsError || !tickets?.length) {
      return res.json({ items: [] });
    }

    const ownerIds = [...new Set(tickets.map((t) => String(t.telegram_id)))];
    const catalogIds = [...new Set(tickets.map((t) => t.catalog_item_id))];

    const [profilesRes, catalogRes] = await Promise.all([
      supabase.from('profiles').select('telegram_id, username, first_name, avatar_url').in('telegram_id', ownerIds),
      supabase.from('catalog').select('id, name, description, price, photo').in('id', catalogIds),
    ]);

    const profileByTgId = new Map<string, { telegram_id: unknown; username: string | null; first_name: string | null; avatar_url: string | null }>();
    (profilesRes.data ?? []).forEach((p) => profileByTgId.set(String(p.telegram_id), p));
    type CatalogRow = { id: string; name: string; description: string | null; price: number; photo: string | null };
    const itemById = new Map<string, CatalogRow>();
    ((catalogRes.data ?? []) as CatalogRow[]).forEach((i) => itemById.set(i.id, i));

    const items = tickets.map((t) => {
      const profile = profileByTgId.get(String(t.telegram_id));
      const catalogRow = itemById.get(t.catalog_item_id);
      return {
        id: t.id,
        used_at: t.used_at,
        code: t.code,
        participant: profile
          ? { telegram_id: profile.telegram_id, username: profile.username ?? null, first_name: profile.first_name ?? null, avatar_url: profile.avatar_url ?? null }
          : null,
        item: catalogRow ? { id: catalogRow.id, name: catalogRow.name, description: catalogRow.description ?? null, price: catalogRow.price, photo: catalogRow.photo ?? null } : null,
      };
    });

    return res.json({ items });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка при загрузке';
    res.status(500).json({ error: message });
  }
});

export default router;

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

/** Из тела запроса извлекает 5-символьный код: голый код, "shop-XXXXX" или URL с ?start=shop-XXXXX / ?startapp=shop-XXXXX */
function normalizeCodeFromRequest(raw: unknown): string | null {
  const t = typeof raw === 'string' ? raw.trim() : '';
  if (!t) return null;
  const upper = t.toUpperCase();
  if (upper.length === 5 && /^[A-Z0-9]+$/.test(upper)) return upper;
  if (t.length >= 10 && /^SHOP-[A-Z0-9]{5}$/i.test(t.slice(0, 10))) return t.slice(5, 10).toUpperCase();
  try {
    const url = new URL(t);
    const start = url.searchParams.get('start') ?? url.searchParams.get('startapp') ?? '';
    const startTrim = start.trim();
    if (startTrim.length >= 10 && /^SHOP-[A-Z0-9]{5}$/i.test(startTrim.slice(0, 10))) return startTrim.slice(5, 10).toUpperCase();
    if (startTrim.length === 5 && /^[A-Z0-9]+$/.test(startTrim)) return startTrim.toUpperCase();
  } catch {
    // not a URL
  }
  return null;
}

router.post('/scan', verifyTelegramAuth, requireRoot, async (req: AuthRequest, res: Response) => {
  try {
    const codeStr = normalizeCodeFromRequest(req.body?.code);
    if (!codeStr || codeStr.length !== 5) {
      return res.status(400).json({ error: 'Неверный формат кода. Отсканируйте QR из приложения или введите 5 символов.' });
    }

    const { data: row, error: fetchError } = await supabase
      .from('codes')
      .select('id, type, catalog_item_id, owner_telegram_id, used_at')
      .eq('code', codeStr)
      .maybeSingle();

    if (fetchError || !row || !row.catalog_item_id) {
      return res.status(404).json({ error: 'Код не найден.' });
    }

    const ownerId = row.owner_telegram_id != null ? String(row.owner_telegram_id) : null;

    if (row.type === 'purchase' && row.used_at == null && ownerId) {
      const [{ data: profile, error: profileError }, { data: item, error: itemError }] = await Promise.all([
        supabase.from('profiles').select('telegram_id, username, first_name, avatar_url').eq('telegram_id', ownerId).single(),
        supabase.from('catalog').select('id, name, description, price, photo').eq('id', row.catalog_item_id).single(),
      ]);
      if (profileError || !profile) {
        return res.status(500).json({ error: 'Не удалось загрузить данные участника.' });
      }
      if (itemError || !item) {
        return res.status(500).json({ error: 'Не удалось загрузить данные предмета.' });
      }
      const { error: updateError } = await supabase
        .from('codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', row.id);
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
    }

    if (row.type === 'purchase') {
      if (!row.used_at || !ownerId) {
        return res.status(400).json({
          error: 'Код покупки ещё не погашен. Попросите покупателя оформить покупку в приложении.',
        });
      }
      const [{ data: profile, error: profileError }, { data: item, error: itemError }] = await Promise.all([
        supabase.from('profiles').select('telegram_id, username, first_name, avatar_url').eq('telegram_id', ownerId).single(),
        supabase.from('catalog').select('id, name, description, price, photo').eq('id', row.catalog_item_id).single(),
      ]);
      if (profileError || !profile) {
        return res.status(500).json({ error: 'Не удалось загрузить данные покупателя.' });
      }
      if (itemError || !item) {
        return res.status(500).json({ error: 'Не удалось загрузить данные товара.' });
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
    }

    return res.status(404).json({ error: 'Код не найден.' });
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
    const { data: rows, error: fetchError } = await supabase
      .from('codes')
      .select('id, code, used_at, owner_telegram_id, catalog_item_id')
      .not('used_at', 'is', null)
      .gte('used_at', since)
      .order('used_at', { ascending: false });

    if (fetchError || !rows?.length) {
      return res.json({ items: [] });
    }

    const ownerIds = [...new Set(rows.map((r) => String(r.owner_telegram_id)).filter(Boolean))];
    const catalogIds = [...new Set(rows.map((r) => r.catalog_item_id).filter(Boolean))];

    const [profilesRes, catalogRes] = await Promise.all([
      ownerIds.length ? supabase.from('profiles').select('telegram_id, username, first_name, avatar_url').in('telegram_id', ownerIds) : { data: [] },
      catalogIds.length ? supabase.from('catalog').select('id, name, description, price, photo').in('id', catalogIds) : { data: [] },
    ]);

    const profileByTgId = new Map<string, { telegram_id: unknown; username: string | null; first_name: string | null; avatar_url: string | null }>();
    (profilesRes.data ?? []).forEach((p) => profileByTgId.set(String(p.telegram_id), p));
    type CatalogRow = { id: string; name: string; description: string | null; price: number; photo: string | null };
    const itemById = new Map<string, CatalogRow>();
    ((catalogRes.data ?? []) as CatalogRow[]).forEach((i) => itemById.set(i.id, i));

    const items = rows.map((r) => {
      const ownerId = r.owner_telegram_id != null ? String(r.owner_telegram_id) : null;
      const profile = ownerId ? profileByTgId.get(ownerId) : null;
      const catalogRow = r.catalog_item_id ? itemById.get(r.catalog_item_id) : null;
      return {
        id: r.id,
        used_at: r.used_at,
        code: r.code,
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

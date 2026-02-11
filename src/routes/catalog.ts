import { Response, Router } from 'express';
import { getCatalogItemPrice } from '../config/rewards';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { supabase } from '../services/supabase';
import { incrementUserStat } from '../services/user-stats';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 5;
const PURCHASE_CODE_PREFIX = 'C';
const PURCHASE_CODE_RANDOM_LENGTH = 5;

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

function generatePurchaseCode(): string {
  const bytes = new Uint8Array(PURCHASE_CODE_RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let s = PURCHASE_CODE_PREFIX;
  for (let i = 0; i < PURCHASE_CODE_RANDOM_LENGTH; i++) {
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
      .order('price', { ascending: true });

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
        const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

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
          newBalance,
          newlyUnlockedAchievements,
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

/** POST /api/catalog/generate-purchase-code — сгенерировать код покупки товара (только мастер). */
router.post(
  '/generate-purchase-code',
  verifyTelegramAuth,
  requireRoot,
  async (req: AuthRequest, res: Response) => {
    try {
      const { catalog_item_id } = req.body;
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

      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const code = generatePurchaseCode();
        const { data: row, error: insertError } = await supabase
          .from('catalog_purchase_codes')
          .insert({ code, catalog_item_id: item.id })
          .select('id, code, created_at')
          .single();

        if (!insertError) {
          const price = getCatalogItemPrice(item.id) ?? Number(item.price);
          return res.json({
            success: true,
            code: row.code,
            item: {
              id: item.id,
              name: item.name,
              description: item.description ?? null,
              price,
              photo: item.photo ?? null,
            },
          });
        }
        if (insertError.code === '23505') continue;
        throw new Error(insertError.message);
      }
      throw new Error('Не удалось сгенерировать уникальный код.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Ошибка генерации кода';
      res.status(500).json({ error: message });
    }
  }
);

function normalizePurchaseCode(input: string): string | null {
  const t = (input ?? '').trim().toUpperCase();
  if (t.length === 6 && t[0] === 'C' && /^[A-Z0-9]+$/.test(t)) return t;
  if (t.length === 5 && /^[A-Z0-9]+$/.test(t)) return 'C' + t;
  return null;
}

/** POST /api/catalog/redeem-purchase-code — погасить код покупки: списать баланс, выдать билет. */
router.post('/redeem-purchase-code', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code: rawCode } = req.body;
    const telegramId = req.telegramId!;

    const code = normalizePurchaseCode(rawCode);
    if (!code) {
      return res.status(400).json({ error: 'Неверный формат кода покупки.' });
    }

    const { data: purchaseRow, error: fetchError } = await supabase
      .from('catalog_purchase_codes')
      .select('id, catalog_item_id, used_at')
      .eq('code', code)
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!purchaseRow) {
      return res.status(404).json({ error: 'Код не найден.' });
    }
    if (purchaseRow.used_at) {
      return res.status(400).json({ error: 'Код уже использован.' });
    }

    const { data: item, error: itemError } = await supabase
      .from('catalog')
      .select('id, name, description, price, photo')
      .eq('id', purchaseRow.catalog_item_id)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Товар каталога не найден.' });
    }

    const price = getCatalogItemPrice(item.id) ?? Number(item.price);

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

    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId);
    if (updateProfileError) throw new Error(updateProfileError.message);

    let ticketCode = generateTicketCode();
    const ticketMaxAttempts = 10;
    for (let tAttempt = 0; tAttempt < ticketMaxAttempts; tAttempt++) {
      const { data: ticket, error: ticketError } = await supabase
        .from('tickets')
        .insert({
          telegram_id: telegramId,
          catalog_item_id: item.id,
          code: ticketCode,
        })
        .select('id, code, created_at')
        .single();

      if (!ticketError) {
        const { error: markUsedError } = await supabase
          .from('catalog_purchase_codes')
          .update({ used_at: new Date().toISOString(), used_by_telegram_id: telegramId })
          .eq('id', purchaseRow.id);
        if (markUsedError) throw new Error(markUsedError.message);

        await incrementUserStat(telegramId, 'tickets_purchased');
        const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);

        return res.json({
          success: true,
          message: 'Покупка по коду оформлена.',
          ticket: { id: ticket.id, code: ticket.code, created_at: ticket.created_at },
          item: {
            id: item.id,
            name: item.name,
            description: item.description ?? null,
            price,
            photo: item.photo ?? null,
          },
          newBalance,
          newlyUnlockedAchievements,
        });
      }
      if (ticketError.code === '23505') {
        ticketCode = generateTicketCode();
        continue;
      }
      throw new Error(ticketError.message);
    }

    throw new Error('Не удалось создать билет.');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка погашения кода';
    res.status(500).json({ error: message });
  }
});

export default router;

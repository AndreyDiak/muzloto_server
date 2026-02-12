import { Response, Router } from 'express';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { checkAndUnlockAchievements } from '../services/achievements';
import { incrementUserStat } from '../services/user-stats';
import { supabase } from '../services/supabase';
import { sendTelegramMessage, escapeHtml } from '../services/telegram';

const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PURCHASE_CODE_LENGTH = 5;

interface CatalogRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  photo: string | null;
  created_at: string;
  updated_at: string;
}

function generatePurchaseCode(): string {
  const bytes = new Uint8Array(PURCHASE_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < PURCHASE_CODE_LENGTH; i++) {
    s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return s;
}

const router = Router();

/** Список каталога: данные и цены из БД. */
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
      price: Number(item.price),
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

    await incrementUserStat(telegramId, 'tickets_purchased');
    const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);
    // Награды за достижения (1, 3, 5 покупок) пользователь забирает кнопкой в разделе «Награды»
    let messageText = `✅ Покупка оформлена!\n\n` +
      `Товар: <b>${escapeHtml(item.name)}</b>\n` +
      `Цена: ${price} монет\n` +
      `Остаток монет: ${newBalance}`;
    messageText += `\n\n💡 Заберите награду за достижения в разделе «Награды» в приложении.`;
    await sendTelegramMessage(telegramId, messageText);

    return res.json({
      success: true,
      message: 'Покупка оформлена.',
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка при покупке';
    res.status(500).json({ error: message });
  }
});

/** GET /api/catalog/active-purchase-codes — список неиспользованных кодов (только мастер). */
router.get(
  '/active-purchase-codes',
  verifyTelegramAuth,
  requireRoot,
  async (_req: AuthRequest, res: Response) => {
    try {
      const { data: rows, error } = await supabase
        .from('codes')
        .select('code, catalog_item_id, created_at, catalog(name)')
        .eq('type', 'purchase')
        .is('used_at', null)
        .order('created_at', { ascending: false });

      if (error) throw new Error(error.message);

      const codes = (rows ?? []).map((r: { code: string; catalog_item_id: string; created_at: string; catalog: { name: string } | { name: string }[] | null }) => {
        const catalog = Array.isArray(r.catalog) ? r.catalog[0] : r.catalog;
        return {
          code: r.code,
          catalog_item_id: r.catalog_item_id,
          item_name: catalog?.name ?? '—',
          created_at: r.created_at,
        };
      });

      res.json({ codes });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Ошибка загрузки кодов';
      res.status(500).json({ error: message });
    }
  }
);

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

      const telegramId = req.telegramId!;
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const code = generatePurchaseCode();
        const { data: row, error: insertError } = await supabase
          .from('codes')
          .insert({
            code,
            type: 'purchase',
            catalog_item_id: item.id,
            created_by_telegram_id: telegramId,
          })
          .select('id, code, created_at')
          .single();

        if (!insertError) {
          const price = Number(item.price);
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
  if (t.length === 5 && /^[A-Z0-9]+$/.test(t)) return t;
  return null;
}

/** GET /api/catalog/preview-purchase-code?code=XXX — данные для подтверждения покупки (товар, цена, баланс), без списания */
router.get('/preview-purchase-code', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const code = normalizePurchaseCode(String(req.query.code ?? ''));
    if (!code) {
      return res.status(400).json({ error: 'Неверный формат кода покупки.' });
    }

    const { data: purchaseRow, error: fetchError } = await supabase
      .from('codes')
      .select('id, catalog_item_id, used_at')
      .eq('code', code)
      .eq('type', 'purchase')
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!purchaseRow || !purchaseRow.catalog_item_id) {
      return res.status(404).json({ error: 'Код не найден.' });
    }
    if (purchaseRow.used_at) {
      return res.status(400).json({ error: 'Код уже использован.' });
    }

    const { data: item, error: itemError } = await supabase
      .from('catalog')
      .select('id, name, price')
      .eq('id', purchaseRow.catalog_item_id)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Товар не найден.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('balance')
      .eq('telegram_id', req.telegramId!)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Профиль не найден.' });
    }

    const balance = Number(profile.balance) ?? 0;
    const price = Number(item.price);

    return res.json({
      item: { id: item.id, name: item.name, price },
      balance,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка при загрузке данных';
    res.status(500).json({ error: message });
  }
});

/** POST /api/catalog/redeem-purchase-code — погасить код покупки: списать баланс, сообщение в ЛС. Без билетов. */
router.post('/redeem-purchase-code', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { code: rawCode } = req.body;
    const telegramId = req.telegramId!;

    const code = normalizePurchaseCode(rawCode);
    if (!code) {
      return res.status(400).json({ error: 'Неверный формат кода покупки.' });
    }

    const { data: purchaseRow, error: fetchError } = await supabase
      .from('codes')
      .select('id, catalog_item_id, used_at')
      .eq('code', code)
      .eq('type', 'purchase')
      .maybeSingle();

    if (fetchError) throw new Error(fetchError.message);
    if (!purchaseRow || !purchaseRow.catalog_item_id) {
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

    const { error: updateProfileError } = await supabase
      .from('profiles')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId);
    if (updateProfileError) throw new Error(updateProfileError.message);

    const { error: markUsedError } = await supabase
      .from('codes')
      .update({ used_at: new Date().toISOString(), owner_telegram_id: telegramId })
      .eq('id', purchaseRow.id);
    if (markUsedError) throw new Error(markUsedError.message);

    await incrementUserStat(telegramId, 'tickets_purchased');
    const { newlyUnlocked: newlyUnlockedAchievements } = await checkAndUnlockAchievements(telegramId);
    // Награды за достижения пользователь забирает кнопкой в разделе «Награды»
    let messageText =
      '✅ Покупка по коду оформлена!\n\n' +
      `Товар: <b>${escapeHtml(item.name)}</b>\n` +
      `Цена: ${price} монет\n` +
      `Остаток монет: ${newBalance}`;
    messageText += `\n\n💡 Заберите награду за достижения в разделе «Награды» в приложении.`;
    await sendTelegramMessage(telegramId, messageText);

    return res.json({
      success: true,
      message: 'Покупка по коду оформлена.',
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Ошибка погашения кода';
    res.status(500).json({ error: message });
  }
});

export default router;

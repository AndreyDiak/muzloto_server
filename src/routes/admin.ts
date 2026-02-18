import { Response, Router } from 'express';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const CATALOG_PHOTOS_BUCKET = 'catalog-photos';
const EVENT_PHOTOS_BUCKET = 'event-photos';
const OUR_BUCKETS = new Set([CATALOG_PHOTOS_BUCKET, EVENT_PHOTOS_BUCKET]);

/**
 * Удаляет файл из storage по публичному URL (бакет и путь извлекаются из URL).
 * Формат URL: .../object/public/<bucket>/<path>
 * Поддерживает event-photos и catalog-photos.
 */
async function removeStorageFileByUrl(publicUrl: string | null): Promise<void> {
  if (!publicUrl || typeof publicUrl !== 'string') return;
  const trimmed = publicUrl.trim();
  const prefix = '/object/public/';
  const idx = trimmed.indexOf(prefix);
  if (idx === -1) return;
  const after = trimmed.slice(idx + prefix.length).split('?')[0];
  const slash = after.indexOf('/');
  if (slash === -1) return;
  const urlBucket = after.slice(0, slash);
  const path = after.slice(slash + 1);
  if (!path || !OUR_BUCKETS.has(urlBucket)) return;
  await supabase.storage.from(urlBucket).remove([path]);
}

const router = Router();

/** Все роуты админки требуют авторизацию и root */
router.use(verifyTelegramAuth);
router.use(requireRoot);

/** Код мероприятия: только 5 цифр (10000–99999) */
function generateEventCode(): string {
  const n = Math.floor(10000 + Math.random() * 90000);
  return String(n);
}

function isFiveDigits(s: unknown): s is string {
  return typeof s === 'string' && /^\d{5}$/.test(s);
}

/** GET /api/admin/events — список мероприятий (код берётся из codes) */
router.get('/events', async (_req: AuthRequest, res: Response) => {
  try {
    const { data: events, error } = await supabase
      .from('events')
      .select('id, title, description, event_date, location, location_href, price, max_participants, created_at')
      .order('event_date', { ascending: false });

    if (error) throw new Error(error.message);
    const list = events ?? [];
    if (list.length === 0) {
      res.json({ events: [] });
      return;
    }
    const eventIds = list.map((e: { id: string }) => e.id);
    const { data: codeRows } = await supabase
      .from('codes')
      .select('event_id, code')
      .eq('type', 'registration')
      .in('event_id', eventIds);
    const codeByEventId = new Map(
      (codeRows ?? [])
        .filter((r: { code: unknown }) => isFiveDigits(r.code))
        .map((r: { event_id: string; code: string }) => [r.event_id, r.code])
    );
    const eventsWithCode = list.map((e: Record<string, unknown> & { id: string }) => ({
      ...e,
      code: codeByEventId.get(e.id) ?? null,
    }));
    res.json({ events: eventsWithCode });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка загрузки';
    res.status(500).json({ error: message });
  }
});

/** POST /api/admin/events — создать мероприятие */
router.post('/events', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as {
      title?: string;
      description?: string;
      event_date?: string;
      location?: string;
      location_href?: string;
      price?: number;
      max_participants?: number;
    };

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return res.status(400).json({ error: 'Укажите название мероприятия.' });
    }

    const eventDate = body.event_date && typeof body.event_date === 'string' ? body.event_date : new Date().toISOString();
    // Код хранится только в таблице codes; уникальность по codes
    let code = generateEventCode();
    for (let attempt = 0; attempt < 30; attempt++) {
      const { data: existing } = await supabase.from('codes').select('id').eq('code', code).maybeSingle();
      if (!existing) break;
      code = generateEventCode();
    }

    const { data: inserted, error } = await supabase
      .from('events')
      .insert({
        title,
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        event_date: eventDate,
        location: typeof body.location === 'string' ? body.location.trim() || null : null,
        location_href: typeof body.location_href === 'string' ? body.location_href.trim() || null : null,
        price: typeof body.price === 'number' && body.price >= 0 ? body.price : 0,
        max_participants: typeof body.max_participants === 'number' && body.max_participants > 0 ? body.max_participants : null,
      })
      .select('id, title, event_date, created_at')
      .single();

    if (error) throw new Error(error.message);
    await supabase.from('codes').insert({
      code,
      type: 'registration',
      event_id: inserted.id,
    }).then((r) => { if (r.error && r.error.code !== '23505') throw new Error(r.error.message); });
    res.status(201).json({
      id: inserted.id,
      title: inserted.title,
      event_date: inserted.event_date,
      created_at: inserted.created_at,
      code,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка создания';
    res.status(500).json({ error: message });
  }
});

/** DELETE /api/admin/events/:id — удалить связанные данные, обложку из storage и мероприятие */
router.delete('/events/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { data: event } = await supabase
      .from('events')
      .select('location_href')
      .eq('id', id)
      .maybeSingle();
    if (event?.location_href) {
      await removeStorageFileByUrl(event.location_href);
    }
    // Удаляем связанные записи (порядок важен из-за внешних ключей)
    await supabase.from('event_raffle_winners').delete().eq('event_id', id);
    await supabase.from('registrations').delete().eq('event_id', id);
    await supabase.from('codes').delete().eq('event_id', id).eq('type', 'registration');
    const { error } = await supabase.from('events').delete().eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка удаления';
    res.status(500).json({ error: message });
  }
});

/** GET /api/admin/profiles — список профилей (для выбора получателей рассылки анонса) */
router.get('/profiles', async (_req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('telegram_id, first_name, username')
      .order('telegram_id', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ profiles: data ?? [] });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка загрузки';
    res.status(500).json({ error: message });
  }
});

/** GET /api/admin/catalog — список каталога */
router.get('/catalog', async (_req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('catalog')
      .select('id, name, description, price, photo, created_at')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ items: data ?? [] });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка загрузки';
    res.status(500).json({ error: message });
  }
});

/** POST /api/admin/catalog — создать позицию каталога */
router.post('/catalog', async (req: AuthRequest, res: Response) => {
  try {
    const body = req.body as { name?: string; description?: string; price?: number; photo?: string };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return res.status(400).json({ error: 'Укажите название.' });
    }

    const price = typeof body.price === 'number' && body.price >= 0 ? body.price : 0;

    const { data: inserted, error } = await supabase
      .from('catalog')
      .insert({
        name,
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        price,
        photo: typeof body.photo === 'string' ? body.photo.trim() || null : null,
      })
      .select('id, name, price, created_at')
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(inserted);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка создания';
    res.status(500).json({ error: message });
  }
});

/** DELETE /api/admin/catalog/:id — удалить позицию каталога и фото из storage */
router.delete('/catalog/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { data: item } = await supabase
      .from('catalog')
      .select('photo')
      .eq('id', id)
      .maybeSingle();
    if (item?.photo) {
      await removeStorageFileByUrl(item.photo);
    }
    const { error } = await supabase.from('catalog').delete().eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка удаления';
    res.status(500).json({ error: message });
  }
});

export default router;

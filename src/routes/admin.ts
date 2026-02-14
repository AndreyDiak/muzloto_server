import { Response, Router } from 'express';
import { AuthRequest, requireRoot, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

/** Все роуты админки требуют авторизацию и root */
router.use(verifyTelegramAuth);
router.use(requireRoot);

/** Код мероприятия: 5 цифр (10000–99999) */
function generateEventCode(): string {
  const n = Math.floor(10000 + Math.random() * 90000);
  return String(n);
}

/** GET /api/admin/events — список мероприятий */
router.get('/events', async (_req: AuthRequest, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('events')
      .select('id, title, description, event_date, location, location_href, price, max_participants, code, created_at')
      .order('event_date', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ events: data ?? [] });
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
    let code = generateEventCode();
    for (let attempt = 0; attempt < 30; attempt++) {
      const { data: existing } = await supabase.from('events').select('id').eq('code', code).maybeSingle();
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
        code,
      })
      .select('id, title, code, event_date, created_at')
      .single();

    if (error) throw new Error(error.message);
    await supabase.from('codes').insert({
      code,
      type: 'registration',
      event_id: inserted.id,
    }).then((r) => { if (r.error && r.error.code !== '23505') throw new Error(r.error.message); });
    res.status(201).json(inserted);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка создания';
    res.status(500).json({ error: message });
  }
});

/** DELETE /api/admin/events/:id — удалить мероприятие */
router.delete('/events/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('events').delete().eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка удаления';
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

/** DELETE /api/admin/catalog/:id — удалить позицию каталога */
router.delete('/catalog/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('catalog').delete().eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка удаления';
    res.status(500).json({ error: message });
  }
});

export default router;

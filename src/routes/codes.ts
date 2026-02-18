import { Response, Router } from 'express';
import { AuthRequest, verifyTelegramAuth } from '../middleware/auth';
import { supabase } from '../services/supabase';

const router = Router();

function normalizeCode(raw: unknown): string | null {
  const t = typeof raw === 'string' ? raw.trim().replace(/\D/g, '') : '';
  return t.length === 5 ? t : null;
}

/** GET /api/codes/lookup?code=12345 — тип кода по таблице codes (registration | purchase). Для 5 цифр без префикса. */
router.get('/lookup', verifyTelegramAuth, async (req: AuthRequest, res: Response) => {
  try {
    const code = normalizeCode(req.query.code);
    if (!code) {
      return res.status(400).json({ error: 'Укажите код из 5 цифр.' });
    }

    const { data: row, error } = await supabase
      .from('codes')
      .select('type')
      .eq('code', code)
      .in('type', ['registration', 'purchase'])
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) {
      return res.status(404).json({ error: 'Код не найден или уже использован.' });
    }

    res.json({ type: row.type as 'registration' | 'purchase' });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Ошибка';
    res.status(500).json({ error: message });
  }
});

export default router;

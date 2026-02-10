/**
 * Точка входа для Vercel Serverless.
 * Все запросы (в т.ч. /api/telegram/webhook) обрабатываются одним Express-приложением.
 */
import app from '../src/index';
export default app;

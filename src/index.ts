import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import adminRouter from './routes/admin';
import achievementsRouter from './routes/achievements';
import catalogRouter from './routes/catalog';
import eventsRouter from './routes/events';
import scannerRouter from './routes/scanner';
import telegramWebhookRouter from './routes/telegram-webhook';

// На Vercel переменные задаются в настройках проекта, файла .env нет
if (process.env.VERCEL !== '1') {
  const envPath = path.resolve(__dirname, '../.env');
  const result = dotenv.config({ path: envPath });
  const err = result.error as NodeJS.ErrnoException | undefined;
  if (err && err.code !== 'ENOENT') {
    console.error('Failed to load .env file:', err.message);
  }
  if (err?.code === 'ENOENT') {
    dotenv.config(); // fallback: из process.cwd()
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// CORS настройки
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());


// Роуты
app.use('/api/admin', adminRouter);
app.use('/api/achievements', achievementsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/events', eventsRouter);
app.use('/api/scanner', scannerRouter);
app.use('/api/telegram', telegramWebhookRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// На Vercel приложение отдаётся как serverless-функция из api/index.ts
if (process.env.VERCEL !== '1') {
  app.listen(PORT);
}

export default app;

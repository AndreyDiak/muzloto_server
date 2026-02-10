import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import adminRouter from './routes/admin';
import achievementsRouter from './routes/achievements';
import bingoRouter from './routes/bingo';
import catalogRouter from './routes/catalog';
import eventsRouter from './routes/events';
import scannerRouter from './routes/scanner';
import telegramWebhookRouter from './routes/telegram-webhook';

// Загружаем переменные окружения
const envPath = path.resolve(__dirname, '../.env');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.error('Failed to load .env file:', result.error.message);
  // Пробуем загрузить из process.cwd()
  dotenv.config();
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
app.use('/api/bingo', bingoRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/events', eventsRouter);
app.use('/api/scanner', scannerRouter);
app.use('/api/telegram', telegramWebhookRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT);

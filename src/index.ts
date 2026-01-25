import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import eventsRouter from './routes/events';
import path from 'path';
import fs from 'fs';

// Загружаем переменные окружения
// Пробуем несколько путей для надежности
console.log('🔍 Loading .env file...');
console.log('Current working directory:', process.cwd());
console.log('__dirname:', __dirname);

const possiblePaths = [
  path.resolve(process.cwd(), '.env'),        // Из текущей рабочей директории
  path.resolve(__dirname, '../.env'),        // Относительно __dirname
  path.join(process.cwd(), '.env'),          // Альтернативный способ
];

let loaded = false;
for (const envPath of possiblePaths) {
  if (fs.existsSync(envPath)) {
    console.log(`✅ Found .env at: ${envPath}`);
    const result = dotenv.config({ path: envPath });
    if (!result.error) {
      console.log('✅ .env file loaded successfully');
      loaded = true;
      break;
    } else {
      console.error(`❌ Error loading from ${envPath}:`, result.error.message);
    }
  }
}

// Если не загрузили из явного пути, пробуем dotenv.config() без пути
// (он ищет в process.cwd())
if (!loaded) {
  console.log('⚠️  Trying to load .env from process.cwd() without explicit path...');
  const result = dotenv.config();
  if (result.error) {
    console.error('❌ Failed to load .env file:', result.error.message);
  } else {
    console.log('✅ .env loaded from default location');
    loaded = true;
  }
}

// Отладочный вывод
console.log('Environment variables check:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL ? `✓ (${process.env.SUPABASE_URL.substring(0, 30)}...)` : '✗ MISSING');
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? `✓ (${process.env.SUPABASE_SERVICE_ROLE_KEY.substring(0, 30)}...)` : '✗ MISSING');
console.log('PORT:', process.env.PORT || '3001 (default)');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS настройки
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

// Логирование запросов
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Роуты
app.use('/api/events', eventsRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 CORS enabled for: ${process.env.CORS_ORIGIN || 'http://localhost:5173'}`);
});

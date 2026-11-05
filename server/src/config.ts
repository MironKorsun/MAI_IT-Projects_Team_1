import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Значение переменной окружения или содержимое файла из NAME_FILE (секреты Docker). */
function env(name: string) {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Конфигурация — только переменными окружения (ТЗ СЧ NFR-31). */
export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  production: process.env.NODE_ENV === 'production',
  /** PostgreSQL (ТЗ СЧ, приложение Б.2). Без адреса сервер работает только в автотестах (STORAGE=memory). */
  databaseUrl: env('DATABASE_URL'),
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 10),
  memoryOnly: process.env.STORAGE === 'memory',
  migrationsDir: process.env.MIGRATIONS_DIR ?? resolve(root, 'migrations'),
  /** Каталог ключей криптомодуля, отдельно от данных (ТЗ СЧ NFR-21). */
  keyDir: process.env.KEY_DIR ?? resolve(root, 'data/keys'),
  kimDir: process.env.KIM_DIR ?? resolve(root, '../kim'),
  webDist: process.env.WEB_DIST ?? resolve(root, '../web/dist'),
  /** Cookie обновления всегда Secure (ТЗ КЧ NFR-15); браузеры принимают Secure-cookie и на http://localhost. */
  cookieSecure: process.env.COOKIE_SECURE !== '0',
  /** Мастер-ключ криптомодуля (hex, 32 байта): KIM_MASTER_KEY или файл KIM_MASTER_KEY_FILE (секрет Docker). */
  masterKey: env('KIM_MASTER_KEY'),
  /** Первичная учётная запись администратора, создаётся при пустой базе. */
  bootstrapAdmin: { login: process.env.ADMIN_LOGIN, password: env('ADMIN_PASSWORD'), fullName: process.env.ADMIN_FULL_NAME ?? 'Администратор системы' },
  accessTtlSec: 15 * 60,
  refreshTtlSec: 12 * 60 * 60,
  staffIdleSec: 30 * 60,
  lateWindowSec: 15,
  offlineWindowSec: 15 * 60,
  accessCodeAfterStartMin: 15,
};

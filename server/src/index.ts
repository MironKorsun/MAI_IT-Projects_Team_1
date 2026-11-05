import { buildApp } from './app';
import { config } from './config';
import { commitNow, db, loadDb } from './db';
import { connect, disconnect, migrate } from './store';
import { hashPassword } from './auth';
import { startScheduler } from './routes/exam';
import { uuid } from './util';

if (!config.databaseUrl) {
  console.error('Не задан DATABASE_URL (PostgreSQL). Пример: postgres://ege:ege@localhost:5432/ege — см. README, раздел «Запуск».');
  process.exit(1);
}

connect();
const applied = await migrate();
if (applied.length) console.log(`Миграции применены: ${applied.join(', ')}`);

if (!(await loadDb())) {
  // Первичная учётная запись администратора при пустой базе (дальше персонал заводится в М4).
  const { login, password, fullName } = config.bootstrapAdmin;
  if (!login || !password) {
    console.error('База пуста. Задайте ADMIN_LOGIN и ADMIN_PASSWORD для первичной учётной записи администратора.');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('ADMIN_PASSWORD должен быть не короче 12 символов (ТЗ КЧ NFR-23).');
    process.exit(1);
  }
  db.staff.push({ id: uuid(), login, fullName, passwordHash: hashPassword(password), roles: ['admin'], blocked: false, subjects: ['math-profile'], createdAt: new Date().toISOString() });
  await commitNow();
  console.log(`Создана учётная запись администратора «${login}».`);
}

const app = await buildApp();
startScheduler();
await app.listen({ port: config.port, host: config.host });
console.log(`ВП ТС ЕГЭ — серверная часть: http://localhost:${config.port} (API /api/v1, WebSocket /ws/v1)`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await commitNow().catch(() => undefined);
    await disconnect();
    process.exit(0);
  });
}
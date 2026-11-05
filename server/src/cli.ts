import { config } from './config';
import { commitNow, db, loadDb } from './db';
import { connect, disconnect, migrate } from './store';
import { seedStaging } from './fixtures';

/**
 * Служебные команды эксплуатации (ТЗ СЧ 3.3: миграции; NFR-30: стенд с синтетическими данными).
 *   node dist/cli.js migrate        — применить миграции
 *   node dist/cli.js hash-password "<пароль>" — хэш для ручной вставки в БД
 *   node dist/cli.js seed-staging   — заполнить пустой стенд синтетическими данными
 *     SEED_STAFF_PASSWORD (≥ 12 символов) и SEED_PARTICIPANT_PIN (6 цифр) задаёт оператор.
 */
const cmd = process.argv[2];
if (cmd === 'hash-password') {
  // Хэш пароля для ручной вставки в БД (staff_users.password_hash, participants.pin_hash)
  const { hashPassword } = await import('./auth');
  const pw = process.argv[3] ?? '';
  if (!pw) {
    console.error('Использование: node server/dist/cli.js hash-password "<пароль>"');
    process.exit(1);
  }
  console.log(hashPassword(pw));
  process.exit(0);
}
if (!config.databaseUrl) {
  console.error('Не задан DATABASE_URL');
  process.exit(1);
}
connect();
try {
  const applied = await migrate();
  console.log(applied.length ? `Миграции применены: ${applied.join(', ')}` : 'Схема БД актуальна');
  if (cmd === 'seed-staging') {
    const staffPassword = process.env.SEED_STAFF_PASSWORD ?? '';
    const participantPin = process.env.SEED_PARTICIPANT_PIN ?? '';
    await loadDb();
    if (db.sessions.length || db.participants.length) {
      console.error('База уже содержит экзаменационные данные — заполнение стенда отменено.');
      process.exitCode = 1;
    } else {
      seedStaging({ staffPassword, participantPin, keep: { staff: db.staff, audit: db.audit } });
      await commitNow();
      console.log(`Стенд заполнен: ${db.sessions.length} сессии, ${db.participants.length} участников, ${db.staff.length} учётных записей персонала.`);
    }
  } else if (cmd !== 'migrate') {
    console.error('Команды: migrate | seed-staging');
    process.exitCode = 1;
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await disconnect();
}

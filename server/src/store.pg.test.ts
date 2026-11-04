import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Интеграционные проверки хранилища PostgreSQL. Выполняются при заданном TEST_DATABASE_URL
 * (отдельная база: схема public пересоздаётся), например в CI со службой postgres:16.
 */
const url = process.env.TEST_DATABASE_URL;
/** JSON с упорядоченными ключами: порядок полей объекта не важен. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const skip = url ? false : 'TEST_DATABASE_URL не задан';

test('PostgreSQL: миграции, запись, чтение, фиксация до ответа API, неизменяемый журнал', { skip }, async () => {
  const store = await import('./store');
  const dbm = await import('./db');
  const { seedStaging } = await import('./fixtures');
  const pool = store.connect(url);
  try {
    await pool.query('DROP SCHEMA IF EXISTS analytics CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    assert.deepEqual(await store.migrate(), ['001_init.sql']);
    assert.deepEqual(await store.migrate(), [], 'повторный запуск миграций ничего не меняет');

    // Состав столбцов модели совпадает со схемой
    for (const [table, cols] of store.expectedColumns()) {
      const { rows } = await pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'row_no'",
        [table],
      );
      assert.deepEqual(rows.map((r) => r.column_name).sort(), [...cols].sort(), table);
    }

        await dbm.loadDb();
    const password = 'test-staff-password-2026';
    seedStaging({ staffPassword: password, participantPin: '123456', accessCode: '482915' });
    await dbm.commitNow();
    const before = canon(dbm.db);
    assert.equal(await dbm.loadDb(), true);
    assert.equal(canon(dbm.db), before, 'данные читаются из БД без потерь и в том же порядке');

    // Изменяющий запрос API отвечает после фиксации в БД
    const { buildApp } = await import('./app');
    const app = await buildApp();
    const room = dbm.db.rooms.find((r) => r.accessCode === '482915')!;
    const ws = dbm.db.workstations.find((w) => w.roomId === room.id)!;
    const attempt = dbm.db.attempts.find((a) => a.workstationId === ws.id)!;
    const code = dbm.db.participants.find((p) => p.id === attempt.participantId)!.code;
    let r = await app.inject({ method: 'POST', url: '/api/v1/auth/participant/login', payload: { participantCode: code, accessCode: '482915', workstationSecret: ws.secret } });
    assert.equal(r.statusCode, 200);
    const { rows: st } = await pool.query('SELECT state, logged_in_at FROM attempts WHERE id = $1', [attempt.id]);
    assert.equal(st[0].state, 'waiting');
    assert.ok(st[0].logged_in_at);
    r = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login: 'org1', password } });
    assert.equal(r.statusCode, 200);
    const { rows: ev } = await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE type LIKE 'auth.%'");
    assert.ok(ev[0].n >= 1, 'событие входа записано в журнал до ответа');
    await app.close();

        // Журнал только дополняется (NFR-25)
    await assert.rejects(pool.query("UPDATE audit_events SET details = 'x'"), /не может быть изменена/);
    await assert.rejects(pool.query('DELETE FROM audit_events'), /не может быть изменена/);

    // Пароли и PIN — только хэши (NFR-20)
    const { rows: leak } = await pool.query("SELECT count(*)::int AS n FROM staff_users WHERE password_hash NOT LIKE 'scrypt$%' OR password_hash LIKE $1", [`%${password}%`]);
    assert.equal(leak[0].n, 0);

    await assert.rejects(pool.query('TRUNCATE audit_events'), /очистка журнала запрещена/);

    // Витрины аналитики без ПДн и идентификаторов участников (FR-51)
    for (const view of ['dm_exam_results', 'dm_task_results', 'dm_task_stats', 'dm_regions']) {
      const { fields, rows } = await pool.query(`SELECT * FROM analytics.${view}`);
      const names = fields.map((f) => f.name);
      for (const pd of ['last_name', 'first_name', 'middle_name', 'document_number', 'birth_date', 'participant_id', 'code', 'pin_hash']) assert.ok(!names.includes(pd), `${view}.${pd}`);
      assert.ok(rows.length > 0, view);
    }
  } finally {
    await store.disconnect();
  }
});
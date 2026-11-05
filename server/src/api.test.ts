import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STORAGE = 'memory';
const { seedStaging } = await import('./fixtures');
const { buildApp } = await import('./app');
const dbm = await import('./db');
const { acceptLate } = await import('./routes/exam');
const { pickSession } = await import('./routes/public');
import type { Attempt } from './db';

const STAFF_PASSWORD = 'test-staff-password-2026';
seedStaging({ staffPassword: STAFF_PASSWORD, participantPin: '123456', accessCode: '482915' });
const app = await buildApp();
const uuid = () => crypto.randomUUID();

function cookieFrom(res: { headers: Record<string, unknown> }) {
  const sc = res.headers['set-cookie'];
  return (Array.isArray(sc) ? sc : [sc]).map((c) => String(c).split(';')[0]).join('; ');
}

async function staff(login: string) {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login, password: STAFF_PASSWORD } });
  assert.equal(r.statusCode, 200);
  return { authorization: `Bearer ${r.json().accessToken}` };
}

test('сквозной сценарий ТС-01: вход, старт, ответы, завершение', async () => {
  const room = dbm.db.rooms.find((r) => r.accessCode === '482915')!;
  const ws = dbm.db.workstations.find((w) => w.roomId === room.id)!;
  const attempt = dbm.db.attempts.find((a) => a.workstationId === ws.id)!;
  const code = dbm.db.participants.find((p) => p.id === attempt.participantId)!.code;

  // Неверный код — 401 без указания поля
  let r = await app.inject({ method: 'POST', url: '/api/v1/auth/participant/login', payload: { participantCode: code, accessCode: '000000', workstationSecret: ws.secret } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().code, 'INVALID_CREDENTIALS');
  assert.equal(r.headers['content-type'], 'application/problem+json; charset=utf-8');

  r = await app.inject({ method: 'POST', url: '/api/v1/auth/participant/login', payload: { participantCode: code, accessCode: '482915', workstationSecret: ws.secret } });
  assert.equal(r.statusCode, 200);
  const h = { authorization: `Bearer ${r.json().accessToken}` };
  const id = r.json().attemptId;

  // Ключ до старта — 403 KIM_NOT_AVAILABLE
  r = await app.inject({ method: 'GET', url: `/api/v1/attempts/${id}/kim-key`, headers: h });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code, 'KIM_NOT_AVAILABLE');

  // Пакет КИМ не содержит эталонов
  r = await app.inject({ method: 'GET', url: `/api/v1/rooms/${room.id}/kim-package`, headers: { 'x-workstation-secret': ws.secret } });
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes('correct'));
  r = await app.inject({ method: 'GET', url: `/api/v1/rooms/${room.id}/kim-package`, headers: { 'x-workstation-secret': ws.secret, range: 'bytes=0-99' } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.rawPayload.length, 100);

  const org = await staff('org1');
  r = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/start`, headers: org });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/start`, headers: org });
  assert.equal(r.json().code, 'ROOM_ALREADY_STARTED');

  r = await app.inject({ method: 'GET', url: `/api/v1/attempts/${id}/kim-key`, headers: h });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'POST', url: `/api/v1/attempts/${id}/ready`, headers: { ...h, 'idempotency-key': uuid() }, payload: {} });
  assert.equal(r.json().state, 'inProgress');

  const a = dbm.db.attempts.find((x) => x.id === id)!;
  const variant = dbm.db.variants.find((v) => v.id === a.variantId)!;
  const t1 = variant.keys[0];
  const KEY = t1.correct![0].values[0].replace('.', ',');
  const now = new Date().toISOString();

  // Без ключа идемпотентности — 400
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: h, payload: { kind: 'short', value: '1', seq: 1, changedAtServerClock: now } });
  assert.equal(r.json().code, 'IDEMPOTENCY_KEY_REQUIRED');
  // Поле баллов вне схемы — 400 (ТЗ КЧ NFR-20)
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': uuid() }, payload: { kind: 'short', value: '1', seq: 1, changedAtServerClock: now, score: 1 } });
  assert.equal(r.statusCode, 400);

  const key = uuid();
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': key }, payload: { kind: 'short', value: KEY, seq: 2, changedAtServerClock: now } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers.etag, '"v1"');
  // Повтор с тем же ключом — тот же результат без повторного применения
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': key }, payload: { kind: 'short', value: KEY, seq: 2, changedAtServerClock: now } });
  assert.equal(r.json().version, 1);
  // Тот же ключ, другое тело — 422
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': key }, payload: { kind: 'short', value: '9', seq: 3, changedAtServerClock: now } });
  assert.equal(r.json().code, 'IDEMPOTENCY_KEY_REUSED');
  // Старое изменение (seq ≤ принятого) не перезаписывает новое
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': uuid() }, payload: { kind: 'short', value: '5', seq: 1, changedAtServerClock: now } });
  assert.equal(r.json().status, 'stale');
  // Устаревшая версия в If-Match — 412
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': uuid(), 'if-match': '"v0"' }, payload: { kind: 'short', value: '5', seq: 5, changedAtServerClock: now } });
  assert.equal(r.statusCode, 412);

  r = await app.inject({ method: 'POST', url: `/api/v1/attempts/${id}/finish`, headers: { ...h, 'idempotency-key': uuid() }, payload: {} });
  assert.equal(r.json().state, 'finished');
  r = await app.inject({ method: 'PUT', url: `/api/v1/attempts/${id}/answers/${t1.id}`, headers: { ...h, 'idempotency-key': uuid() }, payload: { kind: 'short', value: '1', seq: 9, changedAtServerClock: new Date().toISOString() } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'ATTEMPT_CLOSED');
  // Работа проверена автоматически сразу после завершения: верный ответ на задание 1 — 1 балл
  const result = dbm.db.results.find((x) => x.attemptId === id)!;
  assert.equal(result.tasks.length, 12);
  assert.equal(result.tasks.find((x) => x.taskId === t1.id)!.score, 1);
});

test('обращение к чужой попытке отклоняется (ТЗ СЧ FR-06)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/results/login', payload: { participantCode: '5000-000-001', pin: '123456' } });
  const h = { authorization: `Bearer ${r.json().accessToken}` };
  const other = dbm.db.attempts[0];
  const s = await app.inject({ method: 'GET', url: `/api/v1/attempts/${other.id}/state`, headers: h });
  assert.equal(s.statusCode, 403);
});

test('М6: результаты без эталонов, апелляция в окне (FR-37, FR-49)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/results/login', payload: { participantCode: '5000-000-001', pin: '123456' } });
  const h = { authorization: `Bearer ${r.json().accessToken}` };
  const res = await app.inject({ method: 'GET', url: '/api/v1/me/results', headers: h });
  const list = res.json();
  assert.equal(list.length, 1);
  assert.ok(!res.body.includes('"correct"'));
  const ap = await app.inject({ method: 'POST', url: '/api/v1/me/appeals', headers: h, payload: { sessionId: list[0].sessionId, taskNumbers: [5], text: 'Не согласен с оценкой задания 5' } });
  assert.equal(ap.statusCode, 200);
  assert.match(ap.json().number, /^АП-/);
});

test('ротация маркера обновления: повторное использование отзывает сеанс (FR-04)', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login: 'admin', password: STAFF_PASSWORD } });
  const c1 = cookieFrom(r);
  const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: c1 }, payload: { kind: 'staff' } });
  assert.equal(r2.statusCode, 200);
  const r3 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: c1 }, payload: { kind: 'staff' } });
  assert.equal(r3.statusCode, 401);
  const r4 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: cookieFrom(r2) }, payload: { kind: 'staff' } });
  assert.equal(r4.statusCode, 401);
});

test('блокировка входа после 5 неудачных попыток (FR-02)', async () => {
  for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login: 'observer', password: 'wrong-password-x' } });
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/staff/login', payload: { login: 'observer', password: STAFF_PASSWORD } });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code, 'AUTH_LOCKED');
});

test('окно приёма изменений после окончания времени — граничные значения ТС-08 (FR-17)', () => {
  const end = Date.now() - 1000;
  const mk = (lastSeenInTime?: number): Attempt =>
    ({ baseEndsAt: new Date(end).toISOString(), compensationMin: 0, lastSeenInTime: lastSeenInTime ? new Date(lastSeenInTime).toISOString() : undefined }) as Attempt;
  const iso = (t: number) => new Date(t).toISOString();
  assert.equal(acceptLate(mk(), iso(end - 1)), true, 'изменение до окончания, доставка в пределах 15 с');
  assert.equal(acceptLate(mk(), iso(end)), true, 'изменение в момент окончания');
  assert.equal(acceptLate(mk(), iso(end + 1)), false, 'изменение после окончания');
  const late = { ...mk(), baseEndsAt: new Date(Date.now() - 60_000).toISOString() } as Attempt;
  const lEnd = Date.now() - 60_000;
  late.lastSeenInTime = new Date(lEnd - 30_000).toISOString();
  assert.equal(acceptLate(late, iso(lEnd - 10_000)), true, 'нет обращений после изменения — принимается до 15 мин');
  late.lastSeenInTime = new Date(lEnd - 5_000).toISOString();
  assert.equal(acceptLate(late, iso(lEnd - 10_000)), false, 'клиент обращался позже изменения — отклоняется');
  const veryLate = { baseEndsAt: new Date(Date.now() - 16 * 60_000).toISOString(), compensationMin: 0 } as Attempt;
  assert.equal(acceptLate(veryLate, iso(Date.now() - 17 * 60_000)), false, 'позднее 15 минут — отклоняется');
});

test('публичная сводка портала: без входа, без ПДн, кэш 30 с (C.1)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/v1/public/overview' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=30');
  const body = r.json();
  assert.deepEqual(Object.keys(body).sort(), ['exam', 'session']);
  assert.deepEqual(body.exam, {
    title: 'Математика (профильный уровень)',
    year: 2026,
    kimVersion: '1.0.0',
    tasksCount: 12,
    durationMin: 235,
    extraTimeMin: 90,
    threshold: 27,
  });
  if (body.session !== null) {
    assert.deepEqual(Object.keys(body.session).sort(), ['date', 'startLocal', 'status', 'tz']);
    assert.match(body.session.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['preparation', 'active', 'completed'].includes(body.session.status));
  }
  // Ни персональных данных, ни секретов, ни идентификаторов записей
  for (const k of ['id', 'fullName', 'lastName', 'firstName', 'middleName', 'documentNumber', 'birthDate', 'code', 'participantCode', 'login', 'password', 'pin', 'accessCode', 'secret', 'roomIds', 'variantIds'])
    assert.ok(!r.body.includes(`"${k}"`), `в ответе нет поля ${k}`);
  for (const p of dbm.db.participants.slice(0, 20)) assert.ok(!r.body.includes(p.lastName) && !r.body.includes(p.code));
});

test('выбор сессии для портала: сегодня в часовом поясе сессии, иначе ближайшая будущая', () => {
  const mk = (date: string, tz: string, status: 'preparation' | 'active' | 'completed' = 'preparation') =>
    ({ id: uuid(), examCode: 'math-profile', date, startLocal: '10:00', tz, status }) as Parameters<typeof pickSession>[0][number];
  // 20:30 UTC 20.10 — в Москве 23:30 того же дня, во Владивостоке уже 06:30 21.10
  const now = new Date('2026-10-20T20:30:00Z');
  const msk = mk('2026-10-20', 'Europe/Moscow');
  const vvo = mk('2026-10-21', 'Asia/Vladivostok');
  assert.equal(pickSession([mk('2026-09-15', 'Europe/Moscow', 'completed'), msk], now), msk);
  assert.equal(pickSession([vvo], now), vvo);
  assert.equal(pickSession([mk('2026-10-21', 'Europe/Moscow')], now)?.date, '2026-10-21', 'завтрашняя по Москве — ближайшая будущая');
  const later = mk('2026-11-02', 'Europe/Moscow');
  assert.equal(pickSession([later, mk('2026-10-25', 'Europe/Moscow')], now)?.date, '2026-10-25');
  assert.equal(pickSession([mk('2026-10-19', 'Europe/Moscow')], now), undefined);
  assert.equal(pickSession([{ ...msk, examCode: 'math-base' }], now), undefined);
});

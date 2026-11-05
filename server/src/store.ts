import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { AnswerVersion, Attempt, Database } from './db';
import { config } from './config';

/**
 * Хранилище PostgreSQL (ТЗ СЧ, Б.2 и ADR-002).
 *
 * Рабочий набор данных узла API держится в памяти (`db`), PostgreSQL — система учёта.
 * Изменения вычисляются сравнением с последним записанным состоянием и фиксируются
 * одной транзакцией; изменяющие запросы API отвечают только после фиксации (app.ts → onSend),
 * поэтому подтверждённый клиенту ответ уже записан в БД (NFR-09, NFR-10).
 */

type Kind = 'text' | 'int' | 'float' | 'bool' | 'ts' | 'date' | 'json';
type Col = readonly [prop: string, column: string, kind: Kind];

interface TableSpec {
  table: string;
  collection: Exclude<keyof Database, 'version' | 'audit' | 'telemetry'>;
  pk: string[];
  key: (o: any) => string;
  cols: readonly Col[];
}

const t = (prop: string, column = snake(prop)): Col => [prop, column, 'text'];
const ts = (prop: string, column = snake(prop)): Col => [prop, column, 'ts'];
const js = (prop: string, column = snake(prop)): Col => [prop, column, 'json'];
const int = (prop: string, column = snake(prop)): Col => [prop, column, 'int'];
const bool = (prop: string, column = snake(prop)): Col => [prop, column, 'bool'];
function snake(s: string) {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}
const byIdKey = (o: { id: string }) => o.id;

/** Таблицы в порядке зависимостей. Состав столбцов совпадает с migrations/001_init.sql (проверяется тестом). */
export const TABLES: readonly TableSpec[] = [
  { table: 'ppes', collection: 'ppes', pk: ['id'], key: byIdKey, cols: [t('id'), t('code'), t('name'), t('region'), t('regionCode'), t('tz')] },
  { table: 'schools', collection: 'schools', pk: ['id'], key: byIdKey, cols: [t('id'), t('name'), t('regionCode')] },
  {
    table: 'staff_users',
    collection: 'staff',
    pk: ['id'],
    key: byIdKey,
    cols: [t('id'), t('login'), t('fullName'), t('passwordHash'), js('roles'), bool('blocked'), js('subjects'), ts('createdAt')],
  },
  {
    table: 'participants',
    collection: 'participants',
    pk: ['id'],
    key: byIdKey,
    cols: [t('id'), t('code'), t('lastName'), t('firstName'), t('middleName'), t('documentNumber'), ['birthDate', 'birth_date', 'date'], t('pinHash'), t('schoolId'), t('regionCode'), js('specialConditions')],
  },
  {
    table: 'kim_variants',
    collection: 'variants',
    pk: ['id'],
    key: byIdKey,
    cols: [t('id'), t('examCode'), int('number'), t('title'), js('encrypted'), js('wrappedKey'), js('keys'), ts('importedAt'), t('checksum')],
  },
  {
    table: 'exam_sessions',
    collection: 'sessions',
    pk: ['id'],
    key: byIdKey,
    cols: [
      t('id'), t('examCode'), ['date', 'date', 'date'], t('startLocal'), t('tz'), int('durationMin'), js('variantIds'), js('roomIds'), bool('proctoring'),
      t('status'), t('resultsStatus'), ts('createdAt'), ts('publishedAt'), js('appealWindow'), t('scaleVersion'),
    ],
  },
  {
    table: 'rooms',
    collection: 'rooms',
    pk: ['id'],
    key: byIdKey,
    cols: [t('id'), t('sessionId'), t('ppeId'), t('number'), t('accessCode'), ts('accessCodeIssuedAt'), ts('startedAt'), js('organizerIds'), js('messages')],
  },
  { table: 'workstations', collection: 'workstations', pk: ['id'], key: byIdKey, cols: [t('id'), t('roomId'), t('label'), t('secret'), js('check')] },
  {
    table: 'attempts',
    collection: 'attempts',
    pk: ['id'],
    key: byIdKey,
    cols: [
      t('id'), t('sessionId'), t('participantId'), t('roomId'), t('workstationId'), t('state'), t('variantId'), ts('loggedInAt'), ts('t0', 't0'),
      ts('baseEndsAt'), int('compensationMin'), js('compensations'), int('lastSeq'), js('notes'), js('flags'), t('lastTaskId'), ts('lastSeenAt'),
      ts('lastSeenInTime'), ['downtimeSec', 'downtime_sec', 'float'], ts('finishedAt'), t('terminationMessage'), js('incident'),
      t('earlyFinishReason'), js('integrity'), ts('readyAt'), bool('graded'),
    ],
  },
  {
    table: 'results',
    collection: 'results',
    pk: ['attempt_id'],
    key: (o) => o.attemptId,
    cols: [
      t('attemptId'), t('sessionId'), t('participantId'), int('primaryScore'), int('maxPrimary'), int('testScore'), int('grade'), bool('passed'),
      js('tasks'), t('scaleVersion'), t('status'), ts('calculatedAt'), js('history'),
    ],
  },
  {
    table: 'scales',
    collection: 'scales',
    pk: ['exam_code', 'year', 'version', 'kind'],
    key: (o) => `${o.examCode}|${o.year}|${o.version}|${o.kind}`,
    cols: [t('examCode'), int('year'), t('version'), t('kind'), js('values'), ['threshold', 'threshold', 'float'], ts('loadedAt')],
  },
  {
    table: 'appeals',
    collection: 'appeals',
    pk: ['id'],
    key: byIdKey,
    cols: [t('id'), t('number'), t('participantId'), t('sessionId'), js('taskNumbers'), t('text'), t('status'), ts('createdAt'), js('history')],
  },
];

const AUDIT_COLS: readonly Col[] = [
  t('id'), t('type'), t('category'), ts('at'), t('actorRole'), t('actorId'), t('object'), t('ppeId'), t('roomId'), t('requestId'),
  t('result'), t('details'), t('prevHash'), t('hash'),
];
const ANSWER_COLS = ['attempt_id', 'task_id', 'version', 'seq', 'kind', 'value', 'saved_at', 'changed_at_server_clock', 'late'] as const;
const TELEMETRY_COLS = ['at', 'size', 'kind'] as const;

// Типы PostgreSQL → значения модели: даты — строками ISO, как в остальном коде.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz

function toDb(v: unknown, kind: Kind) {
  if (v === undefined || v === null) return null;
  return kind === 'json' ? JSON.stringify(v) : v;
}

function fromRow(row: Record<string, unknown>, cols: readonly Col[]) {
  const o: Record<string, unknown> = {};
  for (const [prop, column] of cols) {
    const v = row[column];
    if (v !== null && v !== undefined) o[prop] = v;
  }
  return o;
}

const q = (id: string) => `"${id}"`;

let pool: pg.Pool | undefined;

export const storageEnabled = () => !!pool;

export function connect(url = config.databaseUrl) {
  if (!url) throw new Error('DATABASE_URL не задан');
  pool = new pg.Pool({ connectionString: url, max: config.dbPoolSize, application_name: 'ege-api' });
  pool.on('error', (e) => console.error('PostgreSQL:', e.message));
  return pool;
}

export async function disconnect() {
  await pool?.end();
  pool = undefined;
}

/** Применение миграций из server/migrations по порядку имён (под рекомендательной блокировкой). */
export async function migrate(dir = config.migrationsDir) {
  const client = await pool!.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(resolve(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${file}: ${(e as Error).message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}

// ---------- последнее записанное состояние ----------
const snapshot = new Map<string, Map<string, string>>();
const savedAnswers = new Set<string>();
const savedAudit = new Set<string>();
let savedTelemetry = 0;

function rowOf(spec: TableSpec, o: any) {
  return spec.cols.map(([prop, , kind]) => toDb(o[prop], kind));
}

/** Чтение всех данных из БД в рабочий набор. */
export async function load(): Promise<Partial<Database>> {
  const out: Partial<Database> = {};
  snapshot.clear();
  savedAnswers.clear();
  savedAudit.clear();
  for (const spec of TABLES) {
    const { rows } = await pool!.query(`SELECT * FROM ${spec.table} ORDER BY row_no`);
    const list = rows.map((r) => fromRow(r, spec.cols));
    const snap = new Map<string, string>();
    for (const o of list) snap.set(spec.key(o), JSON.stringify(rowOf(spec, o)));
    snapshot.set(spec.table, snap);
    (out as Record<string, unknown>)[spec.collection] = list;
  }
  const attempts = (out.attempts ?? []) as Attempt[];
  const byAttempt = new Map(attempts.map((a) => [a.id, a]));
  for (const a of attempts) {
    a.answers = {};
    a.answerHistory = {};
  }
  const { rows: versions } = await pool!.query('SELECT * FROM answer_versions ORDER BY attempt_id, task_id, version');
  for (const r of versions) {
    const a = byAttempt.get(r.attempt_id);
    if (!a) continue;
    const v: AnswerVersion = { kind: r.kind, value: r.value, version: r.version, seq: r.seq, savedAt: r.saved_at, changedAtServerClock: r.changed_at_server_clock };
    if (r.late) v.late = true;
    (a.answerHistory[r.task_id] ??= []).push(v);
    a.answers[r.task_id] = v;
    savedAnswers.add(`${r.attempt_id}|${r.task_id}|${r.version}`);
  }
  const { rows: audit } = await pool!.query('SELECT * FROM audit_events ORDER BY row_no');
  out.audit = audit.map((r) => fromRow(r, AUDIT_COLS)) as unknown as Database['audit'];
  for (const e of out.audit) savedAudit.add(e.id);
  const { rows: tel } = await pool!.query('SELECT at, size, kind FROM telemetry ORDER BY row_no');
  out.telemetry = tel;
  savedTelemetry = tel.length;
  return out;
}

interface Upsert { spec: TableSpec; key: string; row: unknown[]; prev?: string }
interface Changes {
  upserts: Upsert[];
  deletes: { spec: TableSpec; key: string; prev: string }[];
  answers: { key: string; row: unknown[] }[];
  audit: { id: string; row: unknown[] }[];
  telemetry: unknown[][];
  telemetryFrom: number;
}

/** Синхронное вычисление изменений относительно записанного состояния. */
function collect(data: Database): Changes {
  const c: Changes = { upserts: [], deletes: [], answers: [], audit: [], telemetry: [], telemetryFrom: savedTelemetry };
  for (const spec of TABLES) {
    const snap = snapshot.get(spec.table) ?? new Map<string, string>();
    snapshot.set(spec.table, snap);
    const seen = new Set<string>();
    for (const o of data[spec.collection] as unknown[]) {
      const key = spec.key(o);
      seen.add(key);
      const row = rowOf(spec, o);
      const json = JSON.stringify(row);
      const prev = snap.get(key);
      if (prev !== json) {
        c.upserts.push({ spec, key, row, prev });
        snap.set(key, json);
      }
    }
    for (const [key, prev] of snap) {
      if (!seen.has(key)) {
        c.deletes.push({ spec, key, prev });
        snap.delete(key);
      }
    }
  }
  for (const a of data.attempts) {
    for (const [taskId, list] of Object.entries(a.answerHistory)) for (const v of list) addAnswer(c, a.id, taskId, v);
    for (const [taskId, v] of Object.entries(a.answers)) addAnswer(c, a.id, taskId, v);
  }
  for (const e of data.audit) {
    if (savedAudit.has(e.id)) continue;
    savedAudit.add(e.id);
    c.audit.push({ id: e.id, row: AUDIT_COLS.map(([prop, , kind]) => toDb((e as unknown as Record<string, unknown>)[prop], kind)) });
  }
  for (let i = savedTelemetry; i < data.telemetry.length; i++) {
    const x = data.telemetry[i];
    c.telemetry.push([x.at, x.size, x.kind]);
  }
  savedTelemetry = data.telemetry.length;
  return c;
}

function addAnswer(c: Changes, attemptId: string, taskId: string, v: AnswerVersion) {
  const key = `${attemptId}|${taskId}|${v.version}`;
  if (savedAnswers.has(key)) return;
  savedAnswers.add(key);
  c.answers.push({ key, row: [attemptId, taskId, v.version, v.seq, v.kind, v.value, v.savedAt, v.changedAtServerClock, v.late ?? null] });
}

/** Откат «записанного состояния», если транзакция не прошла: следующая запись повторит изменения. */
function revert(c: Changes) {
  for (const u of c.upserts) {
    const snap = snapshot.get(u.spec.table)!;
    if (u.prev === undefined) snap.delete(u.key);
    else snap.set(u.key, u.prev);
  }
  for (const d of c.deletes) snapshot.get(d.spec.table)!.set(d.key, d.prev);
  for (const a of c.answers) savedAnswers.delete(a.key);
  for (const e of c.audit) savedAudit.delete(e.id);
  savedTelemetry = Math.min(savedTelemetry, c.telemetryFrom);
}

const CHUNK = 400;

async function insert(client: pg.PoolClient, table: string, cols: readonly string[], rows: unknown[][], conflict: string) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const values = part
      .map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(', ')})`)
      .join(', ');
    await client.query(`INSERT INTO ${table} (${cols.map(q).join(', ')}) VALUES ${values} ${conflict}`, params);
  }
}

async function write(c: Changes) {
  const client = await pool!.connect();
  try {
    await client.query('BEGIN');
    for (const spec of TABLES) {
      const ups = c.upserts.filter((u) => u.spec === spec);
      if (!ups.length) continue;
      const cols = spec.cols.map(([, column]) => column);
      const update = cols.filter((x) => !spec.pk.includes(x)).map((x) => `${q(x)} = EXCLUDED.${q(x)}`).join(', ');
      await insert(client, spec.table, cols, ups.map((u) => u.row), `ON CONFLICT (${spec.pk.map(q).join(', ')}) DO UPDATE SET ${update}`);
    }
    for (const d of c.deletes) {
      const spec = d.spec;
      const parts = spec.pk.length === 1 ? [d.key] : d.key.split('|');
      await client.query(`DELETE FROM ${spec.table} WHERE ${spec.pk.map((p, i) => `${q(p)} = $${i + 1}`).join(' AND ')}`, parts);
    }
    if (c.answers.length) await insert(client, 'answer_versions', ANSWER_COLS, c.answers.map((a) => a.row), 'ON CONFLICT DO NOTHING');
    if (c.audit.length) await insert(client, 'audit_events', AUDIT_COLS.map(([, column]) => column), c.audit.map((a) => a.row), 'ON CONFLICT DO NOTHING');
    if (c.telemetry.length) await insert(client, 'telemetry', TELEMETRY_COLS, c.telemetry, '');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

let chain: Promise<void> = Promise.resolve();

/**
 * Фиксация всех изменений рабочего набора. Вызовы выстраиваются в очередь, каждая транзакция
 * содержит согласованный снимок изменений на момент вызова.
 */
export function commit(data: Database): Promise<void> {
  if (!pool) return Promise.resolve();
  const c = collect(data);
  if (!c.upserts.length && !c.deletes.length && !c.answers.length && !c.audit.length && !c.telemetry.length) return chain;
  const run = chain.then(() =>
    write(c).catch((e) => {
      revert(c);
      throw e;
    }),
  );
  chain = run.catch(() => undefined);
  return run;
}

/** Проверка доступности БД для /health/ready. */
export async function ping() {
  if (!pool) return true;
  await pool.query('SELECT 1');
  return true;
}

export async function isEmpty() {
  const { rows } = await pool!.query<{ n: number }>('SELECT (SELECT count(*) FROM staff_users)::int AS n');
  return rows[0].n === 0;
}

/** Состав столбцов модели — для проверки соответствия миграциям в тесте. */
export function expectedColumns() {
  const m = new Map<string, string[]>(TABLES.map((s) => [s.table, s.cols.map(([, column]) => column)]));
  m.set('audit_events', AUDIT_COLS.map(([, column]) => column));
  m.set('answer_versions', [...ANSWER_COLS]);
  return m;
}

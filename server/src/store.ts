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
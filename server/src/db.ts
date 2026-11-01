import type {
  AnswerValue,
  AppealStatus,
  AttemptState,
  ResultsStatus,
  SpecialConditions,
  StaffRole,
  WorkstationCheck,
} from '../../shared/types';
import * as store from './store';

/** Физическая модель данных Серверной части (ТЗ СЧ, раздел 3.2: компоненты С1–С7). */

export interface Ppe { id: string; code: string; name: string; region: string; regionCode: string; tz: string }

export interface Workstation {
  id: string;
  roomId: string;
  label: string;
  secret: string;
  check?: { passed: boolean; at: string; details: Partial<WorkstationCheck> };
}

export interface Room {
  id: string;
  sessionId: string;
  ppeId: string;
  number: string;
  accessCode?: string;
  accessCodeIssuedAt?: string;
  startedAt?: string;
  organizerIds: string[];
  messages: { id: string; text: string; at: string }[];
}

export interface Participant {
  id: string;
  code: string;
  lastName: string;
  firstName: string;
  middleName: string;
  documentNumber: string;
  birthDate: string;
  /** PIN для входа в М6 вне ППЭ (учебное допущение вместо Госуслуг). */
  pinHash: string;
  schoolId: string;
  regionCode: string;
  specialConditions: SpecialConditions;
}

export interface StaffUser {
  id: string;
  login: string;
  fullName: string;
  passwordHash: string;
  roles: StaffRole[];
  blocked: boolean;
  subjects: string[];
  createdAt: string;
}

export interface AnswerVersion extends AnswerValue {
  version: number;
  seq: number;
  savedAt: string;
  changedAtServerClock: string;
  late?: boolean;
}

export interface Attempt {
  id: string;
  sessionId: string;
  participantId: string;
  roomId: string;
  workstationId: string;
  state: AttemptState;
  variantId?: string;
  loggedInAt?: string;
  t0?: string;
  baseEndsAt?: string;
  compensationMin: number;
  compensations: { minutes: number; reason: string; at: string; by: string }[];
  answers: Record<string, AnswerVersion>;
  answerHistory: Record<string, AnswerVersion[]>;
  lastSeq: number;
  notes: Record<string, string>;
  flags: string[];
  lastTaskId?: string;
  lastSeenAt?: string;
  /** Последнее обращение клиента до окончания времени (ТЗ СЧ FR-17 б). */
  lastSeenInTime?: string;
  /** Интервалы без запросов клиента дольше 60 с (ТЗ СЧ FR-22). */
  downtimeSec: number;
  finishedAt?: string;
  terminationMessage?: string;
  incident?: { type: string; description: string; at: string; by: string };
  earlyFinishReason?: string;
  integrity: { type: string; at: string; receivedAt: string }[];
  readyAt?: string;
  graded?: boolean;
}

export interface ExamSession {
  id: string;
  examCode: string;
  date: string;
  startLocal: string;
  tz: string;
  durationMin: number;
  variantIds: string[];
  roomIds: string[];
  proctoring: boolean;
  status: 'preparation' | 'active' | 'completed';
  resultsStatus: ResultsStatus;
  createdAt: string;
  publishedAt?: string;
  appealWindow?: { from: string; to: string };
  scaleVersion?: string;
}

export interface StoredTask {
  id: string;
  number: number;
  part: 1 | 2;
  type: 'short';
  topic: string;
  difficulty: 'basic' | 'advanced' | 'high';
  maxScore: number;
  condition: string;
  question?: string;
  format?: 'integer' | 'decimal' | 'digits' | 'word';
  compare?: 'number' | 'sequence' | 'set';
  /** Версии эталона ответа (исправление эталона — ТЗ СЧ FR-33). */
  correct?: { version: number; values: string[]; reason?: string; at: string }[];
  referenceIds: string[];
  author: string;
}

export interface KimVariant {
  id: string;
  examCode: string;
  number: number;
  title: string;
  /** Зашифрованное содержимое для клиента (AES-256-GCM). */
  encrypted: { iv: string; data: string };
  /** Ключ варианта, зашифрованный мастер-ключом криптомодуля. */
  wrappedKey: { iv: string; data: string };
  /** Эталоны и критерии (без условий), используются только С4. */
  keys: StoredTask[];
  importedAt: string;
  checksum: string;
}

export interface Result {
  attemptId: string;
  sessionId: string;
  participantId: string;
  primaryScore: number;
  maxPrimary: number;
  testScore?: number;
  grade?: number;
  passed: boolean;
  tasks: { taskId: string; number: number; part: 1 | 2; score: number; maxScore: number; protocol?: string }[];
  scaleVersion: string;
  status: 'calculated' | 'approved' | 'published';
  calculatedAt: string;
  history: { at: string; primaryScore: number; reason: string }[];
}

export interface Scale {
  examCode: string;
  year: number;
  version: string;
  kind: 'test' | 'grade';
  values: number[];
  threshold: number;
  loadedAt: string;
}

export interface Appeal {
  id: string;
  number: string;
  participantId: string;
  sessionId: string;
  taskNumbers: number[];
  text: string;
  status: AppealStatus;
  createdAt: string;
  history: { status: AppealStatus; at: string; comment?: string }[];
}

export interface AuditEvent {
  id: string;
  type: string;
  category: string;
  at: string;
  actorRole: string;
  actorId?: string;
  object?: string;
  ppeId?: string;
  roomId?: string;
  requestId?: string;
  result: 'ok' | 'error';
  details?: string;
  prevHash: string;
  hash: string;
}

export interface School { id: string; name: string; regionCode: string }

export interface Database {
  version: number;
  ppes: Ppe[];
  schools: School[];
  rooms: Room[];
  workstations: Workstation[];
  participants: Participant[];
  staff: StaffUser[];
  sessions: ExamSession[];
  attempts: Attempt[];
  variants: KimVariant[];
  results: Result[];
  scales: Scale[];
  appeals: Appeal[];
  audit: AuditEvent[];
  telemetry: { at: string; size: number; kind: string }[];
}

export function emptyDb(): Database {
  return {
    version: 1,
    ppes: [],
    schools: [],
    rooms: [],
    workstations: [],
    participants: [],
    staff: [],
    sessions: [],
    attempts: [],
    variants: [],
    results: [],
    scales: [],
    appeals: [],
    audit: [],
    telemetry: [],
  };
}

export let db: Database = emptyDb();

export function setDb(next: Database) {
  db = next;
}

/** Загрузка рабочего набора из PostgreSQL. Возвращает false, если база пуста (нет учётных записей). */
export async function loadDb(): Promise<boolean> {
  const data = await store.load();
  db = { ...emptyDb(), ...data };
  return db.staff.length > 0;
}

let saveTimer: NodeJS.Timeout | undefined;

/**
 * Отложенная фиксация изменений, сделанных вне запроса API (планировщик, WebSocket).
 * Изменяющие запросы API фиксируются до отправки ответа — см. commitNow() и app.ts.
 */
export function persist() {
  if (!store.storageEnabled() || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    commitNow().catch((e) => console.error('Не удалось записать изменения в PostgreSQL:', (e as Error).message));
  }, 200);
}

/** Немедленная фиксация всех изменений одной транзакцией. */
export function commitNow() {
  return store.commit(db);
}

export const byId = <T extends { id: string }>(list: T[], id: string | undefined) =>
  id ? list.find((x) => x.id === id) : undefined;
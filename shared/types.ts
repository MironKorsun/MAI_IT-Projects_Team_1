/**
 * Общие типы контрактов API /api/v1 (ТЗ КЧ, раздел 7; ТЗ СЧ, раздел 7).
 * Источник истины — api/openapi.v1.yaml; эти типы повторяют схемы спецификации.
 */

export type AttemptState =
  | 'assigned'
  | 'waiting'
  | 'loading'
  | 'inProgress'
  | 'finished'
  | 'timeExpired'
  | 'removed'
  | 'notCompleted';

export const FINAL_STATES: AttemptState[] = ['finished', 'timeExpired', 'removed', 'notCompleted'];

export const ATTEMPT_STATE_LABEL: Record<AttemptState, string> = {
  assigned: 'Назначена',
  waiting: 'Ожидание старта',
  loading: 'Загрузка',
  inProgress: 'Выполняется',
  finished: 'Завершена',
  timeExpired: 'Время истекло',
  removed: 'Удалён',
  notCompleted: 'Не закончил по объективной причине',
};

export type StaffRole = 'organizer' | 'admin' | 'observer' | 'analyst';

export const ROLE_LABEL: Record<StaffRole, string> = {
  organizer: 'Организатор',
  admin: 'Администратор',
  observer: 'Наблюдатель',
  analyst: 'Аналитик',
};

export type ShortFormat = 'integer' | 'decimal' | 'digits' | 'word';

export interface SpecialConditions {
  extraTime: boolean;
  scale: 100 | 150 | 200;
  contrast: boolean;
}

/** Содержимое задания, передаваемое клиенту (без эталона ответа — ТЗ СЧ NFR-21). */
export interface TaskView {
  id: string;
  number: number;
  part: 1 | 2;
  type: 'short';
  format?: ShortFormat;
  formatHint?: string;
  maxScore: number;
  topic: string;
  /** Условие: разрешённое подмножество HTML + формулы в $...$ */
  condition: string;
  question?: string;
  wordLimit?: number;
  image?: string;
  referenceIds?: string[];
}

export interface ReferenceMaterial {
  id: string;
  kind: 'formula' | 'table' | 'constant';
  title: string;
  latex?: string;
  rows?: string[][];
}

export interface VariantContent {
  variantId: string;
  number: number;
  examCode: string;
  title: string;
  tasks: TaskView[];
  references: ReferenceMaterial[];
}

/** Ответ участника — краткий ответ в формате задания (ТЗ КЧ FR-07). */
export interface AnswerValue {
  kind: 'short';
  value: string;
}

export interface SavedAnswer extends AnswerValue {
  version: number;
  savedAt: string;
}

export interface AttemptStateDto {
  attemptId: string;
  state: AttemptState;
  serverTime: string;
  exam: { code: string; title: string; durationMin: number; tasksCount: number };
  participant: { code: string; displayName: string };
  room: { id: string; number: string; ppeCode: string };
  startedAt?: string;
  endsAt?: string;
  specialConditions: SpecialConditions;
  answers: Record<string, SavedAnswer>;
  notes: Record<string, string>;
  flags: string[];
  lastTaskId?: string;
  /** Последний принятый порядковый номер изменения (seq) — для продолжения после перезагрузки. */
  lastSeq: number;
  variantId?: string;
  messages: { id: string; text: string; at: string }[];
  roomStarted: boolean;
  terminationMessage?: string;
  finishedAt?: string;
}

export interface WorkstationCheck {
  browser: boolean;
  screen: boolean;
  fullscreen: boolean;
  latencyMs: number;
  kimPreloaded: boolean;
  passed: boolean;
}

export interface SeatDto {
  workstationId: string;
  label: string;
  check?: { passed: boolean; at: string; details: Partial<WorkstationCheck> };
  participant?: {
    attemptId: string;
    code: string;
    displayName: string;
    state: AttemptState;
    answered: number;
    lastActivityAt?: string;
    offline: boolean;
    lastIntegrity?: { type: string; at: string };
    endsAt?: string;
    specialConditions: SpecialConditions;
  };
  link?: string;
}
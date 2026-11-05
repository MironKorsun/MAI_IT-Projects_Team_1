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

export interface RoomDto {
  id: string;
  number: string;
  ppe: { id: string; code: string; name: string; region: string; tz: string };
  session: { id: string; title: string; date: string; startLocal: string; durationMin: number; proctoring: boolean };
  accessCode?: string;
  accessCodeValidUntil?: string;
  startedAt?: string;
  seats: SeatDto[];
  tasksCount: number;
  messages: { id: string; text: string; at: string }[];
}

export type ResultsStatus = 'processing' | 'calculated' | 'approved' | 'published';

export const RESULTS_STATUS_LABEL: Record<ResultsStatus, string> = {
  processing: 'Обработка',
  calculated: 'Рассчитаны',
  approved: 'Утверждены',
  published: 'Опубликованы',
};

export interface ExamSessionDto {
  id: string;
  examCode: string;
  title: string;
  date: string;
  startLocal: string;
  tz: string;
  durationMin: number;
  proctoring: boolean;
  status: 'preparation' | 'active' | 'completed';
  resultsStatus: ResultsStatus;
  rooms: { id: string; number: string; ppeCode: string; participants: number }[];
  variants: number;
  attempts: number;
  publishedAt?: string;
  appealWindow?: { from: string; to: string };
}

export interface TaskResultDto {
  number: number;
  part: 1 | 2;
  score: number;
  maxScore: number;
  answer?: string;
}

export interface MyResultDto {
  sessionId: string;
  examTitle: string;
  date: string;
  primaryScore: number;
  maxPrimary: number;
  testScore?: number;
  grade?: number;
  threshold: number;
  passed: boolean;
  tasks: TaskResultDto[];
  publishedAt: string;
  appealWindow: { from: string; to: string };
}

export type AppealStatus = 'registered' | 'reviewing' | 'accepted' | 'rejected';

export const APPEAL_STATUS_LABEL: Record<AppealStatus, string> = {
  registered: 'Зарегистрирована',
  reviewing: 'На рассмотрении',
  accepted: 'Удовлетворена',
  rejected: 'Отклонена',
};

export interface AppealDto {
  id: string;
  number: string;
  sessionId: string;
  taskNumbers: number[];
  text: string;
  status: AppealStatus;
  createdAt: string;
  history: { status: AppealStatus; at: string; comment?: string }[];
}

export interface AuditEventDto {
  id: string;
  type: string;
  category: string;
  at: string;
  actorRole: string;
  actorId?: string;
  object?: string;
  ppeCode?: string;
  roomNumber?: string;
  requestId?: string;
  result: 'ok' | 'error';
  details?: string;
  hash: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  requestId?: string;
  errors?: { pointer: string; detail: string }[];
  [k: string]: unknown;
}

export interface WsEvent<T = unknown> {
  eventId: string;
  type:
    | 'room.started'
    | 'attempt.timeChanged'
    | 'attempt.terminated'
    | 'room.message'
    | 'participant.statusChanged'
    | 'integrity.event'
    | 'workstation.checked'
    | 'auth.lockout';
  occurredAt: string;
  resourceId: string;
  data: T;
}

export const INTEGRITY_LABEL: Record<string, string> = {
  fullscreenExit: 'Выход из полноэкранного режима',
  visibilityHidden: 'Скрытие вкладки',
  windowBlur: 'Потеря фокуса окна',
  copy: 'Попытка копирования',
  paste: 'Вставка из внешнего источника',
  print: 'Попытка печати',
  contextMenu: 'Вызов контекстного меню',
};

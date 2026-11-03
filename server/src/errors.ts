import type { Problem } from '../../shared/types';

const TITLES: Record<string, string> = {
  VALIDATION_FAILED: 'Данные запроса не соответствуют схеме',
  IDEMPOTENCY_KEY_REQUIRED: 'Не передан ключ идемпотентности',
  INVALID_CREDENTIALS: 'Неверные данные для входа',
  TOKEN_INVALID: 'Сеанс истёк или недействителен',
  FORBIDDEN: 'Недостаточно прав',
  AUTH_LOCKED: 'Вход временно заблокирован',
  KIM_NOT_AVAILABLE: 'КИМ ещё недоступен',
  NOT_FOUND: 'Ресурс не найден',
  INVALID_STATE: 'Операция недопустима в текущем состоянии',
  ATTEMPT_CLOSED: 'Попытка завершена',
  ROOM_ALREADY_STARTED: 'Экзамен в аудитории уже начат',
  RESULTS_NOT_APPROVED: 'Результаты не утверждены',
  APPEAL_WINDOW_CLOSED: 'Окно подачи апелляции закрыто',
  VERSION_MISMATCH: 'Версия ресурса изменилась',
  ROLE_CONFLICT: 'Несовместимые роли учётной записи',
  COMPENSATION_EXCEEDS_DOWNTIME: 'Компенсация больше времени простоя',
  IDEMPOTENCY_KEY_REUSED: 'Ключ идемпотентности использован с другим запросом',
  IMPORT_INVALID: 'Файл содержит ошибки',
  RATE_LIMITED: 'Слишком много запросов',
  OVERLOADED: 'Сервер перегружен',
  INTERNAL_ERROR: 'Внутренняя ошибка сервера',
};

/** Ошибка API в формате RFC 9457 (ТЗ СЧ, таблица 7.4). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public detail?: string,
    public extra: Partial<Problem> = {},
  ) {
    super(code);
  }
  toProblem(instance: string, requestId?: string): Problem {
    return {
      type: `https://ege.local/problems/${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLES[this.code] ?? 'Ошибка',
      status: this.status,
      detail: this.detail,
      instance,
      code: this.code,
      requestId,
      ...this.extra,
    };
  }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND');
export const forbidden = () => new ApiError(403, 'FORBIDDEN');
export const invalid = (errors: { pointer: string; detail: string }[], code = 'VALIDATION_FAILED', status = 400) =>
  new ApiError(status, code, errors.map((e) => e.detail).join('; '), { errors });
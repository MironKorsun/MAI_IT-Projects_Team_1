import type { Problem } from '../../../shared/types';

/**
 * Типизированный клиент API /api/v1 (ТЗ КЧ, раздел 7).
 * Маркер доступа — только в памяти (NFR-15); обновление — по cookie HttpOnly.
 * Повторы при перегрузке: 1 с × 2ⁿ, предел 30 с, разброс ±20 %, Retry-After (NFR-14).
 */

export type Kind = 'participant' | 'staff' | 'results';

export class ApiError extends Error {
  constructor(
    public status: number,
    public problem: Problem,
  ) {
    super(problem.detail || problem.title);
  }
  get code() {
    return this.problem.code;
  }
  get requestId() {
    return this.problem.requestId;
  }
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.pointer.replace(/^\//, '').split('/')[0] || '_'] = e.detail;
    return out;
  }
}

export class NetworkError extends Error {
  constructor(public requestId: string) {
    super('Нет связи с сервером');
  }
}

export const uuid = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16),
      );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, retryAfter?: string | null) {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 30_000);
  const base = Math.min(1000 * 2 ** attempt, 30_000);
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.round(base + jitter);
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  /** Число повторов при 429/503/5xx и сетевых ошибках. */
  retries?: number;
  /** Не продлевать сеанс персонала (фоновый опрос, FR-50). */
  background?: boolean;
  raw?: boolean;
  timeoutMs?: number;
}

type Listener = () => void;

export class ApiClient {
  private token?: string;
  private refreshing?: Promise<boolean>;
  private unauthorized = new Set<Listener>();
  public lastServerDate?: { serverMs: number; localMs: number; rtt: number };

  constructor(public kind: Kind) {}

  setToken(t?: string) {
    this.token = t;
  }
  hasToken() {
    return !!this.token;
  }
  getToken() {
    return this.token;
  }
  onUnauthorized(fn: Listener) {
    this.unauthorized.add(fn);
    return () => {
      this.unauthorized.delete(fn);
    };
  }

  async refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const res = await fetch('/api/v1/auth/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-request-id': uuid() },
            body: JSON.stringify({ kind: this.kind }),
            credentials: 'same-origin',
          });
          if (!res.ok) return false;
          const data = (await res.json()) as { accessToken: string };
          this.token = data.accessToken;
          return true;
        } catch {
          return false;
        } finally {
          setTimeout(() => (this.refreshing = undefined), 0);
        }
      })();
    }
    return this.refreshing;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const retries = opts.retries ?? (method === 'GET' || opts.idempotencyKey ? 3 : 0);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const requestId = uuid();
      const headers: Record<string, string> = { 'x-request-id': requestId, ...opts.headers };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
      if (opts.background) headers['x-user-activity'] = 'background';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
      let res: Response;
      const t0 = performance.now();
      try {
        res = await fetch(`/api/v1${path}`, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          credentials: 'same-origin',
          signal: ctrl.signal,
        });
      } catch {
        clearTimeout(timer);
        if (attempt < retries) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw new NetworkError(requestId);
      }
      clearTimeout(timer);
      const date = res.headers.get('date');
      if (date) this.lastServerDate = { serverMs: new Date(date).getTime(), localMs: Date.now(), rtt: performance.now() - t0 };

      if (res.status === 401 && this.kind && !refreshed && !path.startsWith('/auth/')) {
        refreshed = true;
        if (await this.refresh()) {
          attempt--;
          continue;
        }
        this.token = undefined;
        this.unauthorized.forEach((f) => f());
      }
      if ([429, 503, 500, 502, 504].includes(res.status) && attempt < retries) {
        await sleep(backoffDelay(attempt, res.headers.get('retry-after')));
        continue;
      }
      if (!res.ok) {
        let problem: Problem;
        try {
          problem = (await res.json()) as Problem;
        } catch {
          problem = { type: 'about:blank', title: 'Ошибка', status: res.status, code: 'INTERNAL_ERROR' };
        }
        problem.requestId ??= res.headers.get('x-request-id') ?? requestId;
        throw new ApiError(res.status, problem);
      }
      if (opts.raw) return res as unknown as T;
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get('content-type') ?? '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      if (res.headers.get('etag')) (data as { __etag?: string }).__etag = res.headers.get('etag')!;
      return data as T;
    }
  }

  get<T>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }
  put<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PUT', path, { ...opts, body });
  }
  patch<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PATCH', path, { ...opts, body });
  }

  async login(path: string, body: unknown) {
    const data = await this.post<{ accessToken: string; attemptId?: string }>(path, body);
    this.token = data.accessToken;
    return data;
  }

  async logout(reason: 'user' | 'idle' = 'user') {
    try {
      await this.post('/auth/logout', { kind: this.kind, reason });
    } catch {
      /* ignore */
    }
    this.token = undefined;
  }

  /** Скачивание файла с авторизацией (CSV журнала, выгрузки). */
  async download(path: string, filename: string) {
    const res = await this.request<Response>('GET', path, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export const examApi = new ApiClient('participant');
export const staffApi = new ApiClient('staff');
export const resultsApi = new ApiClient('results');

/** Сообщение об ошибке в едином формате: что произошло, что делать, код обращения (FR-51). */
export function describeError(e: unknown): { title: string; action: string; code?: string } {
  if (e instanceof ApiError) {
    const action: Record<number, string> = {
      400: 'Проверьте введённые данные.',
      401: 'Войдите в систему повторно.',
      403: 'Обратитесь к администратору, если доступ необходим.',
      404: 'Обновите страницу или вернитесь к списку.',
      409: 'Данные обновлены — экран будет перерисован.',
      412: 'Данные изменились на сервере. Обновите страницу.',
      422: 'Исправьте ошибки в отмеченных полях.',
      429: 'Подождите несколько секунд и повторите.',
      503: 'Сервер перегружен. Повторите через минуту.',
    };
    return { title: e.problem.detail || e.problem.title, action: action[e.status] ?? 'Повторите действие позже или обратитесь в техподдержку.', code: e.requestId };
  }
  if (e instanceof NetworkError) return { title: 'Нет связи с сервером', action: 'Проверьте подключение и повторите действие.', code: e.requestId };
  return { title: 'Непредвиденная ошибка', action: 'Обновите страницу.', code: undefined };
}

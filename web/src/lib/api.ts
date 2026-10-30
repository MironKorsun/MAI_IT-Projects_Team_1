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
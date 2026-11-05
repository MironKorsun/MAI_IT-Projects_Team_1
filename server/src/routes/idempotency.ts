import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../errors';
import { sha256 } from '../util';

/** Идемпотентность изменяющих операций М1 и М3 (ТЗ СЧ FR-16): результат хранится 24 ч. */
const store = new Map<string, { bodyHash: string; status: number; payload: unknown; headers: Record<string, string>; at: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.at > 24 * 3600_000) store.delete(k);
}, 3600_000).unref();

export async function idempotent<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  fn: () => Promise<{ status?: number; payload: T; headers?: Record<string, string> }>,
) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED');
  const scope = `${req.principal?.sub}:${key}`;
  const bodyHash = sha256(req.method + req.url + JSON.stringify(req.body ?? null));
  const hit = store.get(scope);
  if (hit) {
    if (hit.bodyHash !== bodyHash) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED');
    reply.headers({ ...hit.headers, 'idempotent-replay': 'true' });
    return reply.code(hit.status).send(hit.payload);
  }
  const res = await fn();
  const status = res.status ?? 200;
  store.set(scope, { bodyHash, status, payload: res.payload, headers: res.headers ?? {}, at: Date.now() });
  reply.headers(res.headers ?? {});
  return reply.code(status).send(res.payload);
}

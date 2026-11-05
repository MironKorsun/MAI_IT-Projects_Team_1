import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { ApiError } from './errors';
import { verifyAccess } from './auth';
import { registerSocket } from './events';
import { db, commitNow } from './db';
import { ping } from './store';
import authRoutes from './routes/auth';
import examRoutes from './routes/exam';
import roomRoutes from './routes/rooms';
import adminRoutes from './routes/admin';
import monitoringRoutes from './routes/monitoring';
import resultsRoutes from './routes/results';
import analyticsRoutes from './routes/analytics';
import publicRoutes from './routes/public';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** HTTP-заголовки раздачи Клиентской части (ТЗ КЧ NFR-16, NFR-33). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export async function buildApp() {
  const app = Fastify({
    // JSON-журнал с requestId (NFR-44); секреты не попадают в журнал (NFR-23): адрес без строки запроса
    logger: config.production
      ? {
          level: 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-workstation-secret"]', 'res.headers["set-cookie"]'],
          serializers: { req: (req) => ({ method: req.method, url: req.url.split('?')[0], requestId: req.id }) },
        }
      : false,
    // Тайм-аут обработки запроса 8 с → 503 (ТЗ СЧ, табл. 7.1)
    connectionTimeout: 0,
    requestTimeout: 8000,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && UUID.test(h) ? h : randomUUID();
    },
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: true } },
  });

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Изменяющий запрос подтверждается клиенту только после фиксации в PostgreSQL (ТЗ СЧ NFR-09, NFR-10).
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return payload;
    try {
      await commitNow();
      return payload;
    } catch (e) {
      req.log?.error(e);
      if (!config.production) console.error('PostgreSQL:', (e as Error).message);
      const err = new ApiError(503, 'OVERLOADED', 'Хранилище временно недоступно, повторите запрос');
      reply.code(503).type('application/problem+json').header('retry-after', '2');
      return JSON.stringify(err.toProblem(req.url.split('?')[0], req.id));
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
  });

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    let apiErr: ApiError;
    if (err instanceof ApiError) apiErr = err;
    else if ((err as FastifyError).validation) {
      apiErr = new ApiError(400, 'VALIDATION_FAILED', 'Тело или параметры запроса не соответствуют схеме', {
        errors: (err as FastifyError).validation!.map((v) => ({
          pointer: v.instancePath || '/',
          detail: `${v.instancePath || 'тело'}: ${v.message}`,
        })),
      });
    } else if ((err as FastifyError).statusCode === 413) apiErr = new ApiError(413, 'VALIDATION_FAILED', 'Слишком большое тело запроса');
    else if ((err as FastifyError).code === 'FST_ERR_REQUEST_TIMEOUT') apiErr = new ApiError(503, 'OVERLOADED', 'Запрос не обработан за 8 с, повторите позже');
    else if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500)
      apiErr = new ApiError((err as FastifyError).statusCode!, 'VALIDATION_FAILED', 'Некорректный запрос');
    else {
      req.log?.error(err);
      if (!config.production) console.error(err);
      apiErr = new ApiError(500, 'INTERNAL_ERROR');
    }
    if (apiErr.status === 429 || apiErr.status === 503) reply.header('retry-after', String((apiErr.extra as { retryAfter?: number }).retryAfter ?? 2));
    reply.code(apiErr.status).type('application/problem+json').send(apiErr.toProblem(req.url.split('?')[0], req.id));
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(examRoutes);
      await api.register(roomRoutes);
      await api.register(adminRoutes);
      await api.register(monitoringRoutes);
      await api.register(resultsRoutes);
      await api.register(analyticsRoutes);
      await api.register(publicRoutes);
      api.get('/time', async () => ({ serverTime: new Date().toISOString() }));
    },
    { prefix: '/api/v1' },
  );

  app.get('/ws/v1', { websocket: true }, (socket) => {
    registerSocket(socket, verifyAccess, (p) => {
      if (p.kind !== 'participant') return;
      const a = db.attempts.find((x) => x.id === p.attemptId);
      if (a) {
        a.lastSeenAt = new Date().toISOString();
        if (a.state === 'inProgress') a.lastSeenInTime = a.lastSeenAt;
      }
    });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    try {
      await ping();
      return { status: 'ok', attempts: db.attempts.length };
    } catch {
      return reply.code(503).send({ status: 'unavailable', storage: 'postgresql' });
    }
  });

  if (existsSync(config.webDist)) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: true,
      cacheControl: false,
      setHeaders(res, path) {
        res.setHeader('content-security-policy', CSP);
        res.setHeader(
          'cache-control',
          /[\\/]assets[\\/].+-[A-Za-z0-9_-]{8}\.(js|css|woff2?|svg|png)$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) {
        return reply.code(404).type('application/problem+json').send(new ApiError(404, 'NOT_FOUND').toProblem(req.url, req.id));
      }
      reply.header('content-security-policy', CSP).header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) =>
      reply.code(404).type('application/problem+json').send(new ApiError(404, 'NOT_FOUND').toProblem(req.url, req.id)),
    );
  }

  return app;
}

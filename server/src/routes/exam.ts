import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FINAL_STATES, type WorkstationCheck } from '../../../shared/types';
import { isShortFormatValid } from '../../../shared/format';
import { db, byId, persist, type Attempt } from '../db';
import { ApiError, notFound, invalid } from '../errors';
import { audit } from '../audit';
import { emit } from '../events';
import { authenticate, requireKind } from '../auth';
import { attemptStateDto, endsAt, seatParticipant, sessionTitle } from '../views';
import { unwrapVariantKey } from '../kim/crypto';
import { gradeAttempt } from '../grading';
import { addMinutes, nowIso, sha256 } from '../util';
import { config } from '../config';
import { idempotent } from './idempotency';

/** Компонент С2 «Попытки» и С3 «КИМ» для модуля М1 (ТЗ СЧ FR-09–FR-21, FR-29–FR-31). */

/** Дата ГГГГ-ММ-ДД в часовом поясе ППЭ. */
export function localDate(tz: string, at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Секрет рабочего места действует только в день сессии по времени ППЭ (ТЗ СЧ FR-09). */
function workstationBySecret(req: FastifyRequest) {
  const s = req.headers['x-workstation-secret'];
  const ws = typeof s === 'string' ? db.workstations.find((w) => w.secret === s) : undefined;
  if (!ws) throw new ApiError(401, 'TOKEN_INVALID', 'Нет секрета рабочего места');
  const room = byId(db.rooms, ws.roomId);
  const session = room && byId(db.sessions, room.sessionId);
  const ppe = room && byId(db.ppes, room.ppeId);
  if (!session || localDate(ppe?.tz ?? session.tz) !== session.date) throw new ApiError(401, 'TOKEN_INVALID', 'Секрет рабочего места действует только в день экзамена');
  return ws;
}

/** Попытка участника; обращение к чужой — 404 и запись в журнале (FR-06). */
function ownAttempt(req: FastifyRequest<{ Params: { id: string } }>): Attempt {
  const p = req.principal!;
  const a = byId(db.attempts, req.params.id);
  if (!a || a.id !== p.attemptId) {
    audit({ type: 'access.denied', category: 'Аутентификация', actorRole: p.kind, actorId: p.sub, object: req.params.id, requestId: req.id, result: 'error' });
    throw notFound();
  }
  const now = Date.now();
  if (a.lastSeenAt) {
    const gap = (now - new Date(a.lastSeenAt).getTime()) / 1000;
    if (gap > 60 && a.state === 'inProgress') a.downtimeSec += gap;
  }
  a.lastSeenAt = nowIso();
  // Любое обращение клиента до окончания времени — для правила (б) окна приёма (ТЗ СЧ FR-17)
  const end = endsAt(a);
  if (a.state === 'inProgress' && end && now <= new Date(end).getTime()) a.lastSeenInTime = a.lastSeenAt;
  return a;
}

function assertState(a: Attempt, ...allowed: Attempt['state'][]) {
  if (FINAL_STATES.includes(a.state)) throw new ApiError(409, 'ATTEMPT_CLOSED');
  if (!allowed.includes(a.state)) throw new ApiError(409, 'INVALID_STATE');
}

function broadcastStatus(a: Attempt) {
  emit('participant.statusChanged', a.id, { workstationId: a.workstationId, participant: seatParticipant(a) }, { roomId: a.roomId, attemptId: a.id });
}

/** Окно приёма изменений после окончания времени (ТЗ СЧ FR-17, ТС-08). */
export function acceptLate(a: Attempt, changedAt: string): boolean {
  const end = endsAt(a);
  if (!end) return false;
  const endMs = new Date(end).getTime();
  const changedMs = new Date(changedAt).getTime();
  const now = Date.now();
  if (!(changedMs <= endMs)) return false;
  if (now <= endMs + config.lateWindowSec * 1000) return true;
  if (now > endMs + config.offlineWindowSec * 1000) return false;
  const seen = a.lastSeenInTime ? new Date(a.lastSeenInTime).getTime() : 0;
  return seen <= changedMs;
}

export default async function examRoutes(app: FastifyInstance) {
  // ---------- рабочее место ----------
  app.get('/workstations/self', async (req) => {
    const ws = workstationBySecret(req);
    const room = byId(db.rooms, ws.roomId)!;
    const session = byId(db.sessions, room.sessionId)!;
    const ppe = byId(db.ppes, room.ppeId)!;
    return {
      workstationId: ws.id,
      label: ws.label,
      room: { id: room.id, number: room.number, ppeCode: ppe.code, ppeName: ppe.name, tz: ppe.tz },
      session: { title: sessionTitle(session), date: session.date, startLocal: session.startLocal, proctoring: session.proctoring },
      hasAudio: false,
      check: ws.check,
    };
  });

  app.post<{ Params: { id: string }; Body: WorkstationCheck }>(
    '/workstations/:id/check',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['browser', 'screen', 'fullscreen', 'latencyMs', 'kimPreloaded', 'passed'],
          properties: {
            browser: { type: 'boolean' },
            screen: { type: 'boolean' },
            fullscreen: { type: 'boolean' },
            latencyMs: { type: 'number' },
            kimPreloaded: { type: 'boolean' },
            passed: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const ws = workstationBySecret(req);
      if (ws.id !== req.params.id) throw notFound();
      ws.check = { passed: req.body.passed, at: nowIso(), details: req.body };
      audit({ type: 'workstation.checked', category: 'Аудитория', actorRole: 'workstation', object: ws.label, roomId: ws.roomId, ppeId: byId(db.rooms, ws.roomId)?.ppeId, result: req.body.passed ? 'ok' : 'error' });
      emit('workstation.checked', ws.id, { workstationId: ws.id, check: ws.check }, { roomId: ws.roomId });
      persist();
      return ws.check;
    },
  );

  /** Зашифрованный пакет вариантов аудитории; поддержка Range для докачки (FR-30). */
  app.get<{ Params: { id: string } }>('/rooms/:id/kim-package', async (req, reply) => {
    const ws = workstationBySecret(req);
    if (ws.roomId !== req.params.id) throw notFound();
    const room = byId(db.rooms, ws.roomId)!;
    const session = byId(db.sessions, room.sessionId)!;
    const variants = session.variantIds.map((id) => byId(db.variants, id)!).filter(Boolean);
    const body = Buffer.from(
      JSON.stringify({ roomId: room.id, variants: variants.map((v) => ({ variantId: v.id, iv: v.encrypted.iv, data: v.encrypted.data, checksum: v.checksum })) }),
    );
    const etag = `"${sha256(body).slice(0, 32)}"`;
    reply.header('etag', etag).header('accept-ranges', 'bytes').header('cache-control', 'private, no-store');
    const range = req.headers.range;
    const m = typeof range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
      if (start >= body.length) return reply.code(416).header('content-range', `bytes */${body.length}`).send();
      return reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${body.length}`)
        .type('application/octet-stream')
        .send(body.subarray(start, end + 1));
    }
    return reply.type('application/json').send(body);
  });

  // ---------- попытка ----------
  app.get<{ Params: { id: string } }>('/attempts/:id/state', { preHandler: requireKind('participant') }, async (req) => {
    const a = ownAttempt(req);
    return attemptStateDto(a);
  });

  /** Ключ варианта только после старта аудитории; на соседних местах — разные варианты (FR-31). */
  app.get<{ Params: { id: string } }>('/attempts/:id/kim-key', { preHandler: requireKind('participant') }, async (req) => {
    const a = ownAttempt(req);
    const room = byId(db.rooms, a.roomId)!;
    // Конечное состояние — только чтение (ТЗ СЧ, таблица 5.3)
    if (FINAL_STATES.includes(a.state)) throw new ApiError(409, 'ATTEMPT_CLOSED');
    if (!room.startedAt || !['loading', 'inProgress'].includes(a.state)) {
      audit({ type: 'kim.keyDenied', category: 'Ход попытки', actorRole: 'participant', actorId: a.participantId, object: a.id, roomId: room.id, ppeId: room.ppeId, result: 'error' });
      throw new ApiError(403, 'KIM_NOT_AVAILABLE', 'Экзамен в аудитории ещё не начат');
    }
    const session = byId(db.sessions, a.sessionId)!;
    if (!a.variantId) {
      const seats = db.workstations.filter((w) => w.roomId === room.id);
      const idx = seats.findIndex((w) => w.id === a.workstationId);
      const neighbours = [seats[idx - 1], seats[idx + 1]]
        .filter(Boolean)
        .map((w) => db.attempts.find((x) => x.workstationId === w.id)?.variantId)
        .filter(Boolean);
      const options = session.variantIds.filter((v) => !neighbours.includes(v));
      const pool = options.length ? options : session.variantIds;
      a.variantId = pool[Math.floor(Math.random() * pool.length)];
    }
    const v = byId(db.variants, a.variantId)!;
    const key = unwrapVariantKey(v.wrappedKey);
    audit({ type: 'kim.keyIssued', category: 'Ход попытки', actorRole: 'participant', actorId: a.participantId, object: `вариант ${v.number}`, roomId: room.id, ppeId: room.ppeId });
    persist();
    return { variantId: v.id, number: v.number, key: key.toString('base64'), alg: 'AES-GCM' };
  });

  /** Подтверждение готовности, фиксация T0 (FR-13). */
  app.post<{ Params: { id: string } }>('/attempts/:id/ready', { preHandler: requireKind('participant') }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = ownAttempt(req);
      if (a.state === 'inProgress') return { payload: { state: a.state, startedAt: a.t0, endsAt: endsAt(a) } };
      assertState(a, 'loading');
      if (!a.variantId) throw new ApiError(409, 'INVALID_STATE', 'Ключ варианта не запрошен');
      const session = byId(db.sessions, a.sessionId)!;
      const room = byId(db.rooms, a.roomId)!;
      const p = byId(db.participants, a.participantId)!;
      const lateJoin = a.loggedInAt && room.startedAt && a.loggedInAt > room.startedAt;
      a.t0 = lateJoin ? room.startedAt! : nowIso();
      a.readyAt = nowIso();
      a.baseEndsAt = addMinutes(a.t0, session.durationMin + (p.specialConditions.extraTime ? 90 : 0));
      a.state = 'inProgress';
      a.lastSeenInTime = nowIso();
      audit({ type: 'attempt.ready', category: 'Ход попытки', actorRole: 'participant', actorId: p.id, object: a.id, roomId: room.id, ppeId: room.ppeId });
      broadcastStatus(a);
      persist();
      return { payload: { state: a.state, startedAt: a.t0, endsAt: endsAt(a) } };
    }),
  );

  /** Сохранение ответа: формат, seq, If-Match, окно приёма (FR-14–FR-17). */
  app.put<{
    Params: { id: string; taskId: string };
    Body: { kind: 'short'; value: string; seq: number; changedAtServerClock: string; final?: boolean };
  }>(
    '/attempts/:id/answers/:taskId',
    {
      preHandler: requireKind('participant'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'value', 'seq', 'changedAtServerClock'],
          properties: {
            kind: { type: 'string', enum: ['short'] },
            value: { type: 'string', maxLength: 50 },
            seq: { type: 'integer', minimum: 1 },
            changedAtServerClock: { type: 'string', format: 'date-time' },
            final: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, async () => {
        const a = ownAttempt(req);
        const { kind, value, seq, changedAtServerClock } = req.body;
        let late = false;
        if (a.state === 'timeExpired') {
          if (!acceptLate(a, changedAtServerClock)) throw new ApiError(409, 'ATTEMPT_CLOSED');
          late = true;
        } else assertState(a, 'inProgress');
        const variant = byId(db.variants, a.variantId)!;
        const task = variant.keys.find((t) => t.id === req.params.taskId);
        if (!task) throw notFound();
        if (task.type !== kind) throw invalid([{ pointer: '/kind', detail: 'Тип ответа не соответствует заданию' }]);
        if (kind === 'short' && value !== '' && !isShortFormatValid(task.format ?? 'decimal', value))
          throw invalid([{ pointer: '/value', detail: 'Ответ не соответствует формату задания' }], 'VALIDATION_FAILED', 400);
        const current = a.answers[task.id];
        const ifMatch = req.headers['if-match'];
        // seq сравнивается с принятым изменением этого же задания: изменение другого задания не теряется (ТЗ СЧ FR-15)
        if (current && seq <= current.seq) {
          return { payload: { taskId: task.id, version: current.version, status: 'stale', savedAt: current.savedAt }, headers: { etag: `"v${current.version}"` } };
        }
        if (typeof ifMatch === 'string' && current && ifMatch !== `"v${current.version}"` && ifMatch !== '*') {
          throw new ApiError(412, 'VERSION_MISMATCH', undefined, { currentVersion: current.version });
        }
        const version = (current?.version ?? 0) + 1;
        const rec = { kind, value, version, seq, savedAt: nowIso(), changedAtServerClock, late };
        a.answers[task.id] = rec;
        (a.answerHistory[task.id] ??= []).push(rec);
        a.lastSeq = Math.max(a.lastSeq, seq);
        a.lastTaskId = task.id;
        if (late) {
          const room = byId(db.rooms, a.roomId)!;
          audit({ type: 'answer.lateAccepted', category: 'Ход попытки', actorRole: 'participant', actorId: a.participantId, object: `${a.id}/${task.number}`, roomId: room.id, ppeId: room.ppeId, details: `изменение ${changedAtServerClock}` });
        }
        broadcastStatus(a);
        persist();
        return { payload: { taskId: task.id, version, status: 'saved', savedAt: rec.savedAt }, headers: { etag: `"v${version}"` } };
      }),
  );

  app.put<{ Params: { id: string; taskId: string }; Body: { text: string } }>(
    '/attempts/:id/notes/:taskId',
    {
      preHandler: requireKind('participant'),
      schema: { body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 5000 } } } },
    },
    async (req, reply) =>
      idempotent(req, reply, async () => {
        const a = ownAttempt(req);
        assertState(a, 'inProgress');
        a.notes[req.params.taskId] = req.body.text;
        persist();
        return { payload: { taskId: req.params.taskId, savedAt: nowIso() } };
      }),
  );

  /** Отметки для возврата и последнее открытое задание (FR-12, FR-15 ТЗ КЧ). */
  app.patch<{ Params: { id: string }; Body: { flags?: string[]; lastTaskId?: string } }>(
    '/attempts/:id/ui',
    {
      preHandler: requireKind('participant'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { flags: { type: 'array', maxItems: 50, items: { type: 'string' } }, lastTaskId: { type: 'string' } },
        },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, async () => {
        const a = ownAttempt(req);
        assertState(a, 'inProgress');
        if (req.body.flags) a.flags = req.body.flags;
        if (req.body.lastTaskId) a.lastTaskId = req.body.lastTaskId;
        persist();
        return { payload: { flags: a.flags, lastTaskId: a.lastTaskId } };
      }),
  );

  /** События целостности, до 50 в пакете (FR-19). */
  app.post<{ Params: { id: string }; Body: { events: { type: string; at: string }[] } }>(
    '/attempts/:id/events',
    {
      preHandler: requireKind('participant'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['events'],
          properties: {
            events: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'at'],
                properties: {
                  type: { type: 'string', enum: ['fullscreenExit', 'visibilityHidden', 'windowBlur', 'copy', 'paste', 'print', 'contextMenu'] },
                  at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, async () => {
        const a = ownAttempt(req);
        const room = byId(db.rooms, a.roomId)!;
        for (const e of req.body.events) {
          const rec = { type: e.type, at: e.at, receivedAt: nowIso() };
          a.integrity.push(rec);
          audit({ type: `integrity.${e.type}`, category: 'Целостность', actorRole: 'participant', actorId: a.participantId, object: a.id, roomId: room.id, ppeId: room.ppeId });
          emit('integrity.event', a.id, { attemptId: a.id, workstationId: a.workstationId, type: e.type, at: e.at }, { roomId: room.id });
        }
        persist();
        return { payload: { accepted: req.body.events.length } };
      }),
  );

  /** Завершение попытки участником (FR-20). */
  app.post<{ Params: { id: string } }>('/attempts/:id/finish', { preHandler: requireKind('participant') }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = ownAttempt(req);
      if (a.state === 'finished') return { payload: { state: a.state, finishedAt: a.finishedAt } };
      assertState(a, 'inProgress');
      a.state = 'finished';
      a.finishedAt = nowIso();
      const room = byId(db.rooms, a.roomId)!;
      audit({ type: 'attempt.finished', category: 'Ход попытки', actorRole: 'participant', actorId: a.participantId, object: a.id, roomId: room.id, ppeId: room.ppeId });
      broadcastStatus(a);
      gradeAttempt(a);
      persist();
      return { payload: { state: a.state, finishedAt: a.finishedAt } };
    }),
  );

  /** Телеметрия RUM (FR-54): поля вне схемы отклоняются, ПДн не принимаются. */
  app.post<{ Body: { metrics: { name: string; value: number }[]; errors?: { message: string }[]; module: string } }>(
    '/telemetry',
    {
      bodyLimit: 64 * 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['module', 'metrics'],
          properties: {
            module: { type: 'string', enum: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'portal', 'analytics'] },
            metrics: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'value'],
                properties: { name: { type: 'string', maxLength: 40 }, value: { type: 'number' } },
              },
            },
            errors: {
              type: 'array',
              maxItems: 20,
              items: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', maxLength: 500 } } },
            },
          },
        },
      },
    },
    async (req) => {
      try {
        await authenticate(req);
      } catch {
        /* телеметрия принимается и без сеанса */
      }
      db.telemetry.push({ at: nowIso(), size: JSON.stringify(req.body).length, kind: req.body.module });
      if (db.telemetry.length > 5000) db.telemetry.splice(0, db.telemetry.length - 5000);
      const participants = db.attempts.filter((a) => a.state === 'inProgress').length;
      return { sampleRate: participants > 10_000 ? 0.05 : 1 };
    },
  );
}

/** Порог подготовки варианта после старта (ТЗ КЧ FR-04, табл. 7.1) и порог «без связи» (ТЗ КЧ FR-25). */
export const PREP_TIMEOUT_MS = 60_000;
export const OFFLINE_AFTER_MS = 60_000;
/** Попытки, о которых организатор уже уведомлён: повторно не рассылаются. */
const prepNotified = new Set<string>();
const offlineNotified = new Set<string>();

/**
 * Сторож попыток (выполняется планировщиком каждую секунду):
 * — подготовка варианта не завершена за 60 с после старта — событие организатору и запись в журнале (ТЗ КЧ FR-04);
 * — нет обращений клиента более 60 с — событие с признаком offline, при восстановлении — повторное (ТЗ КЧ FR-25).
 */
export function watchdogTick(now = Date.now()) {
  for (const a of db.attempts) {
    if (a.state === 'loading') {
      const room = byId(db.rooms, a.roomId);
      if (room?.startedAt && !prepNotified.has(a.id)) {
        const since = Math.max(new Date(room.startedAt).getTime(), a.loggedInAt ? new Date(a.loggedInAt).getTime() : 0);
        if (now - since > PREP_TIMEOUT_MS) {
          prepNotified.add(a.id);
          audit({ type: 'attempt.prepTimeout', category: 'Ход попытки', actorRole: 'system', object: a.id, roomId: room.id, ppeId: room.ppeId, result: 'error', details: 'Вариант не подготовлен за 60 с после старта' });
          emit('participant.statusChanged', a.id, { workstationId: a.workstationId, participant: seatParticipant(a), prepTimeout: true }, { roomId: a.roomId });
        }
      }
    }
    if (a.state === 'inProgress' || a.state === 'loading') {
      const off = !a.lastSeenAt || now - new Date(a.lastSeenAt).getTime() > OFFLINE_AFTER_MS;
      if (off !== offlineNotified.has(a.id)) {
        if (off) offlineNotified.add(a.id);
        else offlineNotified.delete(a.id);
        emit('participant.statusChanged', a.id, { workstationId: a.workstationId, participant: seatParticipant(a), offline: off }, { roomId: a.roomId });
      }
    } else offlineNotified.delete(a.id);
  }
}

/** Попытка получила уведомление о затянувшейся подготовке (для проверок и клиента). */
export const prepTimeoutNotified = (attemptId: string) => prepNotified.has(attemptId);

/** Планировщик: истечение времени и передача на проверку после закрытия окна приёма (FR-21); сторож попыток. */
export function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    watchdogTick(now);
    for (const a of db.attempts) {
      if (a.state === 'inProgress') {
        const end = endsAt(a);
        if (end && new Date(end).getTime() <= now) {
          a.state = 'timeExpired';
          a.finishedAt = end;
          const room = byId(db.rooms, a.roomId)!;
          audit({ type: 'attempt.timeExpired', category: 'Ход попытки', actorRole: 'system', object: a.id, roomId: room.id, ppeId: room.ppeId });
          emit('participant.statusChanged', a.id, { workstationId: a.workstationId, participant: seatParticipant(a) }, { roomId: a.roomId });
          persist();
        }
      } else if (a.state === 'timeExpired' && !a.graded) {
        const end = endsAt(a);
        if (end && now > new Date(end).getTime() + config.offlineWindowSec * 1000) gradeAttempt(a);
      }
    }
  }, 1000).unref();
}

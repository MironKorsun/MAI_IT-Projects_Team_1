import type { FastifyInstance, FastifyRequest } from 'fastify';
import { FINAL_STATES } from '../../../shared/types';
import { db, byId, persist, type Attempt, type Room } from '../db';
import { ApiError, notFound, invalid } from '../errors';
import { audit } from '../audit';
import { emit } from '../events';
import { requireStaff, revokeAttemptSessions } from '../auth';
import { endsAt, roomDto, seatParticipant } from '../views';
import { COMPENSATION_REASONS, EARLY_FINISH_REASONS, INCIDENT_TYPES } from '../exams';
import { digits, nowIso, uuid } from '../util';

/** Компонент С2 для модулей М2 «Аудитория» и М5 «Мониторинг» (ТЗ СЧ FR-11, FR-12, FR-22–FR-27). */

function canSeeRoom(req: FastifyRequest, room: Room, write: boolean) {
  const p = req.principal!;
  if (write) return p.roles.includes('organizer') && room.organizerIds.includes(p.sub);
  return p.roles.includes('observer') || p.roles.includes('admin') || room.organizerIds.includes(p.sub);
}

function roomFor(req: FastifyRequest<{ Params: { id: string } }>, write = false) {
  const room = byId(db.rooms, req.params.id);
  if (!room || !canSeeRoom(req, room, write)) {
    if (room) audit({ type: 'access.denied', category: 'Аутентификация', actorRole: 'staff', actorId: req.principal?.sub, object: room.id, requestId: req.id, result: 'error' });
    throw notFound();
  }
  return room;
}

function attemptForOrganizer(req: FastifyRequest<{ Params: { id: string } }>) {
  const a = byId(db.attempts, req.params.id);
  const room = a && byId(db.rooms, a.roomId);
  if (!a || !room || !room.organizerIds.includes(req.principal!.sub)) throw notFound();
  return { a, room };
}

function status(a: Attempt) {
  emit('participant.statusChanged', a.id, { workstationId: a.workstationId, participant: seatParticipant(a) }, { roomId: a.roomId });
}

const staffAudit = (req: FastifyRequest, type: string, category: string, room: Room, object?: string, details?: string) =>
  audit({ type, category, actorRole: 'organizer', actorId: req.principal!.sub, object, roomId: room.id, ppeId: room.ppeId, requestId: req.id, details });

export default async function roomRoutes(app: FastifyInstance) {
  app.get('/dictionaries', { preHandler: requireStaff() }, async () => ({
    incidentTypes: INCIDENT_TYPES,
    compensationReasons: COMPENSATION_REASONS,
    earlyFinishReasons: EARLY_FINISH_REASONS,
  }));

  /** Аудитории, доступные роли. */
  app.get('/rooms', { preHandler: requireStaff('organizer', 'observer', 'admin') }, async (req) => {
    const list = db.rooms.filter((r) => canSeeRoom(req, r, false));
    return list.map((r) => {
      const d = roomDto(r, false);
      return { id: d.id, number: d.number, ppe: d.ppe, session: d.session, startedAt: d.startedAt, seats: d.seats.length, participants: d.seats.filter((s) => s.participant).length };
    });
  });

  app.get<{ Params: { id: string } }>('/rooms/:id', { preHandler: requireStaff('organizer', 'observer', 'admin') }, async (req) => {
    const room = roomFor(req);
    return roomDto(room, room.organizerIds.includes(req.principal!.sub));
  });

  /** Выпуск кода аудитории с аннулированием прежнего (FR-11). */
  app.post<{ Params: { id: string } }>('/rooms/:id/access-code', { preHandler: requireStaff('organizer') }, async (req) => {
    const room = roomFor(req, true);
    if (room.startedAt && Date.now() - new Date(room.startedAt).getTime() > 15 * 60_000)
      throw new ApiError(409, 'INVALID_STATE', 'Код не выпускается позднее 15 минут после старта');
    let code = digits(6);
    while (code === room.accessCode) code = digits(6);
    const had = !!room.accessCode;
    room.accessCode = code;
    room.accessCodeIssuedAt = nowIso();
    staffAudit(req, had ? 'room.accessCodeReissued' : 'room.accessCodeIssued', 'Аудитория', room, room.number);
    persist();
    return { accessCode: code, issuedAt: room.accessCodeIssuedAt };
  });

  /** Старт экзамена в аудитории (FR-12). */
  app.post<{ Params: { id: string } }>('/rooms/:id/start', { preHandler: requireStaff('organizer') }, async (req) => {
    const room = roomFor(req, true);
    if (room.startedAt) throw new ApiError(409, 'ROOM_ALREADY_STARTED');
    room.startedAt = nowIso();
    const session = byId(db.sessions, room.sessionId)!;
    if (session.status === 'preparation') session.status = 'active';
    const absent: string[] = [];
    for (const a of db.attempts.filter((x) => x.roomId === room.id)) {
      if (a.state === 'waiting') {
        a.state = 'loading';
        status(a);
      } else if (a.state === 'assigned') absent.push(a.id);
    }
    staffAudit(req, 'room.started', 'Аудитория', room, room.number, `Отсутствуют: ${absent.length}`);
    emit('room.started', room.id, { startedAt: room.startedAt }, { roomId: room.id });
    persist();
    return { startedAt: room.startedAt, absent: absent.length };
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    '/rooms/:id/messages',
    {
      preHandler: requireStaff('organizer'),
      schema: { body: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 500 } } } },
    },
    async (req) => {
      const room = roomFor(req, true);
      const msg = { id: uuid(), text: req.body.text.trim(), at: nowIso() };
      room.messages.push(msg);
      staffAudit(req, 'room.message', 'Аудитория', room, room.number);
      emit('room.message', room.id, msg, { roomId: room.id });
      persist();
      return msg;
    },
  );

  /** Компенсация времени простоя: не больше простоя по данным сервера (FR-22). */
  app.post<{ Params: { id: string }; Body: { minutes: number; reason: string } }>(
    '/attempts/:id/time-compensation',
    {
      preHandler: requireStaff('organizer'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['minutes', 'reason'],
          properties: { minutes: { type: 'integer', minimum: 1 }, reason: { type: 'string', enum: COMPENSATION_REASONS } },
        },
      },
    },
    async (req) => {
      const { a, room } = attemptForOrganizer(req);
      if (a.state !== 'inProgress') throw new ApiError(409, 'INVALID_STATE');
      const used = a.compensations.reduce((s, c) => s + c.minutes, 0);
      // Простой по данным сервера, включая текущий интервал без запросов дольше 60 с (ТЗ СЧ FR-22)
      const gap = a.lastSeenAt ? (Date.now() - new Date(a.lastSeenAt).getTime()) / 1000 : 0;
      const available = Math.floor((a.downtimeSec + (gap > 60 ? gap : 0)) / 60) - used;
      if (req.body.minutes > available)
        throw new ApiError(422, 'COMPENSATION_EXCEEDS_DOWNTIME', `Простой по данным сервера: ${Math.max(available, 0)} мин`, { availableMinutes: Math.max(available, 0) });
      a.compensations.push({ minutes: req.body.minutes, reason: req.body.reason, at: nowIso(), by: req.principal!.sub });
      a.compensationMin += req.body.minutes;
      staffAudit(req, 'attempt.timeCompensated', 'Ход попытки', room, a.id, `${req.body.minutes} мин: ${req.body.reason}`);
      emit('attempt.timeChanged', a.id, { endsAt: endsAt(a), reason: req.body.reason }, { attemptId: a.id });
      status(a);
      persist();
      return { endsAt: endsAt(a) };
    },
  );

  /** Акт о нарушении → «Удалён» (FR-23). */
  app.post<{ Params: { id: string }; Body: { type: string; description: string; at?: string } }>(
    '/attempts/:id/incidents',
    {
      preHandler: requireStaff('organizer'),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'description'],
          properties: {
            type: { type: 'string', enum: INCIDENT_TYPES },
            description: { type: 'string', minLength: 1, maxLength: 2000 },
            at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (req) => {
      const { a, room } = attemptForOrganizer(req);
      if (!['waiting', 'loading', 'inProgress'].includes(a.state)) throw new ApiError(409, FINAL_STATES.includes(a.state) ? 'ATTEMPT_CLOSED' : 'INVALID_STATE');
      a.incident = { type: req.body.type, description: req.body.description, at: req.body.at ?? nowIso(), by: req.principal!.sub };
      a.state = 'removed';
      a.finishedAt = nowIso();
      a.terminationMessage = `Экзамен прекращён организатором: ${req.body.type.toLowerCase()}. Составлен акт об удалении.`;
      staffAudit(req, 'attempt.incident', 'Ход попытки', room, a.id, req.body.type);
      emit('attempt.terminated', a.id, { state: a.state, message: a.terminationMessage }, { attemptId: a.id });
      status(a);
      persist();
      return { state: a.state };
    },
  );

  /** Завершение по объективной причине (FR-24). */
  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/attempts/:id/early-finish',
    {
      preHandler: requireStaff('organizer'),
      schema: { body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', enum: EARLY_FINISH_REASONS } } } },
    },
    async (req) => {
      const { a, room } = attemptForOrganizer(req);
      if (!['loading', 'inProgress'].includes(a.state)) throw new ApiError(409, FINAL_STATES.includes(a.state) ? 'ATTEMPT_CLOSED' : 'INVALID_STATE');
      a.state = 'notCompleted';
      a.earlyFinishReason = req.body.reason;
      a.finishedAt = nowIso();
      a.terminationMessage = `Экзамен завершён по объективной причине: ${req.body.reason.toLowerCase()}. Ответы сохранены.`;
      staffAudit(req, 'attempt.earlyFinish', 'Ход попытки', room, a.id, req.body.reason);
      emit('attempt.terminated', a.id, { state: a.state, message: a.terminationMessage }, { attemptId: a.id });
      status(a);
      persist();
      return { state: a.state };
    },
  );

  /** Перевод на свободное проверенное место той же аудитории (FR-25). */
  app.post<{ Params: { id: string }; Body: { workstationId: string } }>(
    '/attempts/:id/relocate',
    {
      preHandler: requireStaff('organizer'),
      schema: { body: { type: 'object', additionalProperties: false, required: ['workstationId'], properties: { workstationId: { type: 'string' } } } },
    },
    async (req) => {
      const { a, room } = attemptForOrganizer(req);
      if (FINAL_STATES.includes(a.state)) throw new ApiError(409, 'ATTEMPT_CLOSED');
      const ws = byId(db.workstations, req.body.workstationId);
      if (!ws || ws.roomId !== room.id) throw invalid([{ pointer: '/workstationId', detail: 'Место не принадлежит аудитории' }], 'VALIDATION_FAILED', 422);
      if (!ws.check?.passed) throw invalid([{ pointer: '/workstationId', detail: 'Место не прошло проверку' }], 'VALIDATION_FAILED', 422);
      if (db.attempts.some((x) => x.workstationId === ws.id && x.id !== a.id))
        throw invalid([{ pointer: '/workstationId', detail: 'Место занято' }], 'VALIDATION_FAILED', 422);
      const from = byId(db.workstations, a.workstationId)?.label;
      a.workstationId = ws.id;
      revokeAttemptSessions(a.id);
      staffAudit(req, 'attempt.relocated', 'Ход попытки', room, a.id, `${from} → ${ws.label}`);
      status(a);
      persist();
      return { workstationId: ws.id, label: ws.label };
    },
  );
}

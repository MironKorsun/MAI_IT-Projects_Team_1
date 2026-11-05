import type { FastifyInstance } from 'fastify';
import { db, byId, persist } from '../db';
import { ApiError } from '../errors';
import { audit } from '../audit';
import { emit } from '../events';
import {
  authenticate,
  checkLock,
  clearFailures,
  issue,
  logout,
  refresh,
  registerFailure,
  verifyPassword,
  type PrincipalKind,
} from '../auth';
import { accessCodeValid, displayName, seatParticipant } from '../views';
import { nowIso } from '../util';

const kindSchema = { type: 'string', enum: ['participant', 'staff', 'results'] };

export default async function authRoutes(app: FastifyInstance) {
  /** Вход участника по идентификатору и коду аудитории с проверенного рабочего места (ТЗ СЧ FR-01, FR-02). */
  app.post<{ Body: { participantCode: string; accessCode: string; workstationSecret: string } }>(
    '/auth/participant/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['participantCode', 'accessCode', 'workstationSecret'],
          properties: {
            participantCode: { type: 'string', maxLength: 32 },
            accessCode: { type: 'string', maxLength: 6 },
            workstationSecret: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req, reply) => {
      const { participantCode, accessCode, workstationSecret } = req.body;
      const ws = db.workstations.find((w) => w.secret === workstationSecret);
      if (!ws) throw new ApiError(401, 'INVALID_CREDENTIALS');
      const room = byId(db.rooms, ws.roomId)!;
      const lockKey = `ws:${ws.id}`;
      checkLock(lockKey);
      const participant = db.participants.find((p) => p.code === participantCode.trim());
      const attempt = participant && db.attempts.find((a) => a.participantId === participant.id && a.roomId === room.id);
      const ok =
        !!attempt && room.accessCode === accessCode &&
        // после пересадки (FR-25) вход по действующему коду допускается и позднее 15 мин после старта
        (accessCodeValid(room) || ['loading', 'inProgress'].includes(attempt.state)) &&
        ws.check?.passed !== false &&
        !['finished', 'timeExpired', 'removed', 'notCompleted'].includes(attempt.state);
      if (!ok || !attempt) {
        const locked = registerFailure(lockKey);
        audit({ type: 'auth.failed', category: 'Аутентификация', actorRole: 'participant', object: ws.label, ppeId: room.ppeId, roomId: room.id, requestId: req.id, result: 'error' });
        if (locked) {
          audit({ type: 'auth.lockout', category: 'Аутентификация', actorRole: 'system', object: ws.label, ppeId: room.ppeId, roomId: room.id });
          emit('auth.lockout', ws.id, { workstationId: ws.id, label: ws.label, until: new Date(Date.now() + 5 * 60_000).toISOString() }, { roomId: room.id });
        }
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Проверьте идентификатор участника и код аудитории');
      }
      clearFailures(lockKey);
      // Участник входит с любого проверенного места своей аудитории; попытка закрепляется за этим местом.
      if (attempt.workstationId !== ws.id) {
        const busy = db.attempts.find((a) => a.workstationId === ws.id && a.id !== attempt.id && !['finished', 'timeExpired', 'removed', 'notCompleted', 'assigned'].includes(a.state));
        if (busy) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Рабочее место занято другим участником');
        attempt.workstationId = ws.id;
      }
      if (attempt.state === 'assigned') attempt.state = room.startedAt ? 'loading' : 'waiting';
      attempt.loggedInAt = nowIso();
      attempt.lastSeenAt = nowIso();
      audit({ type: 'auth.login', category: 'Аутентификация', actorRole: 'participant', actorId: participant!.id, object: ws.label, ppeId: room.ppeId, roomId: room.id, requestId: req.id });
      persist();
      emit('participant.statusChanged', attempt.id, { workstationId: ws.id, participant: seatParticipant(attempt) }, { roomId: room.id });
      const tokens = await issue(reply, { kind: 'participant', sub: participant!.id, roles: [], attemptId: attempt.id, roomId: room.id });
      return { ...tokens, attemptId: attempt.id };
    },
  );

  /** Вход персонала (ТЗ СЧ FR-02, FR-03). */
  app.post<{ Body: { login: string; password: string } }>(
    '/auth/staff/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['login', 'password'],
          properties: { login: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 128 } },
        },
      },
    },
    async (req, reply) => {
      const login = req.body.login.trim().toLowerCase();
      const key = `staff:${login}`;
      checkLock(key);
      const user = db.staff.find((u) => u.login === login);
      if (!user || user.blocked || !verifyPassword(req.body.password, user.passwordHash)) {
        const locked = registerFailure(key);
        audit({ type: 'auth.failed', category: 'Аутентификация', actorRole: 'staff', object: login, requestId: req.id, result: 'error' });
        if (locked) audit({ type: 'auth.lockout', category: 'Аутентификация', actorRole: 'system', object: login });
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
      }
      clearFailures(key);
      audit({ type: 'auth.login', category: 'Аутентификация', actorRole: user.roles.join(','), actorId: user.id, requestId: req.id });
      const roomIds = db.rooms.filter((r) => r.organizerIds.includes(user.id)).map((r) => r.id);
      return issue(reply, { kind: 'staff', sub: user.id, roles: user.roles, roomIds });
    },
  );

  /** Вход участника вне ППЭ для просмотра результатов (М6). Учебное допущение: код участника + PIN. */
  app.post<{ Body: { participantCode: string; pin: string } }>(
    '/auth/results/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['participantCode', 'pin'],
          properties: { participantCode: { type: 'string', maxLength: 32 }, pin: { type: 'string', maxLength: 16 } },
        },
      },
    },
    async (req, reply) => {
      const code = req.body.participantCode.trim();
      const key = `results:${code}`;
      checkLock(key);
      const p = db.participants.find((x) => x.code === code);
      if (!p || !verifyPassword(req.body.pin, p.pinHash)) {
        registerFailure(key);
        audit({ type: 'auth.failed', category: 'Аутентификация', actorRole: 'participant', object: 'М6', requestId: req.id, result: 'error' });
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный код участника или PIN');
      }
      clearFailures(key);
      audit({ type: 'auth.login', category: 'Аутентификация', actorRole: 'participant', actorId: p.id, object: 'М6', requestId: req.id });
      return issue(reply, { kind: 'results', sub: p.id, roles: [] });
    },
  );

  app.post<{ Body: { kind: PrincipalKind } }>(
    '/auth/refresh',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: kindSchema } } } },
    async (req, reply) => refresh(req, reply, req.body.kind),
  );

  app.post<{ Body: { kind: PrincipalKind; reason?: string } }>(
    '/auth/logout',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: kindSchema, reason: { type: 'string', enum: ['user', 'idle'] } },
        },
      },
    },
    async (req, reply) => {
      try {
        await authenticate(req);
      } catch {
        /* выход возможен и с истёкшим маркером доступа */
      }
      logout(req, reply, req.body.kind);
      audit({
        type: req.body.reason === 'idle' ? 'auth.idleTimeout' : 'auth.logout',
        category: 'Аутентификация',
        actorRole: req.body.kind,
        actorId: req.principal?.sub,
        requestId: req.id,
      });
      return reply.code(204).send();
    },
  );

  /** Профиль без реквизитов документов (ТЗ СЧ FR-08). */
  app.get('/me', async (req) => {
    const p = await authenticate(req);
    if (p.kind === 'staff') {
      const u = byId(db.staff, p.sub)!;
      return { kind: 'staff', id: u.id, login: u.login, fullName: u.fullName, roles: u.roles, roomIds: p.roomIds ?? [] };
    }
    const part = byId(db.participants, p.sub)!;
    return { kind: p.kind, id: part.id, code: part.code, displayName: displayName(part), firstName: part.firstName };
  });
}

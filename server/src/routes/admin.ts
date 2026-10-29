import type { FastifyInstance } from 'fastify';
import type { SpecialConditions, StaffRole } from '../../../shared/types';
import { db, byId, persist, type Attempt, type ExamSession, type Room } from '../db';
import { ApiError, notFound, invalid } from '../errors';
import { audit } from '../audit';
import { hashPassword, requireStaff, revokeUserSessions } from '../auth';
import { EXAMS } from '../exams';
import { sessionDto, displayName } from '../views';
import { buildVariant, loadReferences, validateVariant, type RawVariant } from '../kim/loader';
import { refreshSessionStatus, recalcAttempts, validateScale, scaleFor } from '../grading';
import { addWorkingDays, nowIso, secret, sha256, uuid } from '../util';
import { resolve } from 'node:path';
import { config } from '../config';

/** Компонент С6 «Администрирование» и служебные операции (ТЗ СЧ FR-28, FR-33, FR-34, FR-43–FR-50, FR-53). */

const STAFF_ROLES: StaffRole[] = ['organizer', 'admin', 'observer', 'analyst'];
const validations = new Map<string, { sessionId: string; hash: string; rows: AllocationRow[]; at: number }>();

interface AllocationRow { line: number; participantId: string; roomId: string; workstationId: string }

export default async function adminRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireStaff('admin') };

  app.get('/exams', { preHandler: requireStaff() }, async () =>
    Object.entries(EXAMS).map(([code, e]) => ({
      code,
      ...e,
      variants: db.variants.filter((v) => v.examCode === code).map((v) => ({ id: v.id, number: v.number, title: v.title, tasks: v.keys.length, importedAt: v.importedAt, checksum: v.checksum })),
    })),
  );

  app.get('/ppes', admin, async () =>
    db.ppes.map((p) => ({ ...p, rooms: db.rooms.filter((r) => r.ppeId === p.id).length })),
  );

  app.get('/exam-sessions', { preHandler: requireStaff('admin', 'observer', 'analyst') }, async () =>
    db.sessions.slice().sort((a, b) => b.date.localeCompare(a.date)).map(sessionDto),
  );

    /** Создание экзаменационной сессии (FR-43). */
  app.post<{
    Body: {
      examCode: string;
      date: string;
      startLocal: string;
      variantIds: string[];
      proctoring: boolean;
      rooms: { ppeId: string; number: string; seats: number; organizerIds?: string[] }[];
    };
      }>(
    '/exam-sessions',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['examCode', 'date', 'startLocal', 'variantIds', 'proctoring', 'rooms'],
          properties: {
            examCode: { type: 'string' },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            startLocal: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
            variantIds: { type: 'array', items: { type: 'string' } },
            proctoring: { type: 'boolean' },
            rooms: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['ppeId', 'number', 'seats'],
                properties: {
                  ppeId: { type: 'string' },
                  number: { type: 'string', minLength: 1, maxLength: 8 },
                  seats: { type: 'integer', minimum: 1, maximum: 25 },
                  organizerIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
          },
    async (req) => {
      const b = req.body;
      const errors: { pointer: string; detail: string }[] = [];
      const exam = EXAMS[b.examCode];
      if (!exam) errors.push({ pointer: '/examCode', detail: 'Экзамен не найден в справочнике' });
      if (!b.variantIds.length) errors.push({ pointer: '/variantIds', detail: 'Не выбраны варианты КИМ' });
      b.variantIds.forEach((id, i) => {
        const v = byId(db.variants, id);
        if (!v || v.examCode !== b.examCode) errors.push({ pointer: `/variantIds/${i}`, detail: 'Вариант не относится к экзамену' });
      });
      if (!b.rooms.length) errors.push({ pointer: '/rooms', detail: 'Не назначены аудитории' });
      b.rooms.forEach((r, i) => {
        if (!byId(db.ppes, r.ppeId)) errors.push({ pointer: `/rooms/${i}/ppeId`, detail: 'ППЭ не найден' });
        for (const o of r.organizerIds ?? []) if (!byId(db.staff, o)?.roles.includes('organizer')) errors.push({ pointer: `/rooms/${i}/organizerIds`, detail: 'Не организатор' });
      });
      if (errors.length) throw invalid(errors, 'VALIDATION_FAILED', 422);
      const ppe = byId(db.ppes, b.rooms[0].ppeId)!;
            const session: ExamSession = {
        id: uuid(),
        examCode: b.examCode,
        date: b.date,
        startLocal: b.startLocal,
        tz: ppe.tz,
        durationMin: exam.durationMin,
        variantIds: b.variantIds,
        roomIds: [],
        proctoring: b.proctoring,
        status: 'preparation',
        resultsStatus: 'processing',
        createdAt: nowIso(),
      };
      for (const r of b.rooms) {
        const room: Room = { id: uuid(), sessionId: session.id, ppeId: r.ppeId, number: r.number, organizerIds: r.organizerIds ?? [], messages: [] };
        db.rooms.push(room);
        session.roomIds.push(room.id);
        for (let i = 1; i <= r.seats; i++)
          db.workstations.push({ id: uuid(), roomId: room.id, label: `Место ${String(i).padStart(2, '0')}`, secret: secret() });
      }
      db.sessions.push(session);
      audit({ type: 'admin.sessionCreated', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: session.id, details: `${exam.title}, ${b.date}` });
      persist();
      return sessionDto(session);
    },
  );
    /** Проверка файла распределения построчно (FR-44). Формат: код_участника;код_ППЭ;аудитория;место */
  app.post<{ Params: { id: string }; Body: { csv: string } }>(
    '/exam-sessions/:id/allocation/validate',
    {
      ...admin,
      bodyLimit: 10 * 1024 * 1024,
      schema: { body: { type: 'object', additionalProperties: false, required: ['csv'], properties: { csv: { type: 'string', maxLength: 8_000_000 } } } },
    },
        async (req) => {
      const session = byId(db.sessions, req.params.id);
      if (!session) throw notFound();
      if (session.status !== 'preparation') throw new ApiError(409, 'INVALID_STATE', 'Сессия не в статусе «Подготовка»');
      const lines = req.body.csv.replace(/^﻿/, '').split(/\r?\n/);
      const errors: { line: number; detail: string }[] = [];
      const rows: AllocationRow[] = [];
      const seenParticipants = new Set<string>();
      const seenSeats = new Set<string>();
      const perRoom = new Map<string, number>();
      lines.forEach((raw, idx) => {
        const line = idx + 1;
        if (!raw.trim()) return;
        const cols = raw.split(';').map((c) => c.trim());
        if (idx === 0 && /участник|participant/i.test(cols[0])) return;
        if (cols.length !== 4) return errors.push({ line, detail: 'Ожидается 4 поля через «;»' });
        const [code, ppeCode, roomNo, seat] = cols;
        const p = db.participants.find((x) => x.code === code);
        if (!p) return errors.push({ line, detail: `Участник ${code} не найден` });
        if (seenParticipants.has(p.id)) return errors.push({ line, detail: `Повтор участника ${code}` });
        const ppe = db.ppes.find((x) => x.code === ppeCode);
        if (!ppe) return errors.push({ line, detail: `ППЭ ${ppeCode} не найден` });
        const room = db.rooms.find((r) => r.sessionId === session.id && r.ppeId === ppe.id && r.number === roomNo);
        if (!room) return errors.push({ line, detail: `Аудитория ${roomNo} не назначена на сессию в ППЭ ${ppeCode}` });
        const ws = db.workstations.find((w) => w.roomId === room.id && (w.label === seat || w.label === `Место ${seat.padStart(2, '0')}`));
        if (!ws) return errors.push({ line, detail: `Место ${seat} отсутствует в аудитории ${roomNo}` });
        if (seenSeats.has(ws.id)) return errors.push({ line, detail: `Место ${seat} назначено дважды` });
        const count = (perRoom.get(room.id) ?? 0) + 1;
        if (count > 25) return errors.push({ line, detail: 'В аудитории более 25 мест' });
        const other = db.attempts.find((a) => a.participantId === p.id && byId(db.sessions, a.sessionId)?.date === session.date && a.sessionId !== session.id);
        if (other) return errors.push({ line, detail: `Участник ${code} уже распределён на другую сессию в этот день` });
        perRoom.set(room.id, count);
        seenParticipants.add(p.id);
        seenSeats.add(ws.id);
        rows.push({ line, participantId: p.id, roomId: room.id, workstationId: ws.id });
      });
      const hash = sha256(req.body.csv);
      const validationId = uuid();
      if (!errors.length) validations.set(validationId, { sessionId: session.id, hash, rows, at: Date.now() });
      return { validationId: errors.length ? undefined : validationId, hash, rows: rows.length, errors };
    },
  );

    /** Применение только проверенного файла целиком, в одной транзакции (FR-45). */
  app.post<{ Params: { id: string }; Body: { validationId: string; hash: string } }>(
    '/exam-sessions/:id/allocation',
    {
      ...admin,
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['validationId', 'hash'], properties: { validationId: { type: 'string' }, hash: { type: 'string' } } },
      },
    },
    async (req) => {
      const v = validations.get(req.body.validationId);
      if (!v || v.sessionId !== req.params.id || v.hash !== req.body.hash) throw new ApiError(409, 'INVALID_STATE', 'Файл не проверен или изменён');
      const session = byId(db.sessions, v.sessionId)!;
      const attempts: Attempt[] = v.rows.map((r) => ({
        id: uuid(),
        sessionId: session.id,
        participantId: r.participantId,
        roomId: r.roomId,
        workstationId: r.workstationId,
        state: 'assigned',
        compensationMin: 0,
        compensations: [],
        answers: {},
        answerHistory: {},
        lastSeq: 0,
        notes: {},
        flags: [],
        downtimeSec: 0,
        integrity: [],
      }));
      db.attempts = db.attempts.filter((a) => a.sessionId !== session.id).concat(attempts);
      for (const rid of session.roomIds) for (const w of db.workstations.filter((x) => x.roomId === rid)) w.secret = secret();
      validations.delete(req.body.validationId);
      audit({ type: 'admin.allocationApplied', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: session.id, details: `${attempts.length} участников` });
      persist();
      return { applied: attempts.length };
    },
  );

  // ---------- персонал (FR-46, FR-07) ----------
  app.get('/staff', admin, async () =>
    db.staff.map((u) => ({ id: u.id, login: u.login, fullName: u.fullName, roles: u.roles, blocked: u.blocked, createdAt: u.createdAt })),
  );

  app.post<{ Body: { login: string; fullName: string; password: string; roles: StaffRole[] } }>(
    '/staff',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['login', 'fullName', 'password', 'roles'],
          properties: {
            login: { type: 'string', pattern: '^[a-z0-9._-]{3,32}$' },
            fullName: { type: 'string', minLength: 3, maxLength: 120 },
            password: { type: 'string', minLength: 12, maxLength: 128 },
            roles: { type: 'array', minItems: 1, items: { type: 'string', enum: STAFF_ROLES } },
          },
        },
      },
    },
    async (req) => {
      const b = req.body;
      if (db.staff.some((u) => u.login === b.login)) throw invalid([{ pointer: '/login', detail: 'Логин занят' }], 'VALIDATION_FAILED', 422);
      if (db.participants.some((p) => p.code === b.login)) throw new ApiError(422, 'ROLE_CONFLICT');
      const u = { id: uuid(), login: b.login, fullName: b.fullName, passwordHash: hashPassword(b.password), roles: b.roles, blocked: false, subjects: ['math-profile'], createdAt: nowIso() };
      db.staff.push(u);
      audit({ type: 'admin.staffCreated', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: u.login, details: b.roles.join(',') });
      persist();
      return { id: u.id, login: u.login, fullName: u.fullName, roles: u.roles, blocked: u.blocked, createdAt: u.createdAt };
    },
  );

  app.patch<{ Body: { id: string; roles?: StaffRole[]; blocked?: boolean } }>(
    '/staff',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: {
            id: { type: 'string' },
            roles: { type: 'array', minItems: 1, items: { type: 'string', enum: [...STAFF_ROLES, 'participant'] } },
            blocked: { type: 'boolean' },
          },
        },
      },
    },
    async (req) => {
      const u = byId(db.staff, req.body.id);
      if (!u) throw notFound();
      if (req.body.roles?.includes('participant' as StaffRole)) throw new ApiError(422, 'ROLE_CONFLICT', 'Учётной записи персонала нельзя назначить роль участника');
      if (req.body.roles) u.roles = req.body.roles;
      if (req.body.blocked !== undefined) {
        u.blocked = req.body.blocked;
        if (u.blocked) revokeUserSessions(u.id);
      }
      audit({ type: req.body.blocked ? 'admin.staffBlocked' : 'admin.rolesChanged', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: u.login, details: u.roles.join(',') });
      persist();
      return { id: u.id, login: u.login, fullName: u.fullName, roles: u.roles, blocked: u.blocked, createdAt: u.createdAt };
    },
  );

  // ---------- участники и особые условия (FR-47) ----------
  // Фильтр по особым условиям — до среза первых 100, total — число всех совпадений
  app.get<{ Querystring: { q?: string; cond?: string } }>('/participants', admin, async (req) => {
    const q = (req.query.q ?? '').toLowerCase();
    const cond = req.query.cond === 'any' || req.query.cond === 'none' ? req.query.cond : undefined;
    const has = (s: SpecialConditions) => s.extraTime || s.scale !== 100 || s.contrast;
    const all = db.participants.filter(
      (p) => (!q || p.code.includes(q) || p.lastName.toLowerCase().includes(q)) && (!cond || (cond === 'any') === has(p.specialConditions)),
    );
    return {
      total: all.length,
      items: all.slice(0, 100).map((p) => ({ id: p.id, code: p.code, displayName: displayName(p), specialConditions: p.specialConditions, regionCode: p.regionCode })),
    };
  });

  app.put<{ Params: { id: string }; Body: SpecialConditions }>(
    '/participants/:id/special-conditions',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['extraTime', 'scale', 'contrast'],
          properties: { extraTime: { type: 'boolean' }, scale: { type: 'integer', enum: [100, 150, 200] }, contrast: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const p = byId(db.participants, req.params.id);
      if (!p) throw notFound();
      if (req.body.extraTime !== p.specialConditions.extraTime && db.attempts.some((a) => a.participantId === p.id && a.t0 && a.state === 'inProgress'))
        throw new ApiError(409, 'INVALID_STATE', 'Продолжительность нельзя изменить после начала попытки');
      p.specialConditions = req.body;
      audit({ type: 'admin.specialConditions', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: p.code, details: JSON.stringify(req.body) });
      persist();
      return p.specialConditions;
    },
  );

  /** Публикация результатов и окно апелляции — 2 рабочих дня (FR-48). */
  app.post<{ Params: { id: string } }>('/exam-sessions/:id/results/publish', admin, async (req) => {
    const s = byId(db.sessions, req.params.id);
    if (!s) throw notFound();
    refreshSessionStatus(s.id);
    if (s.resultsStatus !== 'approved') throw new ApiError(409, 'RESULTS_NOT_APPROVED');
    const now = new Date();
    s.resultsStatus = 'published';
    s.status = 'completed';
    s.publishedAt = now.toISOString();
    s.appealWindow = { from: now.toISOString(), to: addWorkingDays(now, 2).toISOString() };
    for (const r of db.results.filter((x) => x.sessionId === s.id)) r.status = 'published';
    audit({ type: 'admin.resultsPublished', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: s.id });
    persist();
    return sessionDto(s);
  });

  /** Выгрузка результатов CSV с контрольной суммой, без ПДн (FR-53). */
  app.get<{ Params: { id: string } }>('/exam-sessions/:id/results/export', admin, async (req, reply) => {
    const s = byId(db.sessions, req.params.id);
    if (!s || s.resultsStatus !== 'published') throw new ApiError(409, 'RESULTS_NOT_APPROVED');
    const rows = ['attempt_id;region;primary_score;test_score;grade;passed;scale_version'];
    for (const r of db.results.filter((x) => x.sessionId === s.id)) {
      const p = byId(db.participants, r.participantId)!;
      rows.push([sha256(r.attemptId).slice(0, 16), p.regionCode, r.primaryScore, r.testScore ?? '', r.grade ?? '', r.passed ? 1 : 0, r.scaleVersion].join(';'));
    }
    const body = rows.join('\n') + '\n';
    audit({ type: 'data.exported', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: s.id });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="results-${s.date}.csv"`)
      .header('x-checksum-sha256', sha256(body))
      .send('﻿' + body);
  });

  // ---------- КИМ и шкалы ----------
  app.post<{ Body: RawVariant }>('/kim/imports', { ...admin, bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const errors = validateVariant(req.body);
    if (errors.length) throw invalid(errors, 'IMPORT_INVALID', 422);
    const refs = loadReferences(resolve(config.kimDir, 'math-profile-2026'));
    const v = buildVariant(req.body, refs);
    db.variants.push(v);
    audit({ type: 'kim.imported', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: v.title, details: `sha256 ${v.checksum.slice(0, 16)}` });
    persist();
    return { id: v.id, number: v.number, title: v.title, tasks: v.keys.length, checksum: v.checksum };
  });

  app.post<{ Body: unknown }>('/kim/validate', { ...admin, bodyLimit: 50 * 1024 * 1024 }, async (req) => {
    const t0 = performance.now();
    const errors = validateVariant(req.body);
    return { valid: !errors.length, errors, ms: Math.round(performance.now() - t0) };
  });

  /** Исправление эталона после экзамена и перепроверка затронутых работ (FR-33). */
  app.put<{ Params: { variantId: string; taskId: string }; Body: { values: string[]; reason: string } }>(
    '/kim/variants/:variantId/tasks/:taskId/key',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['values', 'reason'],
          properties: { values: { type: 'array', minItems: 1, items: { type: 'string', maxLength: 50 } }, reason: { type: 'string', minLength: 3 } },
        },
      },
    },
    async (req) => {
      const v = byId(db.variants, req.params.variantId);
      const t = v?.keys.find((x) => x.id === req.params.taskId);
      if (!v || !t || t.part !== 1) throw notFound();
      t.correct = [...(t.correct ?? []), { version: (t.correct?.length ?? 0) + 1, values: req.body.values, reason: req.body.reason, at: nowIso() }];
      const affected = db.attempts.filter((a) => a.variantId === v.id && db.results.some((r) => r.attemptId === a.id)).map((a) => a.id);
      recalcAttempts(affected, `Исправление эталона задания ${t.number}: ${req.body.reason}`);
      audit({ type: 'kim.keyCorrected', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub, object: `${v.title} / ${t.number}`, details: req.body.reason });
      return { recalculated: affected.length };
    },
  );
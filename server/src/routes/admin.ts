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
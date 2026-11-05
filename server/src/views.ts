import type { AttemptStateDto, ExamSessionDto, RoomDto, SeatDto } from '../../shared/types';
import { db, byId, type Attempt, type ExamSession, type Room } from './db';
import { EXAMS } from './exams';
import { addMinutes, nowIso } from './util';
import { config } from './config';

export function endsAt(a: Attempt): string | undefined {
  return a.baseEndsAt ? addMinutes(a.baseEndsAt, a.compensationMin) : undefined;
}

export function displayName(p: { lastName: string; firstName: string; middleName: string }) {
  return `${p.lastName} ${p.firstName[0]}. ${p.middleName ? p.middleName[0] + '.' : ''}`.trim();
}

export function sessionTitle(s: ExamSession) {
  return EXAMS[s.examCode]?.title ?? s.examCode;
}

export function seatParticipant(a: Attempt): SeatDto['participant'] {
  const p = byId(db.participants, a.participantId)!;
  const last = a.integrity.at(-1);
  const offline =
    ['inProgress', 'loading'].includes(a.state) && (!a.lastSeenAt || Date.now() - new Date(a.lastSeenAt).getTime() > 60_000);
  return {
    attemptId: a.id,
    code: p.code,
    displayName: displayName(p),
    state: a.state,
    answered: Object.values(a.answers).filter((x) => x.value.trim()).length,
    lastActivityAt: a.lastSeenAt,
    offline,
    lastIntegrity: last ? { type: last.type, at: last.at } : undefined,
    endsAt: endsAt(a),
    specialConditions: p.specialConditions,
  };
}

export function roomDto(room: Room, withLinks: boolean): RoomDto {
  const session = byId(db.sessions, room.sessionId)!;
  const ppe = byId(db.ppes, room.ppeId)!;
  const seats = db.workstations
    .filter((w) => w.roomId === room.id)
    .map((w): SeatDto => {
      const a = db.attempts.find((x) => x.workstationId === w.id && x.roomId === room.id);
      return {
        workstationId: w.id,
        label: w.label,
        check: w.check,
        participant: a ? seatParticipant(a) : undefined,
        link: withLinks ? `/exam#ws=${w.secret}` : undefined,
      };
    });
  const codeValid = room.accessCode && accessCodeValid(room);
  const variant = byId(db.variants, session.variantIds[0]);
  return {
    id: room.id,
    number: room.number,
    ppe: { id: ppe.id, code: ppe.code, name: ppe.name, region: ppe.region, tz: ppe.tz },
    session: {
      id: session.id,
      title: sessionTitle(session),
      date: session.date,
      startLocal: session.startLocal,
      durationMin: session.durationMin,
      proctoring: session.proctoring,
    },
    accessCode: withLinks && codeValid ? room.accessCode : undefined,
    accessCodeValidUntil: room.startedAt ? addMinutes(room.startedAt, config.accessCodeAfterStartMin) : undefined,
    startedAt: room.startedAt,
    seats,
    tasksCount: variant?.keys.length ?? 0,
    messages: room.messages,
  };
}

export function accessCodeValid(room: Room) {
  if (!room.accessCode) return false;
  if (!room.startedAt) return true;
  return Date.now() < new Date(addMinutes(room.startedAt, config.accessCodeAfterStartMin)).getTime();
}

export function attemptStateDto(a: Attempt): AttemptStateDto {
  const session = byId(db.sessions, a.sessionId)!;
  const room = byId(db.rooms, a.roomId)!;
  const ppe = byId(db.ppes, room.ppeId)!;
  const p = byId(db.participants, a.participantId)!;
  const variant = byId(db.variants, a.variantId ?? session.variantIds[0]);
  return {
    attemptId: a.id,
    state: a.state,
    serverTime: nowIso(),
    exam: {
      code: session.examCode,
      title: sessionTitle(session),
      durationMin: session.durationMin + (p.specialConditions.extraTime ? 90 : 0),
      tasksCount: variant?.keys.length ?? 0,
    },
    participant: { code: p.code, displayName: `${p.firstName} ${p.lastName[0]}.` },
    room: { id: room.id, number: room.number, ppeCode: ppe.code },
    startedAt: a.t0,
    endsAt: endsAt(a),
    specialConditions: p.specialConditions,
    answers: Object.fromEntries(
      Object.entries(a.answers).map(([k, v]) => [k, { kind: v.kind, value: v.value, version: v.version, savedAt: v.savedAt }]),
    ),
    notes: a.notes,
    flags: a.flags,
    lastTaskId: a.lastTaskId,
    lastSeq: a.lastSeq,
    variantId: a.variantId,
    messages: room.messages,
    roomStarted: !!room.startedAt,
    terminationMessage: a.terminationMessage,
    finishedAt: a.finishedAt,
  };
}

export function sessionDto(s: ExamSession): ExamSessionDto {
  return {
    id: s.id,
    examCode: s.examCode,
    title: sessionTitle(s),
    date: s.date,
    startLocal: s.startLocal,
    tz: s.tz,
    durationMin: s.durationMin,
    proctoring: s.proctoring,
    status: s.status,
    resultsStatus: s.resultsStatus,
    rooms: s.roomIds.map((id) => {
      const r = byId(db.rooms, id)!;
      return {
        id: r.id,
        number: r.number,
        ppeCode: byId(db.ppes, r.ppeId)?.code ?? '',
        participants: db.attempts.filter((a) => a.roomId === r.id).length,
      };
    }),
    variants: s.variantIds.length,
    attempts: db.attempts.filter((a) => a.sessionId === s.id).length,
    publishedAt: s.publishedAt,
    appealWindow: s.appealWindow,
  };
}

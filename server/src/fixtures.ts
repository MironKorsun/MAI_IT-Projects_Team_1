import { db, emptyDb, setDb, type Attempt, type Database, type ExamSession, type Participant, type Room } from './db';
import { hashPassword } from './auth';
import { buildVariant, loadPackage } from './kim/loader';
import { tryCalculate, refreshSessionStatus, normalizeShort } from './grading';
import { audit } from './audit';
import { addMinutes, addWorkingDays, mulberry32, secret, uuid } from './util';
import type { StaffRole } from '../../shared/types';

/**
 * Синтетические данные стенда Staging (ТЗ СЧ NFR-30: испытания на синтетических данных).
 * Справочники ППЭ и участников в промышленной поставке приходят из региональных систем;
 * интеграция с ФИС ГИА вне объёма учебного проекта (ТЗ СЧ 3.4 п. 9). ПДн — вымышленные.
 * Пароли и PIN задаёт оператор при заполнении стенда; в БД сохраняются только хэши (NFR-20).
 */
export interface StagingOptions {
  staffPassword: string;
  participantPin: string;
  /** Код аудитории 101 текущей сессии; по умолчанию — случайный. */
  accessCode?: string;
  /** Сохраняемые записи уже заполненной базы: учётные записи и журнал (цепочка хэшей не прерывается). */
  keep?: Pick<Database, 'staff' | 'audit'>;
}

/** Код участника с опубликованными результатами прошедшей сессии. */
export const RESULTS_PARTICIPANT_CODE = '5000-000-001';

export const REGIONS = [
  { code: '77', name: 'г. Москва', tz: 'Europe/Moscow', shift: 0.1 },
  { code: '78', name: 'г. Санкт-Петербург', tz: 'Europe/Moscow', shift: 0.15 },
  { code: '50', name: 'Московская область', tz: 'Europe/Moscow', shift: 0 },
  { code: '16', name: 'Республика Татарстан', tz: 'Europe/Moscow', shift: 1.25 },
  { code: '66', name: 'Свердловская область', tz: 'Asia/Yekaterinburg', shift: -0.1 },
  { code: '54', name: 'Новосибирская область', tz: 'Asia/Novosibirsk', shift: 0.05 },
  { code: '25', name: 'Приморский край', tz: 'Asia/Vladivostok', shift: -0.2 },
  { code: '39', name: 'Калининградская область', tz: 'Europe/Kaliningrad', shift: -0.05 },
];

const LAST_M = ['Иванов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Петров', 'Соколов', 'Михайлов', 'Новиков', 'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров'];
const FIRST_M = ['Александр', 'Максим', 'Иван', 'Артём', 'Дмитрий', 'Никита', 'Михаил', 'Даниил', 'Егор', 'Андрей', 'Кирилл', 'Илья', 'Матвей', 'Тимофей', 'Роман'];
const FIRST_F = ['Анастасия', 'Мария', 'Анна', 'Виктория', 'Екатерина', 'Полина', 'Софья', 'Дарья', 'Алиса', 'Ксения', 'Александра', 'Елизавета', 'Варвара', 'Вероника', 'Ульяна'];
const MIDDLE = ['Александров', 'Сергеев', 'Дмитриев', 'Андреев', 'Алексеев', 'Михайлов', 'Владимиров', 'Игорев', 'Олегов', 'Николаев'];

const rnd = mulberry32(20261020);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
function gauss() {
  const u = 1 - rnd();
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

let participantSeq = 0;
function makeParticipant(regionCode: string, schoolId: string, code?: string): Participant {
  participantSeq++;
  const female = rnd() < 0.5;
  const last = pick(LAST_M);
  return {
    id: uuid(),
    code: code ?? `${regionCode}${String(10 + (participantSeq % 80)).padStart(2, '0')}-${String(100 + Math.floor(participantSeq / 7)).padStart(3, '0')}-${String(participantSeq).padStart(3, '0').slice(-3)}`,
    lastName: female ? last.replace(/(ов|ев|ёв|ин)$/, '$1а') : last,
    firstName: female ? pick(FIRST_F) : pick(FIRST_M),
    middleName: pick(MIDDLE) + (female ? 'на' : 'ич'),
    documentNumber: `45 ${String(10 + Math.floor(rnd() * 89))} ${String(100000 + Math.floor(rnd() * 899999))}`,
    birthDate: `2008-0${1 + Math.floor(rnd() * 9)}-1${Math.floor(rnd() * 9)}`,
    pinHash: '',
    schoolId,
    regionCode,
    specialConditions: { extraTime: false, scale: 100, contrast: false },
  };
}

function newAttempt(sessionId: string, participantId: string, roomId: string, workstationId: string): Attempt {
  return {
    id: uuid(),
    sessionId,
    participantId,
    roomId,
    workstationId,
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
  };
}

function addRoom(sessionId: string, ppeId: string, number: string, seats: number, organizerIds: string[]): Room {
  const room: Room = { id: uuid(), sessionId, ppeId, number, organizerIds, messages: [] };
  db.rooms.push(room);
  for (let i = 1; i <= seats; i++) db.workstations.push({ id: uuid(), roomId: room.id, label: `Место ${String(i).padStart(2, '0')}`, secret: secret() });
  return room;
}

export function seedStaging(opts: StagingOptions) {
  if (opts.staffPassword.length < 12) throw new Error('Пароль персонала — не короче 12 символов (ТЗ КЧ NFR-23)');
  if (!/^\d{6}$/.test(opts.participantPin)) throw new Error('PIN участника — 6 цифр');
  setDb(emptyDb());
  if (opts.keep) {
    db.staff.push(...opts.keep.staff);
    db.audit.push(...opts.keep.audit);
  }
  const now = new Date();
  // «Сегодня» — по местному времени ППЭ (Москва): после 21:00 UTC в Москве уже следующая дата
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(now);

  // ---------- КИМ ----------
  const pkg = loadPackage();
  const variants = pkg.raws.map((r) => buildVariant(r, pkg.references));
  db.variants.push(...variants);
  const variantIds = variants.map((v) => v.id);
  db.scales.push({
    examCode: 'math-profile',
    year: 2026,
    version: '2026.1',
    kind: 'test',
    values: [0, 6, 11, 17, 22, 27, 34, 42, 50, 62, 74, 86, 100],
    threshold: 27,
    loadedAt: now.toISOString(),
  });
  db.scales.push({
    examCode: 'math-base',
    year: 2026,
    version: '2026.1',
    kind: 'grade',
    values: [2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5],
    threshold: 3,
    loadedAt: now.toISOString(),
  });

  // ---------- ППЭ, школы ----------
  for (const r of REGIONS) {
    db.ppes.push({ id: uuid(), code: `${r.code}01`, name: `ППЭ № ${r.code}01, школа № ${100 + Number(r.code)}`, region: r.name, regionCode: r.code, tz: r.tz });
    db.schools.push({ id: uuid(), name: `Школа № ${100 + Number(r.code)}`, regionCode: r.code });
  }
  const ppeMsk = db.ppes[0];

  // ---------- персонал ----------
  const pw = hashPassword(opts.staffPassword);
  const pin = hashPassword(opts.participantPin);
  const staff = (login: string, fullName: string, roles: StaffRole[]) => {
    const existing = db.staff.find((x) => x.login === login);
    if (existing) return existing;
    const u = { id: uuid(), login, fullName, passwordHash: pw, roles, blocked: false, subjects: ['math-profile'], createdAt: now.toISOString() };
    db.staff.push(u);
    return u;
  };
  const org1 = staff('org1', 'Белова Ирина Сергеевна', ['organizer']);
  const org2 = staff('org2', 'Голубев Павел Андреевич', ['organizer']);
  staff('admin', 'Литвинова Марина Юрьевна', ['admin']);
  staff('observer', 'Ситуационный центр Рособрнадзора', ['observer']);
  staff('analyst', 'Андреева Анна Николаевна', ['analyst']);

  // ---------- текущая сессия (сегодня) ----------
  const live: ExamSession = {
    id: uuid(),
    examCode: 'math-profile',
    date: today,
    startLocal: '10:00',
    tz: ppeMsk.tz,
    durationMin: 235,
    variantIds,
    roomIds: [],
    proctoring: true,
    status: 'preparation',
    resultsStatus: 'processing',
    createdAt: now.toISOString(),
  };
  db.sessions.push(live);
  const school = db.schools[0];
  const room101 = addRoom(live.id, ppeMsk.id, '101', 12, [org1.id]);
  const room102 = addRoom(live.id, ppeMsk.id, '102', 10, [org2.id]);
  live.roomIds.push(room101.id, room102.id);
  room101.accessCode = opts.accessCode ?? String(100000 + Math.floor(Math.random() * 900000));
  room101.accessCodeIssuedAt = now.toISOString();
  const liveCodes = ['7701-001-0001', '7701-001-0002', '7701-001-0003', '7701-001-0004', '7701-001-0005', '7701-001-0006', '7701-001-0007', '7701-001-0008', '7701-001-0009', '7701-001-0010'];
  liveCodes.forEach((code, i) => {
    const p = makeParticipant('77', school.id, code);
    if (i === 2) p.specialConditions = { extraTime: true, scale: 150, contrast: false };
    p.pinHash = pin;
    db.participants.push(p);
    const ws = db.workstations.filter((w) => w.roomId === room101.id)[i];
    db.attempts.push(newAttempt(live.id, p.id, room101.id, ws.id));
  });
  for (let i = 0; i < 8; i++) {
    const p = makeParticipant('77', school.id, `7701-002-${String(i + 1).padStart(4, '0')}`);
    p.pinHash = pin;
    db.participants.push(p);
    const ws = db.workstations.filter((w) => w.roomId === room102.id)[i];
    ws.check = { passed: true, at: now.toISOString(), details: { browser: true, screen: true, fullscreen: true, latencyMs: 40, kimPreloaded: true, passed: true } };
    const a = newAttempt(live.id, p.id, room102.id, ws.id);
    if (i < 6) {
      a.state = 'waiting';
      a.loggedInAt = now.toISOString();
      a.lastSeenAt = now.toISOString();
    }
    db.attempts.push(a);
  }

  // ---------- прошедшая сессия с опубликованными результатами ----------
  const pastDate = '2026-09-15';
  const past: ExamSession = {
    id: uuid(),
    examCode: 'math-profile',
    date: pastDate,
    startLocal: '10:00',
    tz: 'Europe/Moscow',
    durationMin: 235,
    variantIds,
    roomIds: [],
    proctoring: true,
    status: 'completed',
    resultsStatus: 'processing',
    createdAt: '2026-08-20T09:00:00.000Z',
  };
  db.sessions.push(past);

  const tasksBySeat = (v: (typeof variants)[number]) => v.keys;
  const DIFF: Record<number, number> = { 1: -2.1, 2: -1.8, 3: -1.5, 4: -2.0, 5: 0.35, 6: -1.7, 7: -1.4, 8: -0.9, 9: -0.6, 10: -0.1, 11: 0.3, 12: 0.7 };
  const resultsParticipant = makeParticipant('77', db.schools[0].id, RESULTS_PARTICIPANT_CODE);
  resultsParticipant.lastName = 'Соколова';
  resultsParticipant.firstName = 'Алиса';
  resultsParticipant.middleName = 'Дмитриевна';
  resultsParticipant.pinHash = pin;

  const pastStart = new Date(`${pastDate}T07:00:00.000Z`);
  let fastLeft = 4;
  REGIONS.forEach((reg, ri) => {
    const ppe = db.ppes[ri];
    const schoolR = db.schools[ri];
    const nRooms = reg.code === '16' ? 2 : 3;
    for (let k = 0; k < nRooms; k++) {
      const room = addRoom(past.id, ppe.id, String(201 + k), 25, []);
      room.startedAt = pastStart.toISOString();
      past.roomIds.push(room.id);
      const seats = db.workstations.filter((w) => w.roomId === room.id);
      seats.forEach((ws, si) => {
        if (si >= 22) return;
        const isResults = ri === 0 && k === 0 && si === 0;
        const p = isResults ? resultsParticipant : makeParticipant(reg.code, schoolR.id);
        if (!isResults) p.pinHash = '';
        db.participants.push(p);
        const a = newAttempt(past.id, p.id, room.id, ws.id);
        const v = variants[si % variants.length];
        a.variantId = v.id;
        a.t0 = addMinutes(pastStart.toISOString(), Math.floor(rnd() * 3));
        a.baseEndsAt = addMinutes(a.t0, 235);
        const theta = isResults ? 1.2 : gauss() + 0.25 + reg.shift;
        let duration = 90 + Math.floor(rnd() * 140);
        const fast = !isResults && theta > 1.4 && fastLeft > 0 && rnd() < 0.3;
        if (fast) {
          fastLeft--;
          duration = 12 + Math.floor(rnd() * 6);
        }
        a.finishedAt = addMinutes(a.t0, duration);
        a.state = rnd() < 0.85 ? 'finished' : 'timeExpired';
        if (a.state === 'timeExpired') a.finishedAt = a.baseEndsAt;
        let seq = 0;
        for (const t of tasksBySeat(v)) {
          const b = DIFF[t.number] ?? 0;
          const pCorrect = 1 / (1 + Math.exp(-(1.6 * (theta - b) + (fast ? 3 : 0))));
          const at = addMinutes(a.t0, Math.floor((duration * t.number) / 13));
          if (rnd() < 0.04 && !fast) continue;
          const key = t.correct![0].values[0];
          const ok = rnd() < pCorrect;
          const wrong = String(Number(normalizeShort(key)) + (rnd() < 0.5 ? 1 : -2)).replace('.', ',');
          const value = ok ? key.replace('.', ',') : wrong;
          seq++;
          a.answers[t.id] = { kind: 'short', value, version: 1, seq, savedAt: at, changedAtServerClock: at };
          a.answerHistory[t.id] = [a.answers[t.id]];
        }
        a.lastSeq = seq;
        a.graded = true;
        if (rnd() < 0.06) a.integrity.push({ type: pick(['windowBlur', 'fullscreenExit', 'copy']), at: addMinutes(a.t0, 30), receivedAt: addMinutes(a.t0, 30) });
        db.attempts.push(a);
      });
    }
  });
  for (const a of db.attempts.filter((x) => x.sessionId === past.id)) tryCalculate(a);
  refreshSessionStatus(past.id);
  const published = new Date(now.getTime() - 3 * 3600_000);
  past.resultsStatus = 'published';
  past.publishedAt = published.toISOString();
  past.appealWindow = { from: published.toISOString(), to: addWorkingDays(published, 2).toISOString() };
  for (const r of db.results.filter((x) => x.sessionId === past.id)) r.status = 'published';

  // ---------- журнал ----------
  audit({ type: 'kim.imported', category: 'Администрирование', actorRole: 'admin', object: 'Математика П, варианты 1–2', details: `sha256 ${variants[0].checksum.slice(0, 16)}` });
  audit({ type: 'scale.loaded', category: 'Администрирование', actorRole: 'analyst', object: 'Математика (профильный уровень) 2026', details: 'версия 2026.1' });
  audit({ type: 'admin.sessionCreated', category: 'Администрирование', actorRole: 'admin', object: live.id, details: `Математика (профильный уровень), ${today}` });
  audit({ type: 'admin.allocationApplied', category: 'Администрирование', actorRole: 'admin', object: live.id, details: '18 участников' });
  audit({ type: 'room.accessCodeIssued', category: 'Аудитория', actorRole: 'organizer', object: '101', roomId: room101.id, ppeId: ppeMsk.id });
  audit({ type: 'admin.resultsPublished', category: 'Администрирование', actorRole: 'admin', object: past.id });
  return db;
}

import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, type ExamSession } from '../db';
import { config } from '../config';
import { EXAMS } from '../exams';

const EXAM_CODE = 'math-profile';
const KIM_PACKAGE = 'math-profile-2026';
/** Увеличение продолжительности для участников с ОВЗ, мин (1,5 ч). */
const EXTRA_TIME_MIN = 90;

/** Сводка для главной страницы портала: только сведения об экзамене и расписании, без ПДн. */
export interface PublicOverview {
  exam: { title: string; year: number; kimVersion: string; tasksCount: number; durationMin: number; extraTimeMin: number; threshold: number };
  session: { date: string; startLocal: string; tz: string; status: ExamSession['status'] } | null;
}

interface Manifest {
  year?: number;
  version?: string;
  durationMin?: number;
}

let manifestCache: Manifest | undefined;
function manifest(): Manifest {
  if (!manifestCache) {
    try {
      manifestCache = JSON.parse(readFileSync(resolve(config.kimDir, KIM_PACKAGE, 'manifest.json'), 'utf8')) as Manifest;
    } catch {
      // не кэшируем сбой: следующий запрос прочитает манифест снова (каталог КИМ мог подключиться позже)
      return {};
    }
  }
  return manifestCache;
}

/** Календарная дата (ГГГГ-ММ-ДД) момента `now` в часовом поясе `tz`. */
export function dateInTz(tz: string, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const p = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
    return `${p('year')}-${p('month')}-${p('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Сессия для портала: сегодняшняя (дата сравнивается в часовом поясе самой сессии),
 * иначе ближайшая будущая, иначе null.
 */
export function pickSession(sessions: ExamSession[], now = new Date()): ExamSession | undefined {
  const own = sessions.filter((s) => s.examCode === EXAM_CODE);
  const order = (a: ExamSession, b: ExamSession) => a.date.localeCompare(b.date) || a.startLocal.localeCompare(b.startLocal);
  const today = own.filter((s) => s.date === dateInTz(s.tz, now)).sort(order);
  if (today.length) return today.find((s) => s.status !== 'completed') ?? today[0];
  return own.filter((s) => s.date > dateInTz(s.tz, now)).sort(order)[0];
}

export default async function publicRoutes(app: FastifyInstance) {
  app.get('/public/overview', async (_req, reply): Promise<PublicOverview> => {
    const m = manifest();
    const year = m.year ?? 2026;
    const s = pickSession(db.sessions);
    const variant = db.variants.find((v) => v.examCode === EXAM_CODE && (!s || s.variantIds.includes(v.id))) ?? db.variants.find((v) => v.examCode === EXAM_CODE);
    // Порог — по последней загруженной тестовой шкале экзамена (самый поздний год)
    const scale = db.scales
      .filter((x) => x.examCode === EXAM_CODE && x.kind === 'test')
      .sort((a, b) => a.year - b.year || a.loadedAt.localeCompare(b.loadedAt))
      .at(-1);
    reply.header('cache-control', 'public, max-age=30');
    return {
      exam: {
        title: EXAMS[EXAM_CODE]?.title ?? 'Математика (профильный уровень)',
        year,
        kimVersion: m.version ?? '—',
        tasksCount: variant?.keys.length || 12,
        durationMin: m.durationMin ?? EXAMS[EXAM_CODE]?.durationMin ?? 235,
        extraTimeMin: EXTRA_TIME_MIN,
        threshold: scale?.threshold ?? 27,
      },
      session: s ? { date: s.date, startLocal: s.startLocal, tz: s.tz, status: s.status } : null,
    };
  });
}

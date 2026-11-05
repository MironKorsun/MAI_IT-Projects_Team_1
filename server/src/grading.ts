import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, byId, persist, type Attempt, type Result, type Scale, type StoredTask } from './db';
import { audit } from './audit';
import { config } from './config';
import { nowIso } from './util';

/**
 * Компонент С4 «Оценивание» (ТЗ СЧ FR-32–FR-38) и модуль A1 «Перевод баллов» (ТЗ АО FR-01–FR-05).
 */

/** Нормализация краткого ответа по правилам КИМ (ДП-11): пробелы, разделитель, знак минуса, регистр. */
export function normalizeShort(v: string): string {
  let s = v.trim().replace(/\s+/g, '').replace(/[−–—]/g, '-').replace(',', '.').toLowerCase().replace(/ё/g, 'е');
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    s = s.replace(/^(-?)0+(\d)/, '$1$2');
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
  }
  return s;
}

export function compareShort(task: StoredTask, value: string): { score: number; protocol: string } {
  const key = task.correct?.[task.correct.length - 1];
  if (!key) return { score: 0, protocol: 'Эталон отсутствует' };
  const given = normalizeShort(value ?? '');
  if (!given) return { score: 0, protocol: 'Ответ отсутствует' };
  for (const c of key.values) {
    const exp = normalizeShort(c);
    let ok = false;
    switch (task.compare) {
      case 'set':
        ok = [...given].sort().join('') === [...exp].sort().join('');
        break;
      case 'sequence':
        ok = given === exp;
        break;
      default: {
        const a = Number(given);
        const b = Number(exp);
        ok = Number.isFinite(a) && Number.isFinite(b) ? a === b : given === exp;
      }
    }
    if (ok) return { score: task.maxScore, protocol: `«${value}» → «${given}» = эталон «${exp}» (версия ${key.version})` };
  }
  return { score: 0, protocol: `«${value}» → «${given}» ≠ эталон (версия ${key.version})` };
}

export function scaleFor(examCode: string, year: number) {
  return db.scales.filter((s) => s.examCode === examCode && s.year === year).at(-1);
}

/**
 * Максимальный первичный балл экзамена (ТЗ АО FR-02): сумма max_score заданий варианта КИМ,
 * при отсутствии импортированных вариантов — maxPrimaryScore из плана варианта (kim/<код>-<год>/variant_plan.json).
 * undefined — максимальный балл определить нельзя, шкалу проверить невозможно.
 */
export function maxPrimaryFor(examCode: string, year?: number): number | undefined {
  const variant = db.variants.find((v) => v.examCode === examCode);
  if (variant) return variant.keys.reduce((s, t) => s + t.maxScore, 0);
  const candidates = year ? [`${examCode}-${year}`] : [];
  for (const dir of candidates) {
    const file = resolve(config.kimDir, dir, 'variant_plan.json');
    if (!existsSync(file)) continue;
    try {
      const plan = JSON.parse(readFileSync(file, 'utf8')) as { subject?: string; maxPrimaryScore?: number };
      if (plan.subject === examCode && Number.isInteger(plan.maxPrimaryScore)) return plan.maxPrimaryScore;
    } catch {
      /* повреждённый план — максимальный балл не определён */
    }
  }
  return undefined;
}

/** Ошибка перевода: первичный балл вне диапазона шкалы (ТЗ АО FR-02, FR-03) — без «тихого» усечения. */
export class ScaleRangeError extends Error {
  constructor(public primary: number, public scale: Scale) {
    super(`Первичный балл ${primary} вне шкалы ${scale.version} (0…${scale.values.length - 1})`);
  }
}

/** Перевод первичного балла по версии шкалы (ТЗ АО FR-03). */
export function convertScore(scale: Scale, primary: number): number {
  if (!Number.isInteger(primary) || primary < 0 || primary >= scale.values.length) throw new ScaleRangeError(primary, scale);
  return scale.values[primary];
}

/** Проверка шкалы (ТЗ СЧ FR-34; ТЗ АО FR-01, FR-02). */
export function validateScale(kind: 'test' | 'grade', values: number[], threshold: number, maxPrimary: number) {
  const errors: { pointer: string; detail: string }[] = [];
  if (values.length !== maxPrimary + 1)
    errors.push({ pointer: '/values', detail: `Нужно ${maxPrimary + 1} значений (первичный балл 0…${maxPrimary}), получено ${values.length}` });
  const [lo, hi] = kind === 'test' ? [0, 100] : [2, 5];
  values.forEach((v, i) => {
    if (!Number.isInteger(v) || v < lo || v > hi) errors.push({ pointer: `/values/${i}`, detail: `Значение ${v} вне диапазона ${lo}…${hi}` });
    if (i > 0 && v < values[i - 1]) errors.push({ pointer: `/values/${i}`, detail: `Нарушено неубывание: ${values[i - 1]} → ${v}` });
  });
  if (threshold < lo || threshold > hi) errors.push({ pointer: '/threshold', detail: `Порог ${threshold} вне шкалы` });
  return errors;
}

/** Работа передаётся на автоматическую проверку после закрытия окна приёма (ТЗ СЧ FR-20, FR-21, FR-32). */
export function gradeAttempt(attempt: Attempt) {
  if (attempt.graded || !['finished', 'timeExpired'].includes(attempt.state)) return;
  attempt.graded = true;
  tryCalculate(attempt);
  persist();
}

/** Расчёт результата: первичный балл → отметка или тестовый балл (ТЗ СЧ FR-35; ТЗ АО FR-03, FR-04). */
export function tryCalculate(attempt: Attempt, reason = 'Первичный расчёт') {
  const variant = byId(db.variants, attempt.variantId);
  const session = byId(db.sessions, attempt.sessionId);
  if (!variant || !session) return;
  const tasks: Result['tasks'] = [];
  for (const t of variant.keys) {
    // КИМ содержит только задания с кратким ответом — все проверяются автоматически (ТЗ СЧ 3.1)
    const r = compareShort(t, attempt.answers[t.id]?.value ?? '');
    tasks.push({ taskId: t.id, number: t.number, part: 1, score: r.score, maxScore: t.maxScore, protocol: r.protocol });
  }
  const year = Number(session.date.slice(0, 4));
  const scale = scaleFor(session.examCode, year);
  const primary = tasks.reduce((s, t) => s + t.score, 0);
  const maxPrimary = variant.keys.reduce((s, t) => s + t.maxScore, 0);
  const existing = db.results.find((r) => r.attemptId === attempt.id);
  // Первичный балл вне шкалы не усекается: результат остаётся без тестового балла и версии шкалы,
  // контроль качества АО помечает запись как неполную и блокирует публикацию (ТЗ АО FR-02, FR-20).
  let value: number | undefined;
  let scaleError: string | undefined;
  if (scale) {
    try {
      value = convertScore(scale, primary);
    } catch (e) {
      if (!(e instanceof ScaleRangeError)) throw e;
      scaleError = e.message;
    }
  }
  const applied = value !== undefined ? scale : undefined;
  const at = nowIso();
  const result: Result = {
    attemptId: attempt.id,
    sessionId: session.id,
    participantId: attempt.participantId,
    primaryScore: primary,
    maxPrimary,
    testScore: applied?.kind === 'test' ? value : undefined,
    grade: applied?.kind === 'grade' ? value : undefined,
    passed: value !== undefined && applied ? value >= applied.threshold : false,
    tasks,
    scaleVersion: applied?.version ?? '—',
    status: existing?.status === 'published' ? 'published' : 'calculated',
    calculatedAt: at,
    // В истории сохраняются все прежние значения результата: первичный и тестовый балл, отметка, версия шкалы (ТЗ АО FR-04, FR-05, ТС-07)
    history: existing ? [...existing.history, historyEntry(existing, at, reason)] : [],
  };
  const before = existing ? { primary: existing.primaryScore, test: existing.testScore, grade: existing.grade, scale: existing.scaleVersion } : undefined;
  if (existing) Object.assign(existing, result);
  else db.results.push(result);
  if (scaleError)
    audit({ type: 'result.scaleError', category: 'Расчёт', actorRole: 'system', object: attempt.id, result: 'error', details: `${reason}: ${scaleError}` });
  if (before && (before.primary !== primary || before.test !== result.testScore || before.grade !== result.grade || before.scale !== result.scaleVersion)) {
    const fmt = (v: number | undefined) => (v === undefined ? '—' : String(v));
    const parts = [`первичный ${before.primary} → ${primary}`];
    if (before.test !== result.testScore) parts.push(`тестовый ${fmt(before.test)} → ${fmt(result.testScore)}`);
    if (before.grade !== result.grade) parts.push(`отметка ${fmt(before.grade)} → ${fmt(result.grade)}`);
    if (before.scale !== result.scaleVersion) parts.push(`шкала ${before.scale} → ${result.scaleVersion}`);
    audit({ type: 'result.recalculated', category: 'Расчёт', actorRole: 'system', object: attempt.id, details: `${reason}: ${parts.join(', ')}` });
    // Изменение опубликованного результата фиксируется отдельно: значение обновляется, прежнее — в истории (ТЗ АО 7.1)
    if (result.status === 'published')
      audit({ type: 'result.publishedChanged', category: 'Расчёт', actorRole: 'system', object: attempt.id, details: `${reason}: изменён опубликованный результат, прежние значения сохранены в истории` });
  }
  refreshSessionStatus(session.id);
}

/** Запись истории результата (ТЗ АО FR-04). Поля testScore, grade, scaleVersion — дополнение к схеме Result.history. */
export type ResultHistoryEntry = Result['history'][number] & { testScore?: number; grade?: number; scaleVersion?: string };

function historyEntry(r: Result, at: string, reason: string): ResultHistoryEntry {
  return { at, primaryScore: r.primaryScore, testScore: r.testScore, grade: r.grade, scaleVersion: r.scaleVersion, reason };
}

export function refreshSessionStatus(sessionId: string) {
  const session = byId(db.sessions, sessionId);
  if (!session || session.resultsStatus === 'published') return;
  const attempts = db.attempts.filter((a) => a.sessionId === sessionId);
  const gradable = attempts.filter((a) => ['finished', 'timeExpired'].includes(a.state));
  const open = attempts.some((a) => ['assigned', 'waiting', 'loading', 'inProgress'].includes(a.state));
  const calculated = gradable.every((a) => db.results.some((r) => r.attemptId === a.id));
  const year = Number(session.date.slice(0, 4));
  const prev = session.resultsStatus;
  if (open || !gradable.length || !calculated) session.resultsStatus = 'processing';
  else if (scaleFor(session.examCode, year)) session.resultsStatus = 'approved';
  else session.resultsStatus = 'calculated';
  if (prev !== session.resultsStatus) {
    for (const r of db.results.filter((x) => x.sessionId === sessionId && x.status !== 'published'))
      r.status = session.resultsStatus === 'approved' ? 'approved' : 'calculated';
    audit({ type: 'results.status', category: 'Расчёт', actorRole: 'system', object: session.id, details: `${prev} → ${session.resultsStatus}` });
  }
}

/** Пересчёт затронутых работ с сохранением прежних значений (ТЗ СЧ FR-38; ТЗ АО FR-05). */
export function recalcAttempts(attemptIds: string[], reason: string) {
  for (const id of attemptIds) {
    const a = byId(db.attempts, id);
    if (a) tryCalculate(a, reason);
  }
  persist();
}

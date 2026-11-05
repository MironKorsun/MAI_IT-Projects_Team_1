import type { FastifyInstance } from 'fastify';
import { db, byId, type Result } from '../db';
import { requireStaff } from '../auth';
import { audit } from '../audit';
import { scaleFor, validateScale } from '../grading';
import { EXAMS } from '../exams';
import { sha256 } from '../util';

/**
 * Подсистема «Аналитическое обеспечение»: A2 «Статистика», A3 «Аномалии», A4 «Отчётность», A6 «Контроль»
 * (ТЗ АО, разделы 5, 12–16). Расчёты детерминированы; исходные данные не изменяются.
 */

export const METHODOLOGY_VERSION = 'АО-1.0';

/** Контрольные показатели прошлого периода (учебные значения, ТЗ АО FR-16). */
const PREVIOUS: Record<string, { year: number; mean: number; median: number; thresholdRate: number; count: number }> = {
  'math-profile': { year: 2025, mean: 61.4, median: 62, thresholdRate: 0.921, count: 512 },
};

/** Пороги правил аномалий хранятся как версионируемые параметры методики (ТЗ АО 6.6). */
const THRESHOLDS = {
  /** Нижняя граница процента выполнения по уровню сложности задания. */
  taskLow: { basic: 0.55, advanced: 0.3, high: 0.1 } as Record<string, number>,
  taskVeryLow: { basic: 0.5, advanced: 0.2, high: 0.05 } as Record<string, number>,
  taskHigh: 0.95,
  regionSigma: 2,
  fastMinutes: 20,
  fastShare: 0.8,
};

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
/** Число для текста на русском: десятичная запятая, до одного знака («60,6»); процент — через неразрывный пробел. */
const ru = (x: number) => round(x).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const pct = (x: number) => `${ru(x)}\u00a0%`;

function dataset(sessionId?: string) {
  const sessions = db.sessions.filter((s) => (sessionId ? s.id === sessionId : ['approved', 'published'].includes(s.resultsStatus)));
  const ids = new Set(sessions.map((s) => s.id));
  const results = db.results.filter((r) => ids.has(r.sessionId));
  return { sessions, results };
}

function score(r: Result) {
  return r.testScore ?? r.primaryScore;
}

export function computeAnalytics(sessionId?: string) {
  const { sessions, results } = dataset(sessionId);
  const examCode = sessions[0]?.examCode ?? 'math-profile';
  const year = Number(sessions[0]?.date.slice(0, 4) ?? 2026);
  const scale = scaleFor(examCode, year);
  const scores = results.map(score);
  const threshold = scale?.threshold ?? 27;

  // A6 «Контроль»: полнота и диапазоны
  const quality: { check: string; status: 'ok' | 'warn' | 'error'; value: string }[] = [];
  const seen = new Map<string, number>();
  for (const r of results) seen.set(r.attemptId, (seen.get(r.attemptId) ?? 0) + 1);
  const duplicates = [...seen.values()].filter((c) => c > 1).length;
  const incomplete = results.filter((r) => {
    const a = byId(db.attempts, r.attemptId);
    const v = a && byId(db.variants, a.variantId);
    return !v || r.tasks.length !== v.keys.length;
  }).length;
  const outOfRange = results.filter((r) => r.primaryScore < 0 || r.primaryScore > r.maxPrimary || (r.testScore !== undefined && (r.testScore < 0 || r.testScore > 100))).length;
  quality.push({ check: 'Полнота записей по заданиям', status: incomplete ? 'error' : 'ok', value: `${incomplete} неполных` });
  quality.push({ check: 'Баллы в допустимом диапазоне', status: outOfRange ? 'error' : 'ok', value: `${outOfRange} вне диапазона` });
  quality.push({ check: 'Дубликаты работ', status: duplicates ? 'error' : 'ok', value: `${duplicates}` });
  quality.push({ check: 'Шкала перевода загружена', status: scale ? 'ok' : 'error', value: scale ? `версия ${scale.version}` : 'нет' });
  if (scale) {
    const errs = validateScale(scale.kind, scale.values, scale.threshold, scale.values.length - 1);
    quality.push({ check: 'Монотонность и диапазон шкалы', status: errs.length ? 'error' : 'ok', value: errs.length ? errs[0].detail : 'соответствует' });
  }

  // A2 «Статистика»
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: 0 }));
  for (const s of scores) bins[Math.min(9, Math.floor(s / 10))].count++;
  const groups = [
    { label: `Ниже порога (0–${threshold - 1})`, count: scores.filter((s) => s < threshold).length },
    { label: `${threshold}–60`, count: scores.filter((s) => s >= threshold && s <= 60).length },
    { label: '61–80', count: scores.filter((s) => s > 60 && s <= 80).length },
    { label: '81–100', count: scores.filter((s) => s > 80).length },
  ];

  const variantKeys = new Map<number, { difficulty: string; maxScore: number; part: number }>();
  for (const v of db.variants.filter((x) => x.examCode === examCode))
    for (const k of v.keys) if (!variantKeys.has(k.number)) variantKeys.set(k.number, { difficulty: k.difficulty, maxScore: k.maxScore, part: k.part });

  const tasks = [...variantKeys.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, meta]) => {
      const rows = results.map((r) => r.tasks.find((t) => t.number === number)).filter(Boolean) as Result['tasks'];
      const rate = rows.length ? mean(rows.map((t) => t.score / t.maxScore)) : 0;
      const full = rows.length ? rows.filter((t) => t.score === t.maxScore).length / rows.length : 0;
      // Процент выполнения по группам подготовки (ТЗ АО FR-31)
      const byGroup = groups.map((g, gi) => {
        const inGroup = results.filter((r) => {
          const s = score(r);
          return gi === 0 ? s < threshold : gi === 1 ? s >= threshold && s <= 60 : gi === 2 ? s > 60 && s <= 80 : s > 80;
        });
        const t = inGroup.map((r) => r.tasks.find((x) => x.number === number)).filter(Boolean) as Result['tasks'];
        return t.length ? round((mean(t.map((x) => x.score / x.maxScore)) * 100), 0) : null;
      });
      let status: 'norm' | 'analyze' | 'low' | 'high' = 'norm';
      if (rate < THRESHOLDS.taskVeryLow[meta.difficulty]) status = 'low';
      else if (rate < THRESHOLDS.taskLow[meta.difficulty]) status = 'analyze';
      else if (rate > THRESHOLDS.taskHigh) status = 'high';
      return { number, part: meta.part, difficulty: meta.difficulty, maxScore: meta.maxScore, correctRate: round(rate * 100), fullRate: round(full * 100), byGroup, status };
    });

  // Регионы — из справочника ППЭ (код и наименование субъекта РФ)
  const regionList = [...new Map(db.ppes.map((p) => [p.regionCode, { code: p.regionCode, name: p.region }])).values()];
  const regionRows = regionList.map((reg) => {
    const rs = results.filter((r) => byId(db.participants, r.participantId)?.regionCode === reg.code).map(score);
    return { code: reg.code, name: reg.name, count: rs.length, mean: round(mean(rs)), median: median(rs), thresholdRate: rs.length ? round((rs.filter((s) => s >= threshold).length / rs.length) * 100) : 0 };
  }).filter((r) => r.count > 0);

  // A3 «Аномалии»
  const anomalies: { id: string; type: string; object: string; metric: string; value: string; threshold: string; severity: 'critical' | 'warning' | 'info'; decision: string }[] = [];
  if (duplicates) anomalies.push({ id: 'dup', type: 'Дубликаты', object: 'Набор данных', metric: 'Повторные записи работ', value: String(duplicates), threshold: '0', severity: 'critical', decision: 'Заблокировать публикацию до проверки' });
  if (outOfRange) anomalies.push({ id: 'range', type: 'Диапазонная', object: 'Набор данных', metric: 'Баллы вне диапазона', value: String(outOfRange), threshold: '0', severity: 'critical', decision: 'Исправить исходные данные' });
  if (incomplete) anomalies.push({ id: 'tech', type: 'Техническая', object: 'Набор данных', metric: 'Отсутствуют обязательные значения', value: String(incomplete), threshold: '0', severity: 'critical', decision: 'Запросить данные у Backend' });
  for (const t of tasks) {
    if (t.status === 'low' || t.status === 'analyze')
      anomalies.push({ id: `task-${t.number}`, type: 'Задание', object: `Задание ${t.number}`, metric: 'Процент выполнения', value: pct(t.correctRate), threshold: `< ${pct(Math.round(THRESHOLDS.taskLow[t.difficulty] * 100))}`, severity: t.status === 'low' ? 'warning' : 'info', decision: 'Передать предметному специалисту' });
    if (t.status === 'high')
      anomalies.push({ id: `task-${t.number}`, type: 'Задание', object: `Задание ${t.number}`, metric: 'Процент выполнения', value: pct(t.correctRate), threshold: `> ${pct(Math.round(THRESHOLDS.taskHigh * 100))}`, severity: 'info', decision: 'Проверить дискриминативность задания' });
  }
  for (const r of regionRows) {
    const others = regionRows.filter((x) => x.code !== r.code).map((x) => x.mean);
    const sd = stdev(others);
    const m = mean(others);
    if (others.length >= 2 && sd > 0 && Math.abs(r.mean - m) > THRESHOLDS.regionSigma * sd)
      anomalies.push({ id: `region-${r.code}`, type: 'Региональная', object: r.name, metric: 'Средний балл', value: ru(r.mean), threshold: `${ru(m)} ± ${THRESHOLDS.regionSigma}σ, σ = ${ru(sd)}`, severity: 'warning', decision: 'Проверить состав выборки' });
  }
  const fast = results.filter((r) => {
    const a = byId(db.attempts, r.attemptId);
    if (!a?.t0 || !a.finishedAt) return false;
    const minutes = (new Date(a.finishedAt).getTime() - new Date(a.t0).getTime()) / 60_000;
    return minutes < THRESHOLDS.fastMinutes && r.primaryScore >= r.maxPrimary * THRESHOLDS.fastShare;
  });
  if (fast.length)
    anomalies.push({ id: 'time-fast', type: 'Временная', object: `${fast.length} работ`, metric: 'Высокий балл при длительности', value: `< ${THRESHOLDS.fastMinutes} мин`, threshold: `≥ ${pct(Math.round(THRESHOLDS.fastShare * 100))} макс. балла`, severity: 'warning', decision: 'Сверить с журналом целостности' });
  const prev = PREVIOUS[examCode];
  const m = mean(scores);
  if (prev && scores.length && Math.abs(m - prev.mean) > 10)
    anomalies.push({ id: 'dist-shift', type: 'Распределение', object: EXAMS[examCode]?.title ?? examCode, metric: 'Сдвиг среднего к прошлому году', value: ru(m - prev.mean), threshold: '±10 баллов', severity: 'warning', decision: 'Проверить шкалу и контрольную группу' });

  const thresholdRate = scores.length ? scores.filter((s) => s >= threshold).length / scores.length : 0;
  const datasetVersion = sha256(results.map((r) => `${r.attemptId}:${r.primaryScore}:${r.scaleVersion}`).sort().join('|')).slice(0, 12);
  return {
    meta: {
      examCode,
      examTitle: EXAMS[examCode]?.title ?? examCode,
      year,
      sessions: sessions.map((s) => ({ id: s.id, date: s.date, status: s.resultsStatus })),
      datasetVersion,
      methodology: METHODOLOGY_VERSION,
      scaleVersion: scale?.version ?? '—',
      calculatedAt: new Date().toISOString(),
      thresholds: THRESHOLDS,
    },
    summary: {
      count: scores.length,
      meanPrimary: round(mean(results.map((r) => r.primaryScore))),
      mean: round(m),
      median: median(scores),
      min: scores.length ? Math.min(...scores) : 0,
      max: scores.length ? Math.max(...scores) : 0,
      stdev: round(stdev(scores)),
      threshold,
      thresholdRate: round(thresholdRate * 100),
      hundred: scores.filter((s) => s === 100).length,
    },
    previous: prev ?? null,
    distribution: bins,
    groups,
    tasks,
    regions: regionRows,
    anomalies,
    quality,
  };
}

export default async function analyticsRoutes(app: FastifyInstance) {
  const analyst = { preHandler: requireStaff('analyst', 'admin', 'observer') };

  app.get<{ Querystring: { sessionId?: string } }>('/analytics/overview', analyst, async (req) => {
    const t0 = performance.now();
    const data = computeAnalytics(req.query.sessionId);
    audit({ type: 'analytics.calculated', category: 'Аналитика', actorRole: req.principal!.roles.join(','), actorId: req.principal!.sub, object: data.meta.datasetVersion, details: `${data.summary.count} записей, ${Math.round(performance.now() - t0)} мс, методика ${METHODOLOGY_VERSION}` });
    return data;
  });

  /** Выгрузки results_summary, task_statistics, anomaly_flags (ТЗ АО 7.3), CSV UTF-8 «;». */
  app.get<{ Querystring: { set: 'task_statistics' | 'anomaly_flags' | 'regions'; sessionId?: string } }>('/analytics/export', analyst, async (req, reply) => {
    const d = computeAnalytics(req.query.sessionId);
    let rows: string[] = [];
    if (req.query.set === 'anomaly_flags') {
      rows = ['flag_id;type;object;metric;value;threshold;severity;decision', ...d.anomalies.map((a) => [a.id, a.type, a.object, a.metric, a.value, a.threshold, a.severity, a.decision].join(';'))];
    } else if (req.query.set === 'regions') {
      rows = ['region;count;mean;median;threshold_rate', ...d.regions.map((r) => [r.name, r.count, r.mean, r.median, r.thresholdRate].join(';'))];
    } else {
      rows = ['task;part;difficulty;max_score;correct_rate;full_rate;status', ...d.tasks.map((t) => [t.number, t.part, t.difficulty, t.maxScore, t.correctRate, t.fullRate, t.status].join(';'))];
    }
    rows.push(`# dataset=${d.meta.datasetVersion}; methodology=${d.meta.methodology}; scale=${d.meta.scaleVersion}`);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${req.query.set ?? 'task_statistics'}.csv"`)
      .send('﻿' + rows.join('\n') + '\n');
  });

  /** Проверка шкалы без загрузки (ТЗ АО FR-02, ТС-02). */
  app.post<{ Body: { examCode: string; values: number[]; threshold: number } }>(
    '/analytics/scales/check',
    {
      ...analyst,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['examCode', 'values', 'threshold'],
          properties: { examCode: { type: 'string' }, values: { type: 'array', items: { type: 'number' } }, threshold: { type: 'number' } },
        },
      },
    },
    async (req) => {
      const exam = EXAMS[req.body.examCode];
      const v = db.variants.find((x) => x.examCode === req.body.examCode);
      const maxPrimary = v ? v.keys.reduce((s, t) => s + t.maxScore, 0) : req.body.values.length - 1;
      const errors = validateScale(exam?.scale ?? 'test', req.body.values, req.body.threshold, maxPrimary);
      return { valid: !errors.length, errors, maxPrimary };
    },
  );
}

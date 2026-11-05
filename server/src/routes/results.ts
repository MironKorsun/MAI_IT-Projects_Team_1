import type { FastifyInstance } from 'fastify';
import type { AppealDto, MyResultDto } from '../../../shared/types';
import { db, byId, persist } from '../db';
import { ApiError, invalid } from '../errors';
import { audit } from '../audit';
import { requireKind } from '../auth';
import { scaleFor } from '../grading';
import { sessionTitle } from '../views';
import { nowIso, uuid } from '../util';

/** Модуль М6 «Результаты» (ТЗ СЧ FR-37, FR-49, FR-50). Эталоны не возвращаются. */
export default async function resultsRoutes(app: FastifyInstance) {
  const results = { preHandler: requireKind('results') };

  app.get('/me/results', results, async (req): Promise<MyResultDto[]> => {
    const pid = req.principal!.sub;
    return db.results
      .filter((r) => r.participantId === pid && r.status === 'published')
      .map((r) => {
        const s = byId(db.sessions, r.sessionId)!;
        const attempt = byId(db.attempts, r.attemptId)!;
        const scale = scaleFor(s.examCode, Number(s.date.slice(0, 4)));
        return {
          sessionId: s.id,
          examTitle: sessionTitle(s),
          date: s.date,
          primaryScore: r.primaryScore,
          maxPrimary: r.maxPrimary,
          testScore: r.testScore,
          grade: r.grade,
          threshold: scale?.threshold ?? 0,
          passed: r.passed,
          publishedAt: s.publishedAt!,
          appealWindow: s.appealWindow!,
          tasks: r.tasks.map((t) => ({
            number: t.number,
            part: t.part,
            score: t.score,
            maxScore: t.maxScore,
            answer: attempt.answers[t.taskId]?.value,
          })),
        };
      });
  });

  app.get('/me/appeals', results, async (req): Promise<AppealDto[]> =>
    db.appeals.filter((a) => a.participantId === req.principal!.sub).map(({ participantId: _p, ...a }) => a),
  );

  /** Подача апелляции в окне по серверному времени (FR-49). */
  app.post<{ Body: { sessionId: string; taskNumbers: number[]; text: string } }>(
    '/me/appeals',
    {
      ...results,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId', 'taskNumbers', 'text'],
          properties: {
            sessionId: { type: 'string' },
            taskNumbers: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'integer', minimum: 1 } },
            text: { type: 'string', minLength: 10, maxLength: 2000 },
          },
        },
      },
    },
    async (req): Promise<AppealDto> => {
      const pid = req.principal!.sub;
      const s = byId(db.sessions, req.body.sessionId);
      const result = s && db.results.find((r) => r.sessionId === s.id && r.participantId === pid && r.status === 'published');
      if (!s || !result) throw new ApiError(404, 'NOT_FOUND');
      const now = nowIso();
      if (!s.appealWindow || now < s.appealWindow.from || now > s.appealWindow.to)
        throw new ApiError(409, 'APPEAL_WINDOW_CLOSED', 'Срок подачи апелляции истёк', { window: s.appealWindow });
      const numbers = new Set(result.tasks.map((t) => t.number));
      const bad = req.body.taskNumbers.filter((n) => !numbers.has(n));
      if (bad.length) throw invalid([{ pointer: '/taskNumbers', detail: `Заданий ${bad.join(', ')} нет в работе` }], 'VALIDATION_FAILED', 422);
      if (db.appeals.some((a) => a.participantId === pid && a.sessionId === s.id && ['registered', 'reviewing'].includes(a.status)))
        throw new ApiError(409, 'INVALID_STATE', 'Апелляция по этому экзамену уже на рассмотрении');
      const appeal = {
        id: uuid(),
        number: `АП-${new Date().getFullYear()}-${String(db.appeals.length + 1).padStart(5, '0')}`,
        participantId: pid,
        sessionId: s.id,
        taskNumbers: [...new Set(req.body.taskNumbers)].sort((a, b) => a - b),
        text: req.body.text.trim(),
        status: 'registered' as const,
        createdAt: now,
        history: [{ status: 'registered' as const, at: now }],
      };
      db.appeals.push(appeal);
      audit({ type: 'appeal.registered', category: 'Администрирование', actorRole: 'participant', actorId: pid, object: appeal.number, requestId: req.id });
      persist();
      const { participantId: _p, ...dto } = appeal;
      return dto;
    },
  );
}

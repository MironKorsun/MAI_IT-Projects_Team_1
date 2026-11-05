import { useState } from 'react';
import type { ExamSessionDto } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { CountUp, ErrorBox, Skeleton, StatusBadge, useLoad } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Bars, Columns, Ring } from '../../components/charts';
import { fmtDate, fmtDateTime, fmtNum, fmtPct, plural } from '../../lib/format';

/**
 * Подсистема «Аналитическое обеспечение» (ТЗ АО): статистика A2, аномалии A3, отчётность A4, контроль A6.
 * Каждый показатель сопровождается версиями данных, методики и шкалы.
 */
interface Overview {
  meta: { examTitle: string; year: number; datasetVersion: string; methodology: string; scaleVersion: string; calculatedAt: string; sessions: { id: string; date: string }[] };
  summary: { count: number; meanPrimary: number; mean: number; median: number; min: number; max: number; stdev: number; threshold: number; thresholdRate: number; hundred: number };
  previous: { year: number; mean: number; median: number; thresholdRate: number } | null;
  distribution: { from: number; to: number; count: number }[];
  groups: { label: string; count: number }[];
  tasks: { number: number; part: number; difficulty: string; maxScore: number; correctRate: number; fullRate: number; byGroup: (number | null)[]; status: 'norm' | 'analyze' | 'low' | 'high' }[];
  regions: { code: string; name: string; count: number; mean: number; median: number; thresholdRate: number }[];
  anomalies: { id: string; type: string; object: string; metric: string; value: string; threshold: string; severity: 'critical' | 'warning' | 'info'; decision: string }[];
  quality: { check: string; status: 'ok' | 'warn' | 'error'; value: string }[];
}

const DIFF: Record<string, string> = { basic: 'Базовый', advanced: 'Повышенный', high: 'Высокий' };
// «Норма» — тихий текст; бейджи только у отклонений, чтобы исключения были заметны
const STATUS: Record<Overview['tasks'][number]['status'], { label: string; tone?: 'ok' | 'warn' | 'bad' | 'accent' }> = {
  norm: { label: 'норма' },
  analyze: { label: 'Требует анализа', tone: 'warn' },
  low: { label: 'Аномально низкое', tone: 'bad' },
  high: { label: 'Аномально высокое', tone: 'accent' },
};

function Delta({ now, prev, unit = '' }: { now: number; prev?: number; unit?: string }) {
  if (prev === undefined) return null;
  const d = Math.round((now - prev) * 10) / 10;
  return (
    <span className="small" style={{ color: d >= 0 ? 'var(--ok)' : 'var(--bad)' }}>
      {d >= 0 ? '▲' : '▼'} {fmtNum(Math.abs(d), 1)}
      {unit} к прошлому году
    </span>
  );
}

export default function Analytics() {
  const sessions = useLoad(() => staffApi.get<ExamSessionDto[]>('/exam-sessions'));
  const [sessionId, setSessionId] = useState('');
  const { data, error, reload } = useLoad(() => staffApi.get<Overview>(`/analytics/overview${sessionId ? `?sessionId=${sessionId}` : ''}`), [sessionId]);
  const [tab, setTab] = useState<'tasks' | 'regions'>('tasks');
  const published = sessions.data?.filter((s) => ['approved', 'published'].includes(s.resultsStatus)) ?? [];
  const s = data?.summary;
  const prev = data?.previous ?? undefined;
  const thresholdBin = data ? data.summary.threshold / 10 : 0;
  const maxPrimary = data ? data.tasks.reduce((sum, t) => sum + t.maxScore, 0) : 0;

  return (
    <>
      <PageHead
        eyebrow="Аналитическое обеспечение"
        title={data ? `${data.meta.examTitle}, ${data.meta.year}` : 'Аналитика результатов'}
        subtitle="Обезличенные агрегированные данные. Исходные результаты не изменяются."
      />
      {/* панель набора данных: выбор сессии слева, выгрузки справа — заголовок страницы остаётся в одну строку */}
      <div className="filter-bar reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <select className="select" style={{ width: 300, maxWidth: '100%' }} value={sessionId} onChange={(e) => setSessionId(e.target.value)} aria-label="Набор данных">
          <option value="">Все утверждённые сессии</option>
          {published.map((x) => (
            <option key={x.id} value={x.id}>
              {fmtDate(x.date)} · {x.title}
            </option>
          ))}
        </select>
        <div className="row wrap push" style={{ '--gap': '8px' } as React.CSSProperties}>
          <button type="button" className="btn" onClick={() => staffApi.download(`/analytics/export?set=task_statistics${sessionId ? `&sessionId=${sessionId}` : ''}`, 'task_statistics.csv')}>
            <Icon name="download" /> Статистика заданий, CSV
          </button>
          <button type="button" className="btn" onClick={() => staffApi.download(`/analytics/export?set=anomaly_flags${sessionId ? `&sessionId=${sessionId}` : ''}`, 'anomaly_flags.csv')}>
            <Icon name="download" /> Флаги аномалий, CSV
          </button>
        </div>
      </div>
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {!data && !error && <Skeleton h={400} r={24} />}
      {data && s && (
        <>
          <div className="row wrap reveal" style={{ '--i': 1, marginBottom: 16, '--gap': '8px' } as React.CSSProperties}>
            <span className="badge outline">
              <Icon name="layers" /> набор {data.meta.datasetVersion}
            </span>
            <span className="badge outline">
              <Icon name="book" /> методика {data.meta.methodology}
            </span>
            <span className="badge outline">
              <Icon name="scale" /> шкала {data.meta.scaleVersion}
            </span>
            <span className="badge outline">
              <Icon name="clock" /> расчёт {fmtDateTime(data.meta.calculatedAt)}
            </span>
          </div>

          <div className="bento reveal" style={{ '--i': 2 } as React.CSSProperties}>
            <div className="glass card stat kpi span-3">
              <span className="stat-label">Работ в наборе</span>
              <span className="stat-value">
                <CountUp value={s.count} />
              </span>
              <span className="small muted">стобалльников: {s.hundred}</span>
            </div>
            <div className="glass card stat kpi span-3">
              <span className="stat-label">Средний тестовый балл</span>
              <span className="stat-value">
                <CountUp value={s.mean} decimals={1} />
              </span>
              <Delta now={s.mean} prev={prev?.mean} />
            </div>
            <div className="glass card stat kpi span-3">
              <span className="stat-label">Медиана · σ</span>
              <span className="stat-value">
                <CountUp value={s.median} /> <span className="muted" style={{ fontSize: 20 }}>· {fmtNum(s.stdev, 1)}</span>
              </span>
              <span className="small muted">
                мин {s.min} · макс {s.max}
              </span>
            </div>
            <div className="glass card stat kpi span-3">
              <span className="stat-label">Средний первичный балл</span>
              <span className="stat-value">
                <CountUp value={s.meanPrimary} decimals={1} />
              </span>
              {maxPrimary > 0 && <span className="small muted">из {maxPrimary}</span>}
            </div>

            <section className="glass card span-8" style={{ minHeight: 360 }} aria-labelledby="dist-h">
              <div className="card-head wrap">
                <h2 id="dist-h" className="h3">
                  Распределение тестовых баллов
                </h2>
                <span className="meta">число участников по интервалам</span>
              </div>
              <Columns
                height={260}
                ariaLabel="Распределение тестовых баллов по интервалам"
                marker={{ at: thresholdBin, label: `порог ${s.threshold}` }}
                data={data.distribution.map((b) => ({
                  label: `${b.from}`,
                  value: b.count,
                  highlight: b.to >= s.threshold,
                  tip: (
                    <>
                      {b.from}–{b.to}: <b>{b.count}</b> ({fmtPct(s.count ? (b.count / s.count) * 100 : 0)})
                    </>
                  ),
                }))}
              />
            </section>
            <section className="glass card span-4 tile-col" aria-labelledby="thr-h">
              <div className="card-head">
                <h2 id="thr-h" className="h3">
                  Преодолели порог
                </h2>
                <span className="meta">
                  {s.threshold} {plural(s.threshold, 'балл', 'балла', 'баллов')}
                </span>
              </div>
              <div className="stack grow" style={{ '--gap': '12px', alignItems: 'center', justifyContent: 'center', textAlign: 'center' } as React.CSSProperties}>
                <Ring value={s.thresholdRate / 100} size={120} label={<span className="h2 num">{fmtPct(s.thresholdRate)}</span>} />
                <Delta now={s.thresholdRate} prev={prev ? prev.thresholdRate * 100 : undefined} unit=" п.п." />
              </div>
            </section>

            <section className="glass card span-6" aria-labelledby="grp-h">
              <div className="card-head">
                <h2 id="grp-h" className="h3">
                  Группы подготовки
                </h2>
                <span className="meta">доля участников</span>
              </div>
              <Bars rows={data.groups.map((g) => ({ label: g.label, value: s.count ? Math.round((g.count / s.count) * 1000) / 10 : 0 }))} max={Math.max(...data.groups.map((g) => (s.count ? (g.count / s.count) * 100 : 0)), 1)} />
            </section>
            <section className="glass card span-6" aria-labelledby="dq-h">
              <div className="card-head">
                <h2 id="dq-h" className="h3">
                  Контроль качества данных
                </h2>
              </div>
              <ul className="list-rows">
                {data.quality.map((q) => (
                  <li key={q.check}>
                    <span className="grow ink2">{q.check}</span>
                    {q.status === 'ok' ? (
                      // норма — контурный бейдж, цвет только у значка
                      <span className="badge outline">
                        <Icon name="check" style={{ color: 'var(--ok)' }} />
                        {q.value}
                      </span>
                    ) : (
                      <StatusBadge tone={q.status === 'warn' ? 'warn' : 'bad'} icon="alert">
                        {q.value}
                      </StatusBadge>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="glass table-panel span-12" aria-label="Статистика по срезам">
              <div className="card-head wrap" style={{ padding: '8px 16px 0', marginBottom: 8 }}>
                <div className="seg" role="group" aria-label="Срез">
                  <button type="button" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>
                    По заданиям
                  </button>
                  <button type="button" aria-pressed={tab === 'regions'} onClick={() => setTab('regions')}>
                    По регионам
                  </button>
                </div>
                <span className="small muted">{tab === 'tasks' ? 'процент выполнения = средний балл / максимальный балл' : 'тестовый балл, сравнение с сопоставимыми регионами'}</span>
              </div>
              {tab === 'tasks' ? (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Задание</th>
                        <th>Уровень</th>
                        <th style={{ width: '32%' }}>Выполнение</th>
                        <th className="r">Полный балл</th>
                        {data.groups.map((g) => (
                          <th key={g.label} className="r" title={`Выполнение в группе «${g.label}»`}>
                            {g.label.replace(/ \(.+\)/, '')}
                          </th>
                        ))}
                        <th>Статус</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tasks.map((t) => (
                        <tr key={t.number}>
                          <td>
                            <b className="num">{t.number}</b>
                          </td>
                          <td className="small muted">{DIFF[t.difficulty]}</td>
                          <td>
                            <div className="row" style={{ '--gap': '12px' } as React.CSSProperties}>
                              <div className="progress data grow" aria-hidden="true">
                                <i style={{ width: `${t.correctRate}%` }} />
                              </div>
                              <span className="small num" style={{ width: 56, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {fmtPct(t.correctRate)}
                              </span>
                            </div>
                          </td>
                          <td className="r small num nowrap">{fmtPct(t.fullRate)}</td>
                          {t.byGroup.map((v, i) => (
                            <td key={i} className="r small num muted nowrap">
                              {v === null ? '—' : fmtPct(v, 0)}
                            </td>
                          ))}
                          <td>
                            {t.status === 'norm' ? (
                              <span className="small muted">{STATUS.norm.label}</span>
                            ) : (
                              <StatusBadge tone={STATUS[t.status].tone} icon="alert">
                                {STATUS[t.status].label}
                              </StatusBadge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Регион</th>
                        <th className="r">Работ</th>
                        <th style={{ width: '34%' }}>Средний балл</th>
                        <th className="r">Медиана</th>
                        <th className="r">Преодолели порог</th>
                        <th>Флаг</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.regions.map((r) => {
                        const flagged = data.anomalies.some((a) => a.id === `region-${r.code}`);
                        return (
                          <tr key={r.code}>
                            <td>{r.name}</td>
                            <td className="r num">{r.count}</td>
                            <td>
                              <div className="row" style={{ '--gap': '12px' } as React.CSSProperties}>
                                <div className="progress data grow" aria-hidden="true">
                                  <i style={{ width: `${r.mean}%` }} />
                                </div>
                                <span className="small num" style={{ width: 40, textAlign: 'right' }}>
                                  {fmtNum(r.mean, 1)}
                                </span>
                              </div>
                            </td>
                            <td className="r num">{r.median}</td>
                            <td className="r num nowrap">{fmtPct(r.thresholdRate)}</td>
                            <td>{flagged ? <StatusBadge tone="warn" icon="alert">Отклонение &gt; 2σ</StatusBadge> : <span className="small muted">—</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="glass card span-8" aria-labelledby="an-h">
              <div className="card-head wrap">
                <h2 id="an-h" className="h3">
                  Очередь аномалий
                </h2>
                <span className="meta">флаг — повод для проверки, а не доказательство нарушения</span>
              </div>
              <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                {data.anomalies.map((a) => (
                  <div key={a.id} className="tile card-tight row top between anomaly" style={{ '--gap': '16px' } as React.CSSProperties}>
                    <div className="row top" style={{ '--gap': '12px' } as React.CSSProperties}>
                      <StatusBadge tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : undefined} icon={a.severity === 'info' ? 'info' : 'alert'}>
                        {a.severity === 'critical' ? 'Критично' : a.severity === 'warning' ? 'Внимание' : 'Инфо'}
                      </StatusBadge>
                      <div className="stack" style={{ '--gap': '2px' } as React.CSSProperties}>
                        <span className="small strong">
                          {a.type} · {a.object}
                        </span>
                        <span className="tiny muted">
                          {a.metric}: <b className="ink2">{a.value}</b> · порог {a.threshold}
                        </span>
                      </div>
                    </div>
                    <span className="tiny ink2 anomaly-decision">
                      {a.decision}
                    </span>
                  </div>
                ))}
                {!data.anomalies.length && <p className="small muted">Аномалий не выявлено.</p>}
              </div>
            </section>
            <ScaleCheck />
          </div>
        </>
      )}
    </>
  );
}

/** Проверка шкалы перевода без загрузки (ТЗ АО FR-01, FR-02, ТС-02). */
function ScaleCheck() {
  const [values, setValues] = useState('0, 6, 11, 17, 22, 27, 34, 42, 50, 62, 74, 86, 100');
  const [threshold, setThreshold] = useState(27);
  const [res, setRes] = useState<{ valid: boolean; errors: { detail: string }[]; maxPrimary: number }>();
  const run = async () => {
    const arr = values.split(/[;,\s]+/).filter(Boolean).map(Number);
    setRes(await staffApi.post('/analytics/scales/check', { examCode: 'math-profile', values: arr, threshold }));
  };
  return (
    <section className="glass card stack span-4" style={{ '--gap': '12px' } as React.CSSProperties} aria-labelledby="sc-h">
      <h2 id="sc-h" className="h3">
        Проверка шкалы перевода
      </h2>
      <p className="small muted">Значение для каждого первичного балла, неубывание, диапазон 0–100, порог внутри шкалы.</p>
      <textarea className="textarea mono" rows={3} style={{ fontSize: 13 }} value={values} onChange={(e) => setValues(e.target.value)} aria-label="Значения шкалы через запятую" />
      <div className="row wrap">
        <label className="row small" style={{ '--gap': '8px' } as React.CSSProperties}>
          Порог <input className="input" style={{ width: 88 }} type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </label>
        <button type="button" className="btn" onClick={run}>
          Проверить
        </button>
      </div>
      {res && (
        <div className="stack fade-in" style={{ '--gap': '6px' } as React.CSSProperties}>
          {res.valid ? <StatusBadge tone="ok" icon="checkCircle">Шкала корректна (0…{res.maxPrimary})</StatusBadge> : <StatusBadge tone="bad" icon="xCircle">Ошибок: {res.errors.length}</StatusBadge>}
          {res.errors.slice(0, 6).map((e, i) => (
            <span key={i} className="tiny">
              {e.detail}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

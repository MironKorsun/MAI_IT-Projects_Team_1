import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ExamSessionDto } from '../../../../shared/types';
import { RESULTS_STATUS_LABEL } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Confirm, ErrorBox, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, fmtDateTime, fmtMinutes, plural } from '../../lib/format';
import { SessionBadge, resultsTone } from './Sessions';

/** ЭФ-14 «Распределение» (FR-39) и ЭФ-16 «Публикация результатов» (FR-41). */
interface Validation {
  validationId?: string;
  hash: string;
  rows: number;
  errors: { line: number; detail: string }[];
}

const STEPS: ExamSessionDto['resultsStatus'][] = ['processing', 'calculated', 'approved', 'published'];

export default function SessionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: list, error, reload } = useLoad(() => staffApi.get<ExamSessionDto[]>('/exam-sessions'), [id]);
  const s = list?.find((x) => x.id === id);
  const [csv, setCsv] = useState('');
  const [val, setVal] = useState<Validation>();
  const [valErr, setValErr] = useState<unknown>();
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!s) return <Skeleton h={300} r={24} />;

  const validate = async () => {
    setBusy(true);
    setValErr(undefined);
    try {
      setVal(await staffApi.post<Validation>(`/exam-sessions/${s.id}/allocation/validate`, { csv }));
    } catch (e) {
      setValErr(e);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!val?.validationId) return;
    setBusy(true);
    try {
      const r = await staffApi.post<{ applied: number }>(`/exam-sessions/${s.id}/allocation`, { validationId: val.validationId, hash: val.hash });
      toast(`Распределение применено: ${r.applied} ${plural(r.applied, 'участник', 'участника', 'участников')}. Секреты рабочих мест перевыпущены.`, 'ok');
      setVal(undefined);
      setCsv('');
      await reload();
    } catch (e) {
      setValErr(e);
    } finally {
      setBusy(false);
    }
  };
  const loadFile = (f?: File) => f && f.text().then((t) => { setCsv(t); setVal(undefined); });
  const stepIdx = STEPS.indexOf(s.resultsStatus);

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/staff/admin/sessions" className="row" style={{ '--gap': '6px', display: 'inline-flex', color: 'inherit' } as React.CSSProperties}>
            <Icon name="arrowLeft" size={14} /> Экзаменационные сессии
          </Link>
        }
        title={s.title}
        subtitle={`${fmtDate(s.date)}, ${s.startLocal} (${s.tz}) · ${fmtMinutes(s.durationMin)} · ${s.attempts} ${plural(s.attempts, 'участник', 'участника', 'участников')}`}
        actions={
          <>
            <SessionBadge status={s.status} />
            <StatusBadge tone={resultsTone(s.resultsStatus)} icon="award">
              {RESULTS_STATUS_LABEL[s.resultsStatus]}
            </StatusBadge>
          </>
        }
      />

      <div className="bento reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <section className="glass card span-8" aria-labelledby="rooms-h">
          <div className="card-head wrap">
            <h2 id="rooms-h" className="h3">
              Аудитории
            </h2>
            <span className="meta">
              {s.rooms.length} ауд. · вариантов КИМ: {s.variants}
              {s.proctoring ? ' · прокторинг' : ''}
            </span>
          </div>
          {s.rooms.length ? (
            <div className="table-wrap" style={{ margin: '0 -16px' }}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>ППЭ</th>
                    <th>Аудитория</th>
                    <th className="r">Участников</th>
                    <th className="r">
                      <span className="sr-only">Открыть</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.rooms.slice(0, 8).map((r) => {
                    const url = `/staff/rooms/${r.id}`;
                    return (
                      <tr key={r.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest('a, button') && nav(url)}>
                        <td className="num">{r.ppeCode}</td>
                        <td>
                          <Link to={url} className="strong" style={{ color: 'inherit' }}>
                            Аудитория {r.number}
                          </Link>
                        </td>
                        <td className="r">{r.participants}</td>
                        <td className="r">
                          <Link to={url} className="btn-round" tabIndex={-1} aria-hidden="true">
                            <Icon name="chevronRight" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="small muted">Аудитории не назначены.</p>
          )}
          {s.rooms.length > 8 && (
            <p className="small muted" style={{ marginTop: 8 }}>
              и ещё {s.rooms.length - 8} ауд.
            </p>
          )}
        </section>

        <section className="glass card span-4 t-span-12 tile-col" aria-labelledby="res-h">
          <div className="card-head">
            <h2 id="res-h" className="h3">
              Результаты
            </h2>
          </div>
          {/* четыре полосы и одна подпись под ними: названия всех шагов в узкой колонке не помещаются */}
          <ol className="row" style={{ listStyle: 'none', padding: 0, margin: 0, '--gap': '6px' } as React.CSSProperties} aria-label="Статусы результатов" title={STEPS.map((st) => RESULTS_STATUS_LABEL[st]).join(' → ')}>
            {STEPS.map((st, i) => (
              <li key={st} style={{ flex: '1 1 0', minWidth: 0 }} aria-current={i === stepIdx ? 'step' : undefined}>
                <div aria-hidden="true" style={{ height: 6, borderRadius: 999, backgroundColor: i <= stepIdx ? 'var(--brand-line)' : 'var(--series-track)', transition: 'background-color 600ms var(--ease-out)' }} />
                <span className="sr-only">{RESULTS_STATUS_LABEL[st]}</span>
              </li>
            ))}
          </ol>
          <p className="small" style={{ marginTop: 8 }} aria-hidden="true">
            {stepIdx >= 0 && (
              <span className="muted">
                Шаг {stepIdx + 1} из {STEPS.length} ·{' '}
              </span>
            )}
            <span className="strong">{RESULTS_STATUS_LABEL[s.resultsStatus]}</span>
          </p>
          <p className="small muted" style={{ marginTop: 16 }}>
            {s.resultsStatus === 'published'
              ? `Опубликованы ${fmtDateTime(s.publishedAt)}. Окно апелляции до ${fmtDateTime(s.appealWindow?.to)}.`
              : s.resultsStatus === 'approved'
                ? 'Все работы рассчитаны, шкала загружена — результаты можно опубликовать.'
                : 'Публикация станет доступна, когда сервер присвоит результатам статус «Утверждены».'}
          </p>
          <div className="tile-foot row wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
            <button type="button" className="btn btn-primary" disabled={s.resultsStatus !== 'approved'} onClick={() => setPublish(true)}>
              <Icon name="upload" /> Опубликовать результаты
            </button>
            {s.resultsStatus === 'published' && (
              <button type="button" className="btn" onClick={() => staffApi.download(`/exam-sessions/${s.id}/results/export`, `results-${s.date}.csv`)}>
                <Icon name="download" /> Выгрузка CSV
              </button>
            )}
          </div>
        </section>

        {s.status === 'preparation' && (
          <section className="glass card span-12" aria-labelledby="alloc-h">
            <div className="card-head wrap">
              <div className="stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                <h2 id="alloc-h" className="h3">
                  Распределение участников (CSV)
                </h2>
                <span className="small muted">
                  Шаблон: <span className="mono">код_участника;код_ППЭ;аудитория;место</span>. Файл проверяется построчно и применяется только целиком.
                </span>
              </div>
              <label className="btn">
                <Icon name="upload" /> Выбрать файл
                <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => loadFile(e.target.files?.[0])} />
              </label>
            </div>
            <div className="stack">
              <textarea className="textarea mono" rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setVal(undefined); }} placeholder={'код_участника;код_ППЭ;аудитория;место\n7701-001-0001;7701;101;01'} aria-label="Содержимое файла распределения" />
              <div className="row wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
                <button type="button" className="btn" onClick={validate} disabled={!csv.trim() || busy}>
                  <Icon name="checkCircle" /> Проверить файл
                </button>
                <button type="button" className="btn btn-primary" onClick={apply} disabled={!val?.validationId || busy}>
                  Применить распределение
                </button>
              </div>
              {valErr ? <ErrorBox error={valErr} /> : null}
              {val && (
                <div className="tile card-tight stack fade-in" style={{ '--gap': '12px' } as React.CSSProperties} role="status">
                  {val.errors.length ? (
                    <>
                      <StatusBadge tone="bad" icon="xCircle">
                        Найдено ошибок: {val.errors.length} — файл не будет применён
                      </StatusBadge>
                      <div className="table-wrap">
                        <table className="table table-compact">
                          <thead>
                            <tr>
                              <th className="r">Строка</th>
                              <th>Причина</th>
                            </tr>
                          </thead>
                          <tbody>
                            {val.errors.slice(0, 50).map((e, i) => (
                              <tr key={i}>
                                <td className="r" style={{ width: 96 }}>
                                  {e.line}
                                </td>
                                <td className="small">{e.detail}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <StatusBadge tone="ok" icon="checkCircle">
                      Ошибок нет · строк: {val.rows}
                    </StatusBadge>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {publish && (
        <Confirm
          title="Опубликовать результаты?"
          confirmLabel="Опубликовать"
          onClose={() => setPublish(false)}
          onConfirm={async () => {
            await staffApi.post(`/exam-sessions/${s.id}/results/publish`);
            toast('Результаты опубликованы и доступны участникам', 'ok');
            await reload();
          }}
        >
          <p className="muted">Результаты станут доступны участникам в разделе «Мои результаты», откроется окно подачи апелляций — 2 рабочих дня.</p>
        </Confirm>
      )}
    </>
  );
}

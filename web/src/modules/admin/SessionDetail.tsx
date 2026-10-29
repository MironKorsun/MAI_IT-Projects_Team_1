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
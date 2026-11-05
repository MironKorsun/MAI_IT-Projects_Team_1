import { useState } from 'react';
import type { AppealDto, AppealStatus } from '../../../../shared/types';
import { APPEAL_STATUS_LABEL } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Confirm, Empty, ErrorBox, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDateTime, plural } from '../../lib/format';

/** Ведение статусов апелляций по решению конфликтной комиссии (ТЗ СЧ FR-50). */
type Row = AppealDto & { participantCode?: string };

export const appealTone = (s: AppealStatus) => (s === 'accepted' ? 'ok' : s === 'rejected' ? 'bad' : s === 'reviewing' ? 'accent' : undefined);

const STATUSES = Object.keys(APPEAL_STATUS_LABEL) as AppealStatus[];

export default function Appeals() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => staffApi.get<Row[]>('/appeals'));
  const [act, setAct] = useState<{ a: Row; status: 'reviewing' | 'accepted' | 'rejected' }>();
  const [comment, setComment] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<AppealStatus | ''>('');
  const needle = q.trim().toLowerCase();
  const rows = data?.filter((a) => (!status || a.status === status) && (!needle || a.number.toLowerCase().includes(needle) || !!a.participantCode?.toLowerCase().includes(needle)));
  const open = (a: Row, next: 'reviewing' | 'accepted' | 'rejected') => {
    setComment('');
    setAct({ a, status: next });
  };
  return (
    <>
      <PageHead eyebrow="Администрирование" title="Апелляции" subtitle="Статус меняется по решению конфликтной комиссии; удовлетворённая апелляция запускает перерасчёт." />
      <div className="reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="filter-bar" role="search">
          <div className="search">
            <Icon name="search" />
            <input className="input" type="text" placeholder="Номер апелляции или код участника" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск апелляции" />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as AppealStatus | '')} aria-label="Статус">
            <option value="">Все статусы</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {APPEAL_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {(q || status) && (
            <button type="button" className="btn btn-lg btn-ghost" onClick={() => { setQ(''); setStatus(''); }}>
              <Icon name="x" /> Сбросить
            </button>
          )}
          {rows && (
            <span className="small muted num push">
              {rows.length} {plural(rows.length, 'апелляция', 'апелляции', 'апелляций')}
            </span>
          )}
        </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        <section className="glass table-panel" aria-label="Апелляции" style={error ? { marginTop: 12 } : undefined}>
          {!rows && !error && <Skeleton h={200} />}
          {data && !data.length && <Empty icon="message">Апелляций пока нет.</Empty>}
          {data && data.length > 0 && rows && !rows.length && <Empty icon="search">По заданным условиям апелляций нет.</Empty>}
          {rows && rows.length > 0 && (
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>Участник</th>
                    <th>Задания</th>
                    <th>Обоснование</th>
                    <th>Подана</th>
                    <th>Статус</th>
                    <th className="r">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className="mono small" data-label="Номер">
                        {a.number}
                      </td>
                      <td className="mono small" data-label="Участник">
                        {a.participantCode}
                      </td>
                      <td className="small num" data-label="Задания">
                        {a.taskNumbers.join(', ')}
                      </td>
                      <td className="small" data-label="Обоснование">
                        <div style={{ maxWidth: 360, padding: '8px 0' }}>{a.text}</div>
                      </td>
                      <td className="small muted num" data-label="Подана">
                        {fmtDateTime(a.createdAt)}
                      </td>
                      <td data-label="Статус">
                        <StatusBadge tone={appealTone(a.status)}>{APPEAL_STATUS_LABEL[a.status]}</StatusBadge>
                      </td>
                      <td className="r" data-label="Действия">
                        <div className="row-actions">
                          {a.status === 'registered' && (
                            <button type="button" className="btn btn-sm" onClick={() => open(a, 'reviewing')}>
                              На рассмотрение
                            </button>
                          )}
                          {a.status === 'reviewing' && (
                            <>
                              <button type="button" className="btn btn-sm" onClick={() => open(a, 'accepted')}>
                                Удовлетворить
                              </button>
                              <button type="button" className="btn btn-sm btn-danger" onClick={() => open(a, 'rejected')}>
                                Отклонить
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {act && (
        <Confirm
          title={`${APPEAL_STATUS_LABEL[act.status]} · ${act.a.number}`}
          confirmLabel="Сохранить"
          secondStep={act.status !== 'reviewing'}
          onClose={() => setAct(undefined)}
          onConfirm={async () => {
            await staffApi.patch(`/appeals/${act.a.id}`, { status: act.status, comment: comment || undefined });
            toast('Статус апелляции изменён', 'ok');
            await reload();
          }}
        >
          <label className="field">
            <span className="label">Комментарий (виден участнику)</span>
            <textarea className="textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
          </label>
        </Confirm>
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ATTEMPT_STATE_LABEL, type AttemptState, type AuditEventDto } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { EventChannel } from '../../lib/ws';
import { PageHead } from '../../components/Shell';
import { CountUp, ErrorBox, Skeleton, StatusBadge, useLoad } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Line } from '../../components/charts';
import { fmtTime, plural, tzOffset } from '../../lib/format';
import { eventLabel } from './AuditLog';

/** ЭФ-17 «Сводная панель» Ситуационного центра (ТЗ КЧ FR-43, FR-45): обновление не реже 1 раза в 30 с. */
interface Summary {
  generatedAt: string;
  connections: number;
  timeline: { minute: string; count: number }[];
  ppes: {
    id: string;
    code: string;
    name: string;
    region: string;
    tz: string;
    rooms: { id: string; number: string; session: string; startedAt?: string; states: Partial<Record<AttemptState, number>>; participants: number; integrity: number; incidents: number; offline: number }[];
  }[];
}

const ORDER: AttemptState[] = ['assigned', 'waiting', 'loading', 'inProgress', 'finished', 'timeExpired', 'removed', 'notCompleted'];

/** Сколько последних записей журнала показывать в карточке «События». */
const RECENT = 8;

export default function MonitorDashboard() {
  const { data, error, reload } = useLoad(() => staffApi.get<Summary>('/monitoring/summary', { background: true }));
  const recent = useLoad(() => staffApi.get<{ items: AuditEventDto[] }>(`/audit-events?limit=${RECENT}`, { background: true }));
  const reloadRecent = recent.reload;
  const [pulse, setPulse] = useState(0);
  const nav = useNavigate();

  useEffect(() => {
    const refresh = () => {
      void reload();
      void reloadRecent();
    };
    const t = setInterval(refresh, 30_000);
    let pending: number | undefined;
    const ch = new EventChannel(staffApi, {
      onEvent: () => {
        setPulse((p) => p + 1);
        clearTimeout(pending);
        pending = window.setTimeout(refresh, 1500);
      },
    });
    const stop = ch.start();
    return () => {
      clearInterval(t);
      clearTimeout(pending);
      stop();
    };
  }, [reload, reloadRecent]);

  const totals = useMemo(() => {
    const t = { participants: 0, inProgress: 0, finished: 0, integrity: 0, incidents: 0, offline: 0, rooms: 0 };
    for (const p of data?.ppes ?? [])
      for (const r of p.rooms) {
        t.rooms++;
        t.participants += r.participants;
        t.inProgress += r.states.inProgress ?? 0;
        t.finished += (r.states.finished ?? 0) + (r.states.timeExpired ?? 0);
        t.integrity += r.integrity;
        t.incidents += r.incidents;
        t.offline += r.offline;
      }
    return t;
  }, [data]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;

  return (
    <>
      <PageHead
        eyebrow="Ситуационный центр Рособрнадзора"
        title="Сводная панель"
        subtitle="Только чтение. Данные обновляются автоматически."
        actions={
          <>
            <span className="badge" key={pulse}>
              <span className="dot live" style={{ color: 'var(--ok)' }} aria-hidden="true" /> обновлено {data ? fmtTime(data.generatedAt, undefined, true) : '…'}
            </span>
            <Link to="/staff/monitor/log" className="btn">
              <Icon name="list" /> Журнал событий
            </Link>
          </>
        }
      />
       <div className="bento reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <Kpi label="Участников в активных сессиях" value={totals.participants} sub={`${totals.rooms} ${plural(totals.rooms, 'аудитория', 'аудитории', 'аудиторий')}`} />
        <Kpi label="Выполняют работу" value={totals.inProgress} sub={`${totals.offline} без связи > 60 с`} warn={totals.offline > 0} />
        <Kpi label="События целостности" value={totals.integrity} sub="за текущие сессии" />
        <Kpi label="Акты о нарушениях" value={totals.incidents} warn={totals.incidents > 0} sub={`${data?.connections ?? 0} ${plural(data?.connections ?? 0, 'подключение', 'подключения', 'подключений')} к каналу`} />

        <div className="xl-span-8 stack" style={{ '--gap': '12px', minWidth: 0 } as React.CSSProperties}>
          {!data && <Skeleton h={260} r={24} />}
          {data?.ppes
            .filter((p) => p.rooms.length)
            .map((p) => (
              <section key={p.id} className="glass table-panel" aria-labelledby={`ppe-${p.id}`}>
                <div className="card-head" style={{ padding: '8px 8px 0 16px', marginBottom: 8 }}>
                  <div className="stack" style={{ '--gap': '2px', minWidth: 0 } as React.CSSProperties}>
                    <h2 id={`ppe-${p.id}`} className="h3">
                      ППЭ {p.code} · {p.region}
                    </h2>
                    <span className="small muted">
                      {p.name} · {tzOffset(p.tz)}
                    </span>
                  </div>
                  <span className="meta num">{p.rooms.length} ауд.</span>
                </div>
                 <div className="table-wrap">
                  <table className="table table-live">
                    <thead>
                      <tr>
                        <th>Аудитория</th>
                        <th>Старт</th>
                        <th>Состояния попыток</th>
                        <th className="r">Целостность</th>
                        <th className="r">Акты</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.rooms.map((r) => {
                        const url = `/staff/rooms/${r.id}`;
                        return (
                          // Вся строка ведёт на карточку аудитории; ссылка на номере — для клавиатуры и чтения с экрана
                          <tr key={r.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest('a, button') && nav(url)}>
                            <td className="nowrap">
                              <Link to={url} className="strong" style={{ color: 'inherit' }} aria-label={`Аудитория ${r.number}, карточка`}>
                                {r.number}
                              </Link>{' '}
                              <span className="small muted">· {r.participants} уч.</span>
                            </td>
                            <td className="num nowrap">{r.startedAt ? fmtTime(r.startedAt, p.tz) : <span className="small muted">не начат</span>}</td>
                            <td style={{ minWidth: 240, paddingTop: 10, paddingBottom: 10 }}>
                              <StateBar states={r.states} total={r.participants} />
                            </td>
                            <td className="r num">{r.integrity ? <span className="badge warn">{r.integrity}</span> : '0'}</td>
                            <td className="r num">{r.incidents ? <span className="badge bad">{r.incidents}</span> : '0'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
        </div>

        <aside className="glass card xl-span-4 sticky-aside" aria-labelledby="events-h">
          <div className="card-head">
            <h2 id="events-h" className="h3">
              События
            </h2>
            <Link to="/staff/monitor/log" className="btn btn-sm btn-ghost">
              Весь журнал <Icon name="arrowRight" />
            </Link>
          </div>
          <div className="stack" style={{ '--gap': '2px', marginBottom: 8 } as React.CSSProperties}>
            <span className="small ink2">Целостность за последний час</span>
            <span className="tiny muted">шаг 5 минут</span>
          </div>
          {data && data.timeline.every((p) => !p.count) ? (
            // та же высота, что у графика: карточка не прыгает, когда приходит первое событие
            <div className="tile row center small muted" style={{ height: 110, '--gap': '8px' } as React.CSSProperties}>
              <Icon name="check" size={18} /> За последний час событий нет
            </div>
          ) : data ? (
            <Line points={data.timeline.map((p) => ({ x: p.minute, y: p.count }))} height={110} ariaLabel="События целостности за последний час" format={(p) => <><b>{p.y}</b> · {fmtTime(p.x + ':00Z')}</>} />
          ) : (
            <Skeleton h={110} />
            )}
          <div className="divider" style={{ margin: '16px 0 4px' }} />
          {recent.data ? (
            recent.data.items.length ? (
              <ul className="list-rows" aria-label="Последние записи журнала">
                {recent.data.items.map((e) => (
                  <li key={e.id}>
                    <span className="stack grow" style={{ '--gap': '0' } as React.CSSProperties}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{eventLabel(e.type)}</span>
                      <span className="tiny muted num">
                        {fmtTime(e.at, undefined, true)}
                        {e.ppeCode ? ` · ППЭ ${e.ppeCode}${e.roomNumber ? ` / ${e.roomNumber}` : ''}` : ''}
                      </span>
                    </span>
                    {e.result !== 'ok' && (
                      <StatusBadge tone="bad" icon="x">
                        отказ
                      </StatusBadge>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted" style={{ padding: '12px 0' }}>
                Записей пока нет.
              </p>
            )
          ) : recent.error ? (
            <p className="small muted" style={{ padding: '12px 0' }}>
              Не удалось загрузить последние записи журнала.
            </p>
          ) : (
            <Skeleton h={160} />
          )}
        </aside>
      </div>
    </>
  );
}

function Kpi({ label, value, sub, warn }: { label: string; value: number; sub?: string; warn?: boolean }) {
  return (
    <div className="glass card stat kpi span-3">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={warn ? { color: 'var(--warn)' } : undefined}>
        <CountUp value={value} />
      </span>
      {sub && <span className="small muted">{sub}</span>}
    </div>
  );
}

/** Распределение попыток по состояниям (B.12): спокойная палитра из токенов, у каждого цвета — подпись и число. */
const SHADE: Record<AttemptState, string> = {
  assigned: 'var(--st-assigned)',
  waiting: 'var(--st-waiting)',
  loading: 'var(--st-loading)',
  inProgress: 'var(--st-in-progress)',
  finished: 'var(--st-finished)',
  timeExpired: 'var(--st-time-expired)',
  removed: 'var(--st-removed)',
  notCompleted: 'var(--st-not-completed)',
};

function StateBar({ states, total }: { states: Partial<Record<AttemptState, number>>; total: number }) {
  const parts = ORDER.filter((s) => states[s]);
  return (
    <div className="stack" style={{ '--gap': '6px' } as React.CSSProperties}>
      <div className="row" style={{ '--gap': '2px', height: 8 } as React.CSSProperties} aria-hidden="true">
        {parts.map((s) => (
          <span key={s} style={{ height: 8, borderRadius: 4, background: SHADE[s], flex: `${states[s]} 1 0` }} />
        ))}
        {!total && <span style={{ height: 8, borderRadius: 4, background: 'var(--series-track)', flex: 1 }} />}
      </div>
      <div className="row wrap tiny ink2" style={{ '--gap': '4px 12px' } as React.CSSProperties}>
        {parts.map((s) => (
          <span key={s} className="row" style={{ '--gap': '6px' } as React.CSSProperties}>
            <span className="dot" style={{ color: SHADE[s] }} />
            {ATTEMPT_STATE_LABEL[s]}: <b className="num">{states[s]}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
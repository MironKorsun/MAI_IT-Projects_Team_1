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
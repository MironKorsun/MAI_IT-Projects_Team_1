import { Link } from 'react-router-dom';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Empty, ErrorBox, Skeleton, StatusBadge, useLoad } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, plural } from '../../lib/format';

interface RoomRow {
  id: string;
  number: string;
  ppe: { code: string; name: string };
  session: { title: string; date: string; startLocal: string };
  startedAt?: string;
  seats: number;
  participants: number;
}

/** «Вторник, 20 октября» — сегодняшняя дата для плашки в заголовке. */
function todayLabel() {
  const s = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function RoomsList() {
  const { data, error, reload } = useLoad(() => staffApi.get<RoomRow[]>('/rooms'));
  return (
    <>
      <PageHead
        eyebrow="Проведение экзамена"
        title="Мои аудитории"
        subtitle="Выберите аудиторию, чтобы подготовить рабочие места и провести экзамен."
        actions={
          <span className="pill">
            <Icon name="clock" /> {todayLabel()}
          </span>
        }
      />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      {!data && !error && <Skeleton h={200} r={24} />}
      {data && !data.length && (
        <div className="glass card">
          <Empty icon="users">Вам не назначены аудитории на текущие сессии.</Empty>
        </div>
      )}
{data && data.length > 0 && (
        <div className="bento reveal" style={{ '--i': 1 } as React.CSSProperties}>
          {data.map((r) => (
            <Link key={r.id} to={`/staff/rooms/${r.id}`} className="glass card span-4" style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 200 }}>
              <div className="card-head" style={{ marginBottom: 0 }}>
                <span className="eyebrow">Аудитория</span>
                <span className="btn-round ne" aria-hidden="true">
                  <Icon name="arrowRight" />
                </span>
              </div>
              <div className="value-xl">{r.number}</div>
              <dl className="kv">
                <dt>ППЭ</dt>
                <dd title={r.ppe.name}>{r.ppe.code}</dd>
                <dt>Участники</dt>
                <dd>
                  {r.participants} из {r.seats} {plural(r.seats, 'места', 'мест', 'мест')}
                </dd>
                <dt>Начало</dt>
                <dd>
                  {fmtDate(r.session.date)}, {r.session.startLocal}
                </dd>
              </dl>
              <div style={{ marginTop: 'auto' }}>
                {r.startedAt ? (
                  <StatusBadge tone="ok" live>
                    Экзамен идёт
                  </StatusBadge>
                ) : (
                  <StatusBadge icon="clock">Подготовка</StatusBadge>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

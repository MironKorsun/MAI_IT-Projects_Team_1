import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router-dom';
import type { AttemptState, RoomDto, SeatDto, WsEvent } from '../../../../shared/types';
import { ATTEMPT_STATE_LABEL, FINAL_STATES, INTEGRITY_LABEL } from '../../../../shared/types';
import { ApiError, staffApi, uuid } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { EventChannel } from '../../lib/ws';
import { PageHead } from '../../components/Shell';
import { Confirm, Empty, ErrorBox, Modal, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useStaff } from '../../components/StaffSession';
import { fmtDate, fmtTime, relTime, tzOffset } from '../../lib/format';
import './room.css';

/** ЭФ-07 «Аудитория: подготовка», ЭФ-08 «Аудитория: ход экзамена» (ТЗ КЧ FR-22–FR-29); М5 — без управления (FR-45). */

interface Dicts {
  incidentTypes: string[];
  compensationReasons: string[];
  earlyFinishReasons: string[];
}

type SeatKind = 'compensate' | 'incident' | 'early' | 'relocate';
type Action = { kind: SeatKind; seat: SeatDto } | { kind: 'start' } | { kind: 'code' } | { kind: 'message' } | { kind: 'links' };

function stateTone(s: SeatDto['participant']): 'ok' | 'warn' | 'bad' | 'accent' | undefined {
  if (!s) return undefined;
  if (s.offline) return 'warn';
  if (s.state === 'inProgress') return 'accent';
  if (s.state === 'finished' || s.state === 'timeExpired') return 'ok';
  if (s.state === 'removed') return 'bad';
  return undefined;
}

/** Состояние места для фильтра — то же, что показывает столбец «Состояние». */
type SeatStatus = AttemptState | 'offline' | 'free';
function seatStatus(s: SeatDto): SeatStatus {
  const p = s.participant;
  if (!p) return 'free';
  if (p.offline) return 'offline';
  return p.state;
}
const STATES: AttemptState[] = ['assigned', 'waiting', 'loading', 'inProgress', 'finished', 'timeExpired', 'removed', 'notCompleted'];
const STATUS_OPTIONS: [SeatStatus, string][] = [
  ...STATES.map((s): [SeatStatus, string] => [s, s === 'assigned' ? 'Не вошёл' : ATTEMPT_STATE_LABEL[s]]),
  ['offline', 'Нет связи'],
  ['free', 'Свободные места'],
];

export default function RoomPage() {
  const { id } = useParams();
  const { me } = useStaff();
  const toast = useToast();
  const { data: room, error, reload, setData } = useLoad(() => staffApi.get<RoomDto>(`/rooms/${id}`, { background: true }), [id]);
  const { data: dicts } = useLoad(() => staffApi.get<Dicts>('/dictionaries'));
  const [action, setAction] = useState<Action>();
  const [live, setLive] = useState(false);
  const [, tick] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SeatStatus | ''>('');

   // Канал событий; при недоступности — опрос не чаще 1 раза в 15 с (FR-25)
  useEffect(() => {
    if (!id) return;
    const ch = new EventChannel(staffApi, {
      onEvent: (e: WsEvent) => {
        if (e.type === 'participant.statusChanged') {
          const d = e.data as { workstationId: string; participant: SeatDto['participant'] };
          setData((r) =>
            r && {
              ...r,
              seats: r.seats.map((s) =>
                s.participant?.attemptId === d.participant?.attemptId ? (s.workstationId === d.workstationId ? { ...s, participant: d.participant } : { ...s, participant: undefined }) : s.workstationId === d.workstationId ? { ...s, participant: d.participant } : s,
              ),
            },
          );
        } else if (e.type === 'workstation.checked') {
          const d = e.data as { workstationId: string; check: SeatDto['check'] };
          setData((r) => r && { ...r, seats: r.seats.map((s) => (s.workstationId === d.workstationId ? { ...s, check: d.check } : s)) });
        } else if (e.type === 'integrity.event') {
          const d = e.data as { attemptId: string; type: string; at: string };
          setData((r) => r && { ...r, seats: r.seats.map((s) => (s.participant?.attemptId === d.attemptId ? { ...s, participant: { ...s.participant, lastIntegrity: { type: d.type, at: d.at } } } : s)) });
          toast(<span><b>{INTEGRITY_LABEL[d.type] ?? d.type}</b> · {fmtTime(d.at, undefined, true)}</span>);
        } else if (e.type === 'auth.lockout') {
          const d = e.data as { label: string };
          toast(<span><b>{d.label}</b>: вход заблокирован на 5 минут после 5 неудачных попыток</span>, 'bad');
        }
      },
      onStatus: setLive,
      onReconnect: () => void reload(),
    });
    return ch.start();
  }, [id, reload, setData, toast]);

  useEffect(() => {
    const t = setInterval(() => {
      tick((x) => x + 1);
      if (!live) void reload();
    }, 15_000);
    return () => clearInterval(t);
  }, [live, reload]);

  const stats = useMemo(() => {
    const seats = room?.seats ?? [];
    const withP = seats.filter((s) => s.participant);
    return {
      total: withP.length,
      loggedIn: withP.filter((s) => s.participant!.state !== 'assigned').length,
      checked: seats.filter((s) => s.check?.passed).length,
      inProgress: withP.filter((s) => s.participant!.state === 'inProgress').length,
      finished: withP.filter((s) => FINAL_STATES.includes(s.participant!.state)).length,
      offline: withP.filter((s) => s.participant!.offline),
      absent: withP.filter((s) => s.participant!.state === 'assigned'),
    };
  }, [room]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (room?.seats ?? []).filter((s) => {
      if (status && seatStatus(s) !== status) return false;
      if (!needle) return true;
      const p = s.participant;
      return [s.label, p?.displayName, p?.code].some((v) => v?.toLowerCase().includes(needle));
    });
  }, [room, q, status]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!room) return <Skeleton h={300} r={24} />;

  const manage = !!me?.roles.includes('organizer') && me.roomIds.includes(room.id);
  const started = !!room.startedAt;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    await fn();
    toast(ok, 'ok');
    await reload();
  };

  // Код аудитории — единственная мятная плитка экрана, занимает два ряда сетки
  const codeTile = (
    <div className="tile-accent card span-4 rows-2 room-code tile-col">
      <span className="stat-label" style={{ color: 'var(--ink-2)' }}>
        Код аудитории
      </span>
      <span className="code-xl" style={{ marginTop: 8 }}>
        {room.accessCode ?? (started ? 'истёк' : '— — —')}
      </span>
      {!started && <span className="small ink2" style={{ marginTop: 8 }}>{room.accessCode ? 'Назовите код участникам для входа.' : 'Выпустите код до входа участников.'}</span>}
      {room.accessCodeValidUntil && (
        <span className="small ink2" style={{ marginTop: started ? 8 : 4 }}>
          действует до {fmtTime(room.accessCodeValidUntil, room.ppe.tz)}
        </span>
      )}
      {manage && !started && (
        <div className="tile-foot">
          <button type="button" className="btn" onClick={() => setAction({ kind: 'code' })}>
            <Icon name="refresh" /> {room.accessCode ? 'Выпустить новый' : 'Выпустить код'}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <PageHead
        eyebrow={
          <>
            ППЭ {room.ppe.code} · {room.ppe.region} · {tzOffset(room.ppe.tz)}
          </>
        }
        title={`Аудитория ${room.number}`}
        subtitle={`${room.session.title} · ${fmtDate(room.session.date)}, начало ${room.session.startLocal} местного времени`}
        actions={
          <>
            {live ? (
              <span className="badge" title="Данные обновляются в реальном времени">
                <span className="dot live" style={{ color: 'var(--ok)' }} aria-hidden="true" /> В реальном времени
              </span>
            ) : (
              <span className="badge warn" title="Опрос раз в 15 секунд">
                <Icon name="wifiOff" /> Обновление раз в 15 с
              </span>
            )}
            {!manage && (
              <span className="badge outline">
                <Icon name="eye" /> Только просмотр
              </span>
            )}
            {manage && (
              <>
                <button type="button" className="btn" onClick={() => setAction({ kind: 'links' })}>
                  <Icon name="monitor" /> Ссылки мест
                </button>
                <button type="button" className="btn" onClick={() => setAction({ kind: 'message' })}>
                  <Icon name="message" /> Сообщение
                </button>
              </>
            )}
          </>
        }
      />
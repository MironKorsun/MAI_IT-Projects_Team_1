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

      <div className="bento reveal" style={{ '--i': 1, marginBottom: 32 } as React.CSSProperties}>
        {!started ? (
          <>
            <Stat className="span-4" label="Вошли в систему" value={`${stats.loggedIn} / ${stats.total}`} progress={stats.total ? stats.loggedIn / stats.total : 0} />
            <Stat className="span-4" label="Рабочие места проверены" value={`${stats.checked} / ${room.seats.length}`} progress={room.seats.length ? stats.checked / room.seats.length : 0} />
            {codeTile}
            <section className="glass card span-8 room-wide row between wrap" style={{ '--gap': '16px 24px' } as React.CSSProperties} aria-labelledby="start-h">
              <div className="stack" style={{ '--gap': '4px', flex: '1 1 240px' } as React.CSSProperties}>
                <h2 id="start-h" className="h3">
                  Старт экзамена
                </h2>
                <p className="small muted">{stats.loggedIn ? 'Участникам будет отправлен сигнал старта.' : 'Дождитесь входа участников.'}</p>
              </div>
              {manage && (
                <button type="button" className={stats.loggedIn ? 'btn btn-lg btn-brand' : 'btn btn-lg'} onClick={() => setAction({ kind: 'start' })} disabled={!stats.loggedIn}>
                  <Icon name="play" /> Начать экзамен
                </button>
              )}
            </section>
          </>
          ) : (
          <>
            <Stat className="span-4" label="Выполняют" value={String(stats.inProgress)} sub={`начало в ${fmtTime(room.startedAt, room.ppe.tz)}`} />
            <Stat className="span-4" label="Завершили" value={`${stats.finished} / ${stats.total}`} progress={stats.total ? stats.finished / stats.total : 0} />
            {codeTile}
            <section className="glass card span-8 room-wide row top wrap" style={{ '--gap': '16px 32px' } as React.CSSProperties} aria-label="Без связи">
              <div className="stat" style={{ flex: 'none' }}>
                <span className="stat-label">{'Без связи > 60 с'}</span>
                <span className="stat-value" style={stats.offline.length ? { color: 'var(--warn)' } : undefined}>
                  {stats.offline.length}
                </span>
              </div>
              <div className="row wrap grow" style={{ '--gap': '8px', alignSelf: 'center' } as React.CSSProperties}>
                {stats.offline.length ? (
                  stats.offline.map((s) => (
                    <StatusBadge key={s.workstationId} tone="warn" icon="wifiOff">
                      {s.label} · {s.participant!.displayName}
                    </StatusBadge>
                  ))
                ) : (
                  <span className="small muted">Все участники на связи.</span>
                )}
              </div>
            </section>
          </>
        )}
      </div>

      <div className="bento reveal" style={{ '--i': 2 } as React.CSSProperties}>
        <div className="span-12">
          <div className="filter-bar" role="search">
            <div className="search">
              <Icon name="search" />
              <input className="input" type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Место или участник" aria-label="Поиск по месту или участнику" />
            </div>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as SeatStatus | '')} aria-label="Состояние">
              <option value="">Все состояния</option>
              {STATUS_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <span className="small muted push">
              Показано {rows.length} из {room.seats.length}
            </span>
          </div>

          <section className="glass table-panel" aria-label="Участники аудитории">
            <div className="table-wrap">
              <table className="table table-live">
                <thead>
                  <tr>
                    <th>Место</th>
                    <th>Участник</th>
                    <th>Проверка места</th>
                    <th>Состояние</th>
                    <th className="r">Ответов</th>
                    <th>Активность</th>
                    <th>Целостность</th>
                    {/* ширина постоянная: кнопка «Действия» появляется у строк по ходу экзамена, столбцы не сдвигаются */}
                    {manage && (
                      <th className="r" style={{ width: 140 }}>
                        Действия
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const p = s.participant;
                    return (
                      <tr key={s.workstationId}>
                        <td className="strong nowrap">{s.label}</td>
                        <td>
                          {p ? (
                            <div className="stack" style={{ '--gap': '0' } as React.CSSProperties}>
                              <span className="nowrap">{p.displayName}</span>
                              <span className="tiny muted mono">{p.code}</span>
                            </div>
                          ) : (
                            <span className="muted">свободно</span>
                          )}
                        </td>
                        <td className="nowrap">
                          {s.check ? (
                            s.check.passed ? (
                              <StatusBadge tone="ok" icon="check">Пройдена</StatusBadge>
                            ) : (
                              <StatusBadge tone="bad" icon="x">Ошибка</StatusBadge>
                            )
                          ) : (
                            <span className="small muted">не выполнялась</span>
                          )}
                          </td>
                        <td className="nowrap">
                          {p ? (
                            <div className="row" style={{ '--gap': '6px' } as React.CSSProperties}>
                              <StatusBadge tone={stateTone(p)} icon={p.offline ? 'wifiOff' : undefined}>
                                {p.offline ? 'Нет связи' : p.state === 'assigned' ? 'Не вошёл' : ATTEMPT_STATE_LABEL[p.state]}
                              </StatusBadge>
                              {p.specialConditions.extraTime && <span className="badge outline" title="Особые условия: +1,5 ч">ОВЗ</span>}
                            </div>
                          ) : null}
                        </td>
                        <td className="r num nowrap">{p && p.state !== 'assigned' ? `${p.answered} / ${room.tasksCount}` : <span className="muted">—</span>}</td>
                        <td className="small muted nowrap">{p?.lastActivityAt ? relTime(p.lastActivityAt) : '—'}</td>
                        <td className="small">
                          {p?.lastIntegrity ? (
                            <span title={fmtTime(p.lastIntegrity.at, room.ppe.tz, true)}>
                              <StatusBadge tone="warn" icon="alert">{INTEGRITY_LABEL[p.lastIntegrity.type] ?? p.lastIntegrity.type}</StatusBadge>
                            </span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        {manage && (
                          <td className="r">
                            {p && !FINAL_STATES.includes(p.state) ? (
                              <div className="row-actions">
                                <SeatMenu seat={s} onPick={(kind) => setAction({ kind, seat: s })} started={started} />
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        )}
                      </tr>
 );
                  })}
                  {!rows.length && (
                    <tr>
                      <td colSpan={manage ? 8 : 7}>
                        <Empty icon="search">Нет мест, подходящих под условия поиска.</Empty>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {room.messages.length > 0 && (
          <section className="glass card span-12" aria-labelledby="msg-h">
            <div className="card-head">
              <h2 id="msg-h" className="h3">
                Сообщения участникам
              </h2>
              <span className="meta num">{room.messages.length}</span>
            </div>
            <ul className="list-rows">
              {room.messages.map((m) => (
                <li key={m.id}>
                  <span className="muted num" style={{ flex: 'none', width: 48 }}>
                    {fmtTime(m.at, room.ppe.tz)}
                  </span>
                  <span className="grow">{m.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {!manage && (
        <div style={{ marginTop: 24 }}>
          <Link to="/staff/monitor" className="btn btn-ghost">
            <Icon name="arrowLeft" /> К сводной панели
          </Link>
        </div>
      )}

      {action?.kind === 'code' && (
        <Confirm title="Выпустить новый код аудитории?" confirmLabel="Выпустить код" secondStep={false} onClose={() => setAction(undefined)} onConfirm={() => act(() => staffApi.post(`/rooms/${room.id}/access-code`), 'Новый код выпущен, прежний аннулирован')}>
          <p className="muted">Прежний код будет аннулирован. Участники, ещё не вошедшие в систему, должны будут ввести новый код.</p>
        </Confirm>
      )}
      {action?.kind === 'start' && (
        <Confirm title="Начать экзамен в аудитории?" confirmLabel="Начать экзамен" onClose={() => setAction(undefined)} onConfirm={() => act(() => staffApi.post(`/rooms/${room.id}/start`), 'Экзамен начат. Участникам отправлен сигнал старта.')}>
          <p className="muted">Вошедшим участникам ({stats.loggedIn}) будет отправлен сигнал старта, время старта зафиксирует сервер.</p>
          {stats.absent.length > 0 && (
            <div className="tile card-tight stack" style={{ '--gap': '6px' } as React.CSSProperties}>
              <span className="small strong">Не вошли в систему · {stats.absent.length}</span>
              {stats.absent.map((s) => (
                <span key={s.workstationId} className="small">
                  {s.label} — {s.participant!.displayName} <span className="muted mono">{s.participant!.code}</span>
                </span>
              ))}
            </div>
          )}
        </Confirm>
      )}
      {action?.kind === 'message' && <MessageDialog roomId={room.id} onClose={() => setAction(undefined)} onSent={() => act(async () => undefined, 'Сообщение отправлено участникам')} />}
      {action?.kind === 'links' && <LinksDialog room={room} onClose={() => setAction(undefined)} />}
      {action && 'seat' in action && dicts && <SeatAction action={action} room={room} dicts={dicts} onClose={() => setAction(undefined)} onDone={(ok) => act(async () => undefined, ok)} />}
    </>
  );
}

function Stat({ label, value, sub, progress, className = '' }: { label: string; value: string; sub?: string; progress?: number; className?: string }) {
  return (
    <div className={`glass card stat kpi ${className}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="small muted">{sub}</span>}
      {progress !== undefined && (
        <div className="progress" aria-hidden="true">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * Меню действий с местом: слой .menu.glass-float в document.body, позиция fixed от кнопки
 * (по правому краю, на 6 px ниже; не помещается — над кнопкой), поэтому прокрутка таблицы его не обрезает.
 * Закрывается по Esc (фокус — на кнопку), щелчку вне меню, прокрутке и выбору пункта; стрелки — между пунктами.
 */
function SeatMenu({ seat, onPick, started }: { seat: SeatDto; onPick: (k: SeatKind) => void; started: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const inProgress = seat.participant?.state === 'inProgress';
  // не вошёл в систему: доступен только перевод (акт и досрочное завершение сервер для него не принимает)
  const assigned = seat.participant?.state === 'assigned';

  useLayoutEffect(() => {
    const b = btn.current;
    const m = menu.current;
    if (!open || !b || !m) return;
    const r = b.getBoundingClientRect();
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    const below = r.bottom + 6;
    const above = r.top - 6 - h;
    m.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    m.style.top = `${below + h > window.innerHeight - 8 && above >= 8 ? above : below}px`;
    m.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // прокрутка сразу после открытия (кнопку довели до экрана, инерция колеса) и внутри меню не закрывает его
    const openedAt = performance.now();
    const onScroll = (e: Event) => {
      if (performance.now() - openedAt < 200 || menu.current?.contains(e.target as Node)) return;
      close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      btn.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    if (e.key === 'Tab') {
      // Tab уводит фокус дальше по странице — от кнопки меню
      setOpen(false);
      btn.current?.focus();
      return;
    }
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  };

  const pick = (k: SeatKind) => {
    // Фокус — на кнопку меню: туда же его вернёт закрытие диалога
    btn.current?.focus();
    setOpen(false);
    onPick(k);
  };

   return (
    <>
      <button ref={btn} type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen((v) => !v)}>
        Действия <Icon name="chevronDown" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} id={menuId} role="menu" aria-label={`Действия: ${seat.label}`} className="menu glass-float" onKeyDown={onMenuKey}>
            {inProgress && (
              <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => pick('compensate')}>
                <Icon name="clock" /> Компенсировать время
              </button>
            )}
            <button type="button" role="menuitem" tabIndex={-1} className="menu-item" onClick={() => pick('relocate')}>
              <Icon name="monitor" /> Перевести на другое место
            </button>
            {started && !assigned && (
              <button type="button" role="menuitem" tabIndex={-1} className="menu-item menu-item-wrap" onClick={() => pick('early')}>
                <Icon name="info" /> Не закончил по объективной причине
              </button>
            )}
            {!assigned && (
              <>
                <div className="menu-sep" role="separator" />
                <button type="button" role="menuitem" tabIndex={-1} className="menu-item danger" onClick={() => pick('incident')}>
                  <Icon name="alert" /> Акт о нарушении
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function SeatAction({ action, room, dicts, onClose, onDone }: { action: { kind: SeatKind; seat: SeatDto }; room: RoomDto; dicts: Dicts; onClose: () => void; onDone: (msg: string) => void }) {
  const p = action.seat.participant!;
  const [minutes, setMinutes] = useState(5);
  const [reason, setReason] = useState('');
  const [desc, setDesc] = useState('');
  const [target, setTarget] = useState('');
  // простой по данным сервера (из ответа 422): поле минут подсвечивается, лимит виден под полем
  const [avail, setAvail] = useState<number>();
  const minutesInvalid = avail !== undefined && minutes > avail;
  const free = room.seats.filter((s) => !s.participant && s.check?.passed);
  const who = `${p.displayName} (${action.seat.label})`;
  const map = {
    compensate: {
      title: 'Компенсация времени простоя',
      label: 'Компенсировать',
      second: false,
      danger: false,
      run: () => staffApi.post(`/attempts/${p.attemptId}/time-compensation`, { minutes, reason }),
      ok: `Время участника продлено на ${minutes} мин`,
      valid: !!reason && minutes > 0 && !minutesInvalid,
    },
    incident: {
      title: 'Акт об удалении участника',
      label: 'Оформить акт и удалить',
      second: true,
      danger: true,
      run: () => staffApi.post(`/attempts/${p.attemptId}/incidents`, { type: reason, description: desc }),
      ok: 'Акт оформлен, попытка завершена',
      valid: !!reason && desc.trim().length > 0,
    },
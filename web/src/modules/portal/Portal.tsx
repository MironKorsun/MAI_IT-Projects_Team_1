import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Backdrop, Brand, ContrastToggle, Skeleton, StatusBadge } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtMinutes, plural } from '../../lib/format';
import './portal.css';

/** Ответ GET /api/v1/public/overview (тип на сервере — routes/public.ts; веб его не импортирует). */
interface PublicOverview {
  exam: { title: string; year: number; kimVersion: string; tasksCount: number; durationMin: number; extraTimeMin: number; threshold: number };
  session: { date: string; startLocal: string; tz: string; status: SessionStatus } | null;
}
type SessionStatus = 'preparation' | 'active' | 'completed';

/** Сведения об экзамене, если сводка недоступна (C.1: 12 заданий, 235 мин, порог 27). */
const FALLBACK_EXAM: PublicOverview['exam'] = {
  title: 'Математика (профильный уровень)',
  year: 2026,
  kimVersion: '—',
  tasksCount: 12,
  durationMin: 235,
  extraTimeMin: 90,
  threshold: 27,
};

/** Статус сессии: полный текст и короткий — для телефона. */
const STATUS: Record<SessionStatus | 'none', { full: string; short: string }> = {
  preparation: { full: 'Подготовка аудиторий', short: 'Подготовка' },
  active: { full: 'Экзамен идёт', short: 'Экзамен идёт' },
  completed: { full: 'Сессия завершена', short: 'Завершена' },
  none: { full: 'Сессий сегодня нет', short: 'Сессий нет' },
};

const STEPS: { title: string; text: string }[] = [
  { title: 'Проверка места', text: 'Технический специалист запускает проверку браузера, экрана, связи и загрузки заданий.' },
  { title: 'Вход', text: 'Идентификатор участника и шестизначный код аудитории, который называет организатор.' },
  { title: 'Старт', text: 'Организатор начинает экзамен в аудитории. Отсчёт времени — с открытия варианта.' },
  { title: 'Завершение', text: 'Сводка заданий без ответа и подтверждение. После этого ответы не меняются.' },
];

const FEATURES: { title: string; text: string }[] = [
  { title: 'Автосохранение', text: 'Время последнего сохранения видно на экране' },
  { title: 'Работа без связи', text: 'Ответы шифруются (AES-256) и отправляются после восстановления связи' },
  { title: 'Защита заданий', text: 'Вариант расшифровывается только после начала экзамена' },
];

/** Порядок появления блока (E.3): строка заголовка — 0, ряды плиток — 1…3, стенд — 4. */
const at = (i: number) => ({ '--i': i }) as CSSProperties;

/** Дата «ГГГГ-ММ-ДД» в местном времени (без сдвига на сутки из-за UTC). */
function localDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
const dayMonth = (d: Date) => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/** Минуты в часах: 90 — «1,5», 60 — «1». */
const hours = (min: number) => (min / 60).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
/** «часа» после дробного числа, иначе по правилам согласования. */
const hoursWord = (min: number) => (min % 60 ? 'часа' : plural(min / 60, 'час', 'часа', 'часов'));

/** Главная страница: сведения об экзамене, входы для персонала и участников, учебный стенд. */
export default function Portal() {
  // undefined — загрузка; { ok: false } — сводка недоступна
  const [overview, setOverview] = useState<{ ok: true; data: PublicOverview } | { ok: false }>();
  const [today] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/public/overview')
      .then((r) => (r.ok ? (r.json() as Promise<PublicOverview>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!data?.exam) throw new Error('bad overview');
        if (alive) setOverview({ ok: true, data });
      })
      .catch(() => alive && setOverview({ ok: false }));
    return () => {
      alive = false;
    };
  }, []);

  const loading = !overview;
  const failed = overview?.ok === false;
  const exam = overview?.ok ? overview.data.exam : FALLBACK_EXAM;
  const session = overview?.ok ? overview.data.session : null;
  const status = session ? STATUS[session.status] : STATUS.none;
  const live = session?.status === 'active';
  const sessionDay = session ? localDate(session.date) : undefined;
  const version = exam.kimVersion && exam.kimVersion !== '—' ? exam.kimVersion : undefined;

  return (
    <div>
      <Backdrop />
      <div className="page">
        <header className="portal-head">
          <Brand href="/" />
          <ContrastToggle />
        </header>

        <main id="main">
          <div className="title-row reveal" style={at(0)}>
            <div className="titles">
              <span className="eyebrow">Единый государственный экзамен · {exam.year}</span>
              <h1 className="display">
                Математика <span>профильный уровень</span>
              </h1>
            </div>
            <div className="pills">
              {loading ? (
                <Skeleton h={44} w={240} r={999} />
              ) : (
                <>
                  <span className="pill">
                    <Icon name="clock" />
                    {session && sessionDay ? (
                      <span>
                        <b>Сессия:</b> {dayMonth(sessionDay)}, {session.startLocal}
                      </span>
                    ) : (
                      <span>
                        <b>Сегодня:</b> {dayMonth(today)}
                      </span>
                    )}
                  </span>
                  {!failed && (
                    <span className={`pill${live ? ' is-live' : ''}`}>
                      <span className={`dot${live ? ' live' : ' muted'}`} aria-hidden="true" />
                      {status.full === status.short ? (
                        <span>{status.full}</span>
                      ) : (
                        <>
                          <span className="hide-sm">{status.full}</span>
                          <span className="show-sm">{status.short}</span>
                        </>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="bento portal-bento">
            {/* A — единственная мятная плитка страницы, не ссылка */}
            <section className="tile-accent card span-6 t-span-12 min-264 tile-col pt-a reveal" style={at(1)} aria-labelledby="tile-a">
              <div className="card-head">
                <h2 id="tile-a" className="h2">
                  Экзаменационная работа
                </h2>
                <span className="badge glass">КИМ {exam.year}</span>
              </div>
              <div className="accent-stats">
                <div className="stat stat-xl">
                  <span className="stat-value">{exam.tasksCount}</span>
                  <span className="stat-label">{plural(exam.tasksCount, 'задание', 'задания', 'заданий')} с кратким ответом</span>
                </div>
                <div className="stat stat-xl">
                  <span className="stat-value">{exam.durationMin}</span>
                  <span className="stat-label">
                    {plural(exam.durationMin, 'минута', 'минуты', 'минут')} — {fmtMinutes(exam.durationMin)}
                  </span>
                </div>
                <div className="stat stat-xl">
                  <span className="stat-value">{exam.threshold}</span>
                  <span className="stat-label">минимальный тестовый балл</span>
                </div>
              </div>
              <div className="tile-foot">
                <div className="mini-cells" aria-hidden="true">
                  {Array.from({ length: exam.tasksCount }, (_, i) => (
                    <i key={i}>{i + 1}</i>
                  ))}
                </div>
                <span className="sr-only">
                  {exam.tasksCount} {plural(exam.tasksCount, 'задание', 'задания', 'заданий')}
                </span>
                <p className="caption">Ответ — целое число или конечная десятичная дробь. Проверка автоматическая.</p>
              </div>
            </section>
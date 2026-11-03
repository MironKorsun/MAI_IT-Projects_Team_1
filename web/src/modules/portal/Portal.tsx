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

            {/* B, C — вся карточка является ссылкой */}
            <Link to="/staff/login" className="glass card span-3 min-264 link-card pt-b reveal" style={at(1)} aria-labelledby="tile-b">
              <div className="link-card-top">
                <span className="icon-tile tile" aria-hidden="true">
                  <Icon name="shield" />
                </span>
                <span className="btn-round ne" aria-hidden="true">
                  <Icon name="arrowRight" />
                </span>
              </div>
              <div className="link-card-body">
                <h2 id="tile-b" className="h2">
                  Вход для персонала
                </h2>
                <p className="text">
                  <span className="hide-sm">Организаторы в аудиториях, администраторы, Ситуационный центр и аналитики.</span>
                  <span className="show-sm">Организаторы, администраторы, аналитики</span>
                </p>
                <p className="meta">Логин и пароль выдаёт администратор</p>
              </div>
            </Link>

            <Link to="/results" className="glass card span-3 min-264 link-card pt-c reveal" style={at(1)} aria-labelledby="tile-c">
              <div className="link-card-top">
                <span className="icon-tile tile" aria-hidden="true">
                  <Icon name="award" />
                </span>
                <span className="btn-round ne" aria-hidden="true">
                  <Icon name="arrowRight" />
                </span>
              </div>
              <div className="link-card-body">
                <h2 id="tile-c" className="h2">
                  Мои результаты
                </h2>
                <p className="text">
                  <span className="hide-sm">Тестовый и первичный балл, ответы по каждому заданию, подача апелляции.</span>
                  <span className="show-sm">Баллы, ответы по заданиям, апелляция</span>
                </p>
                <p className="meta">Вход по коду участника и PIN</p>
              </div>
            </Link>
    
            {/* D — порядок проведения */}
            <section className="glass card span-8 min-232 pt-d reveal" style={at(2)} aria-labelledby="tile-d">
              <div className="card-head">
                <h2 id="tile-d" className="h2">
                  Как проходит экзамен
                </h2>
                <span className="small muted">в аудитории ППЭ</span>
              </div>
              <ol className="steps">
                {STEPS.map((s, i) => (
                  <li key={s.title}>
                    <span className="step-num" aria-hidden="true">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <div>
                      <b>{s.title}</b>
                      <p>{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
  
            {/* E — расписание из /api/v1/public/overview */}
            <section className="glass card span-4 min-232 pt-e reveal" style={at(2)} aria-labelledby="tile-e">
              <div className="card-head">
                <h2 id="tile-e" className="h2">
                  Сессия
                </h2>
                {session && (
                  <StatusBadge live={live} className={live ? 'live' : undefined}>
                    {status.full}
                  </StatusBadge>
                )}
              </div>
              {loading ? (
                <Skeleton h={40} w="70%" />
              ) : session && sessionDay ? (
                <p className="date-line">
                  {dayMonth(sessionDay)}
                  <span className="muted">, {sessionDay.toLocaleDateString('ru-RU', { weekday: 'long' })}</span>
                </p>
              ) : (
                <p className="date-line is-text">{failed ? 'Расписание' : 'На сегодня экзамен не запланирован.'}</p>
              )}
              <dl className="kv" style={{ marginTop: 16 }}>
                {session && (
                  <>
                    <dt>Начало экзамена</dt>
                    <dd>{session.startLocal} по местному времени</dd>
                  </>
                )}
                <dt>Продолжительность</dt>
                <dd>{fmtMinutes(exam.durationMin)}</dd>
                <dt>Особые условия</dt>
                <dd>+{hours(exam.extraTimeMin)} ч для участников с ОВЗ</dd>
              </dl>
            </section>

            {/* F, G, H — сведения для участников */}
            <Link to="/exam" className="glass card span-4 pt-f link-card entry-accent reveal" style={at(3)} aria-labelledby="tile-f">
              <div className="link-card-top">
                <span className="icon-tile tile" aria-hidden="true">
                  <Icon name="monitor" />
                </span>
                <span className="btn-round ne" aria-hidden="true">
                  <Icon name="arrowRight" />
                </span>
              </div>
              <div className="link-card-body">
                <h2 id="tile-f" className="h2">
                  Участник экзамена
                </h2>
                <p className="text">
                  Экзамен проходит только в пункте проведения экзамена (ППЭ) — на рабочем месте, которое подготовил технический специалист.
                </p>
                <p className="meta">Вход по коду участника и коду аудитории от организатора</p>
              </div>
            </Link>

            <section className="glass card span-4 pt-g reveal" style={at(3)} aria-labelledby="tile-g">
              <div className="card-head">
                <h2 id="tile-g" className="h2">
                  Надёжность
                </h2>
                <span className="icon-tile tile" aria-hidden="true">
                  <Icon name="lock" />
                </span>
              </div>
              <ul className="feature-list">
                {FEATURES.map((f) => (
                  <li key={f.title}>
                    <Icon name="check" />
                    <b>{f.title}</b>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="glass card span-4 pt-h reveal" style={at(3)} aria-labelledby="tile-h">
              <div className="card-head">
                <h2 id="tile-h" className="h2">
                  Особые условия
                </h2>
                <span className="icon-tile tile" aria-hidden="true">
                  <Icon name="user" />
                </span>
              </div>
              <p className="tile-text">Для участников с ограниченными возможностями здоровья — по решению администратора:</p>
              <ul className="chip-list">
                <li className="chip-tile tile">
                  +{hours(exam.extraTimeMin)} {hoursWord(exam.extraTimeMin)} к продолжительности
                </li>
                <li className="chip-tile tile">Масштаб интерфейса 150 % или 200 %</li>
                <li className="chip-tile tile">Контрастная тема</li>
              </ul>
            </section>
          </div>

        </main>

        <footer className="portal-foot">
          <span>
            ВП ТС ЕГЭ · Математика (профильный уровень) · КИМ {exam.year}
            {version && `, версия ${version}`}
          </span>
          <span>Вопросы в день экзамена — к организатору в аудитории</span>
        </footer>
      </div>
    </div>
  );
}
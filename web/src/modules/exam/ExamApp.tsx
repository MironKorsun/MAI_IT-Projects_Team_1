import { useEffect, useLayoutEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ATTEMPT_STATE_LABEL } from '../../../../shared/types';
import { Backdrop, Brand } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, fmtMinutes, fmtTime } from '../../lib/format';
import { useExam, type ExamEngine } from './useExam';
import { TaskScreen } from './TaskScreen';
import { Markdown } from './Markdown';
import instruction from '../../../../kim/math-profile-2026/instruction.md?raw';
import './exam.css';

/**
 * Секрет рабочего места: из ссылки технического специалиста (#ws=… или ?ws=…) он сохраняется
 * на этом компьютере и убирается из адресной строки; дальше участник входит с главной страницы.
 */
function workstationSecret(fromQuery: string | null) {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('ws');
  const given = fromHash ?? fromQuery;
  try {
    if (given) {
      localStorage.setItem('ege-workstation', given);
      window.history.replaceState(null, '', '/exam');
      return given;
    }
    return localStorage.getItem('ege-workstation');
  } catch {
    return given;
  }
}

/** Модуль М1 «Экзамен» (ТЗ КЧ 5.2): ЭФ-01 — ЭФ-06. */
export default function ExamApp() {
  const [params] = useSearchParams();
  const [secret] = useState(workstationSecret(params.get('ws')));
  const exam = useExam(secret);
  const sc = exam.state?.specialConditions;

  // Особые условия участника: масштаб и контрастная тема (FR-20)
  useEffect(() => {
    const root = document.documentElement;
    if (sc?.contrast) root.dataset.theme = 'contrast';
    else delete root.dataset.theme;
    document.body.style.zoom = sc && sc.scale !== 100 ? String(sc.scale / 100) : '';
    if (sc && sc.scale !== 100) root.dataset.scale = String(sc.scale);
    else delete root.dataset.scale;
    return () => {
      delete root.dataset.scale;
      delete root.dataset.theme;
      document.body.style.zoom = '';
    };
  }, [sc?.contrast, sc?.scale]);

    useEffect(() => {
    document.title = 'Экзамен · ВП ТС ЕГЭ';
  }, []);

  // Новый шаг открывается с начала страницы: при масштабе 150/200 % инструктаж длинный,
  // и экран задания иначе унаследовал бы прокрутку (панель с таймером оказалась бы выше экрана)
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [exam.phase]);

  return (
    <>
      <Backdrop still={exam.phase === 'exam'} />
      {exam.phase === 'boot' && <Boot />}
      {exam.phase === 'check' && <CheckScreen exam={exam} />}
      {exam.phase === 'login' && <LoginScreen exam={exam} />}
      {exam.phase === 'brief' && <BriefScreen exam={exam} />}
      {exam.phase === 'loading' && <LoadingScreen exam={exam} />}
      {exam.phase === 'exam' && <TaskScreen exam={exam} />}
      {exam.phase === 'final' && <FinalScreen exam={exam} />}
      {exam.phase === 'fatal' && <Fatal text={exam.fatal} />}
    </>
  );
}

/** Экран по центру (загрузка, итог, сбой): колонка 560 px, без верхнего отступа `.page-narrow`. */
const CENTER = { '--w': '560px', '--pt': '0px' } as React.CSSProperties;

function Boot() {
  return (
    <main className="page-narrow screen-center" style={{ ...CENTER, alignItems: 'center' }}>
      <div className="spinner" role="status" aria-label="Загрузка" />
    </main>
  );
}

/**
 * Шаги до задания: шапка места всегда в колонке 1016 px (знак и «Рабочее место» не прыгают между шагами),
 * карточка шага — своей ширины по центру.
 */
function StepPage({ exam, w, children }: { exam: ExamEngine; w: number; children: React.ReactNode }) {
  return (
    <main className="page-narrow" style={{ '--w': '1016px', '--pt': '32px' } as React.CSSProperties}>
      <SeatHeader exam={exam} />
      <div style={{ width: `min(${w}px, 100%)`, marginInline: 'auto' }}>{children}</div>
    </main>
  );
}

function SeatHeader({ exam }: { exam: ExamEngine }) {
  // В данных место называется «Место 01» — в бейдже остаётся номер: «Рабочее место 01»
  const seat = exam.ws?.label.replace(/^место\s+/i, '');
  return (
    <div className="seat-head reveal" style={{ '--i': 0 } as React.CSSProperties}>
      <Brand />
      {exam.ws && (
        <span className="badge outline">
          <Icon name="monitor" /> Рабочее место {seat}
        </span>
      )}
    </div>
  );
}

/** ЭФ-01 «Готовность рабочего места» (FR-01). */
function CheckScreen({ exam }: { exam: ExamEngine }) {
  const [result, setResult] = useState<boolean>();
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setResult(undefined);
    setResult(await exam.runChecks());
    setRunning(false);
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
    return (
    <StepPage exam={exam} w={640}>
      <section className="glass panel card-lg stack reveal" style={{ '--i': 1, '--gap': '24px' } as React.CSSProperties} aria-labelledby="chk">
        <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
          <span className="eyebrow">Шаг 1 из 3</span>
          <h1 id="chk" className="h1">
            Готовность рабочего места
          </h1>
          <p className="muted">
            {exam.ws?.session.title} · {fmtDate(exam.ws?.session.date)}
          </p>
        </div>
                <ul className="check-list" aria-live="polite">
          {exam.checks.map((c) => (
            <li key={c.id} className="tile">
              <div className="stack" style={{ '--gap': '2px', minWidth: 0 } as React.CSSProperties}>
                <span className="small strong">
                  {c.label}
                  {!c.required && <span className="muted" style={{ fontWeight: 400 }}> · необязательно</span>}
                </span>
                {c.status === 'fail' && c.help && <span className="error-text">{c.help}</span>}
              </div>
              <div className="row small check-side" style={{ '--gap': '8px' } as React.CSSProperties}>
                {c.detail && <span className="muted detail">{c.detail}</span>}
                {c.status === 'pending' && <span className="spinner" aria-label="Проверяется" />}
                {c.status === 'ok' && (
                  <span className="badge ok">
                    <Icon name="check" /> Готово
                  </span>
                )}
                {c.status === 'fail' && (
                  <span className="badge bad">
                    <Icon name="x" /> Ошибка
                  </span>
                )}
              </div>
            </li>
          ))}
                  </ul>
        {result === false && (
          <div className="notice bad fade-in" role="alert">
            <span className="notice-body">
              <Icon name="alert" className="lead-icon" size={20} />
              <span>Обязательная проверка не пройдена — вход недоступен. Обратитесь к техническому специалисту и повторите проверку.</span>
            </span>
          </div>
        )}
        <div className="step-foot">
          <button type="button" className="btn btn-lg" onClick={run} disabled={running}>
            <Icon name="refresh" /> Повторить проверку
          </button>
          <button type="button" className="btn btn-lg btn-primary" onClick={exam.goLogin} disabled={!result}>
            Далее <Icon name="arrowRight" />
          </button>
        </div>
      </section>
    </StepPage>
  );
}

/** ЭФ-02 «Вход участника» (FR-02). */
function LoginScreen({ exam }: { exam: ExamEngine }) {
  const [code, setCode] = useState('');
  const [access, setAccess] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await exam.login(code.trim(), access.trim());
    setBusy(false);
  };
    return (
    <StepPage exam={exam} w={480}>
      <form className="glass panel card-lg stack reveal" style={{ '--i': 1, '--gap': '20px' } as React.CSSProperties} onSubmit={submit} noValidate>
        <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
          <span className="eyebrow">Шаг 2 из 3</span>
          <h1 className="h1">Вход участника</h1>
          <p className="muted small">Введите идентификатор участника и шестизначный код аудитории, который назовёт организатор.</p>
        </div>
        <label className="field">
          <span className="label">Идентификатор участника</span>
          <input className="input input-xl" value={code} onChange={(e) => setCode(e.target.value)} placeholder="0000-000-0000" autoComplete="off" autoFocus inputMode="numeric" />
        </label>
        <label className="field">
          <span className="label">Код аудитории</span>
          <input
            className="input input-xl code-input"
            value={access}
            onChange={(e) => setAccess(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••••"
            aria-describedby="code-hint"
          />
          <span id="code-hint" className="hint">
            Код действует до начала экзамена и 15 минут после него.
          </span>
        </label>
        {exam.loginError && (
          <div className="error-text" role="alert">
            {exam.loginError}
          </div>
        )}
        <button type="submit" className="btn btn-xl btn-primary btn-block" disabled={busy || !code || access.length !== 6}>
          {busy && <span className="spinner" />} Войти
        </button>
      </form>
    </StepPage>
  );
}

/** ЭФ-03 «Инструктаж» (FR-03): «Начать экзамен» активна только после старта аудитории. */
function BriefScreen({ exam }: { exam: ExamEngine }) {
  const s = exam.state!;
  const started = s.roomStarted;
  const name = s.participant.displayName;
  return (
    <StepPage exam={exam} w={1016}>
      <div className="brief-grid reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <section className="glass glass-thick card-xl" aria-labelledby="brief-h">
          <div className="eyebrow">Шаг 3 из 3 · Инструктаж</div>
          <h1 id="brief-h" className="h1" style={{ marginTop: 8 }}>
            Инструкция по выполнению работы
          </h1>
          <div className="identity tile">
            <Icon name="user" size={18} />
            <span>
              <span className="strong">{name}</span> <span className="muted">— проверьте, что это ваши данные. Если нет, поднимите руку.</span>
            </span>
          </div>
          <div className="brief-body">
            <Markdown text={instruction} skipTitle />
          </div>
                  </section>
        <aside className="brief-aside">
          <section className="glass card stack" style={{ '--gap': '16px' } as React.CSSProperties} aria-labelledby="params-h">
            <h2 id="params-h" className="h3">
              Параметры экзамена
            </h2>
            <dl className="kv">
              <dt>Участник</dt>
              <dd>{name}</dd>
              <dt>Предмет</dt>
              <dd>{s.exam.title}</dd>
              <dt>Продолжительность</dt>
              <dd>{fmtMinutes(s.exam.durationMin)}</dd>
              <dt>Заданий</dt>
              <dd>{s.exam.tasksCount}</dd>
              <dt>Аудитория</dt>
              <dd>
                {s.room.number}, ППЭ {s.room.ppeCode}
              </dd>
            </dl>
            {(s.specialConditions.extraTime || s.specialConditions.scale !== 100 || s.specialConditions.contrast) && (
              <div className="tile card-tight small stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                <span className="strong">Особые условия</span>
                {s.specialConditions.extraTime && <span>+1,5 часа к продолжительности</span>}
                {s.specialConditions.scale !== 100 && <span>Масштаб интерфейса {s.specialConditions.scale} %</span>}
                {s.specialConditions.contrast && <span>Контрастная тема</span>}
              </div>
            )}
                      </section>
          <section className="glass card stack brief-start" style={{ '--gap': '16px' } as React.CSSProperties} aria-live="polite">
            <div>
              {started ? (
                <span className="badge ok">
                  <Icon name="play" /> Экзамен в аудитории начат
                </span>
              ) : (
                <span className="badge">
                  <span className="dot live" aria-hidden="true" /> Ожидаем старта от организатора
                </span>
              )}
            </div>
            <p className="muted" style={{ fontSize: 14, lineHeight: '20px' }}>
              {started
                ? 'Нажмите «Начать экзамен». Отсчёт времени начнётся после загрузки вашего варианта.'
                : 'Кнопка станет активной, когда организатор начнёт экзамен в аудитории. Ничего нажимать не нужно.'}
            </p>
            {started ? (
              <button type="button" className="btn btn-xl btn-brand btn-block" onClick={() => void exam.begin()}>
                Начать экзамен <Icon name="arrowRight" />
              </button>
            ) : (
              <button type="button" className="btn btn-xl btn-block" disabled>
                Начать экзамен
              </button>
            )}
          </section>
        </aside>
      </div>
    </StepPage>
  );
}

function LoadingScreen({ exam }: { exam: ExamEngine }) {
  return (
    <main className="page-narrow screen-center" style={CENTER}>
      <div className="glass panel card-xl stack reveal" style={{ '--gap': '16px', alignItems: 'center', textAlign: 'center' } as React.CSSProperties} role="status" aria-live="polite">
        <div className="spinner" style={{ width: 28, height: 28 }} />
        <h1 className="h2">Подготовка варианта</h1>
        <p className="muted">{exam.loadingStep || 'Расшифровываем задания на этом компьютере…'}</p>
      </div>
    </main>
  );
}

/** ЭФ-06 «Окончание попытки» (FR-16, FR-17, FR-27, FR-28). Экран без анимаций (.calm). */
function FinalScreen({ exam }: { exam: ExamEngine }) {
  const s = exam.state;
  const st = s?.state ?? 'finished';
  const title =
    st === 'finished' ? 'Экзамен завершён' : st === 'timeExpired' ? 'Время экзамена истекло' : st === 'removed' ? 'Экзамен прекращён' : 'Экзамен завершён досрочно';
  const ok = st === 'finished' || st === 'timeExpired';
  return (
    <main className="page-narrow screen-center calm" style={CENTER}>
      <section className="glass panel card-xl stack" style={{ '--gap': '16px', textAlign: 'center' } as React.CSSProperties} role="status">
        <span className={`final-icon${ok ? ' ok' : ''}`} aria-hidden="true">
          <Icon name={ok ? 'checkCircle' : 'info'} size={28} />
        </span>
        <h1 className="h1">{title}</h1>
        <p className="muted">
          {s?.terminationMessage ??
            (st === 'timeExpired' ? 'Ответы, сохранённые до окончания времени, переданы на проверку.' : 'Ваши ответы сохранены и переданы на проверку. Изменить их больше нельзя.')}
        </p>
        <dl className="kv kv-center">
          <dt>Статус</dt>
          <dd>{ATTEMPT_STATE_LABEL[st]}</dd>
          {s?.finishedAt && (
            <>
              <dt>Время завершения</dt>
              <dd className="num">{fmtTime(s.finishedAt, undefined, true)}</dd>
            </>
          )}
          {s && (
            <>
              <dt>Отвечено заданий</dt>
              <dd>
                {Object.values(s.answers).filter((a) => a.value.trim()).length} из {s.exam.tasksCount}
              </dd>
            </>
          )}
        </dl>
        <p className="small muted">Дождитесь указаний организатора. Результаты появятся в разделе «Мои результаты» после официальной публикации.</p>
      </section>
    </main>
  );
}

/** Сбой рабочего места: без анимаций (.calm). */
function Fatal({ text }: { text?: string }) {
  return (
    <main className="page-narrow screen-center calm" style={CENTER}>
      <div className="seat-head">
        <Brand />
      </div>
      <section className="glass panel card-xl stack" style={{ '--gap': '16px', textAlign: 'center' } as React.CSSProperties} role="alert">
        <span className="final-icon" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }} aria-hidden="true">
          <Icon name="alert" size={28} />
        </span>
        <h1 className="h2">Работа на этом месте невозможна</h1>
        <p className="muted">{text}</p>
        <p className="small muted">Поднимите руку — организатор поможет перейти на другое рабочее место.</p>
      </section>
    </main>
  );
}
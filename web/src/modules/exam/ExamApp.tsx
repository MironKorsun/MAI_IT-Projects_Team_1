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
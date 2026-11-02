import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { AppealDto, MyResultDto } from '../../../../shared/types';
import { APPEAL_STATUS_LABEL } from '../../../../shared/types';
import { ApiError, resultsApi } from '../../lib/api';
import { Backdrop, Brand, ContrastToggle, Empty, ErrorBox, Modal, Skeleton, StatusBadge, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, fmtDateTime, plural } from '../../lib/format';
import './results.css';

/** Ширина контейнера М6 (ТЗ: работа со смартфона от 360 px, на десктопе — 960). */
const W = { '--w': '960px' } as CSSProperties;
const at = (i: number) => ({ '--i': i }) as CSSProperties;

type Me = { firstName: string; displayName?: string };
const meName = (me?: Me) => me?.displayName || me?.firstName || '';

/** Модуль М6 «Результаты» (ТЗ КЧ FR-46–FR-49): ЭФ-19, ЭФ-20. Работает со смартфона от 360 px. */
export default function ResultsApp() {
  const [authed, setAuthed] = useState<boolean>();
  const [name, setName] = useState('');
  useEffect(() => {
    document.title = 'Мои результаты · ВП ТС ЕГЭ';
    (async () => {
      const ok = await resultsApi.refresh();
      if (ok) {
        const me = await resultsApi.get<Me>('/me').catch(() => undefined);
        setName(meName(me));
      }
      setAuthed(ok);
    })();
    return resultsApi.onUnauthorized(() => setAuthed(false));
  }, []);

  const logout = async () => {
    await resultsApi.logout();
    setAuthed(false);
  };

    return (
    <div className="results-app">
      <Backdrop />
      <div className="page" style={{ ...W, paddingBottom: 0 }}>
        <header className="portal-head">
          <Brand href="/" />
          <div className="nav">
            <ContrastToggle />
          </div>
        </header>
      </div>
      {authed === undefined && (
        <main className="page" style={{ ...W, '--pt': '32px' } as CSSProperties}>
          <Skeleton h={240} r={24} />
        </main>
      )}
      {authed === false && <Login onDone={(n) => { setName(n); setAuthed(true); }} />}
      {authed && <Results name={name} onLogout={logout} />}
    </div>
  );
}

function Login({ onDone }: { onDone: (name: string) => void }) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      await resultsApi.login('/auth/results/login', { participantCode: code.trim(), pin });
      const me = await resultsApi.get<Me>('/me');
      onDone(meName(me));
    } catch (ex) {
      setErr(ex instanceof ApiError && ex.code === 'AUTH_LOCKED' ? 'Вход временно заблокирован. Попробуйте через 5 минут.' : ex instanceof ApiError ? 'Неверный код участника или PIN.' : 'Нет связи с сервером.');
    } finally {
      setBusy(false);
    }
  };
    return (
    <main className="page-narrow">
      <form className="glass panel card-lg stack reveal" style={{ '--gap': '16px' } as CSSProperties} onSubmit={submit}>
        <div className="stack" style={{ '--gap': '8px', marginBottom: 8 } as CSSProperties}>
          <span className="eyebrow">Результаты ЕГЭ</span>
          <h1 className="h1">Вход участника</h1>
          <p className="muted small">Код участника указан в уведомлении о регистрации на экзамен.</p>
        </div>
        <label className="field">
          <span className="label">Код участника</span>
          <input className="input input-lg" value={code} onChange={(e) => setCode(e.target.value)} placeholder="0000-000-000" autoComplete="username" spellCheck={false} />
        </label>
        <label className="field">
          <span className="label">PIN</span>
          <input className="input input-lg" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" />
        </label>
        {err && (
          <div className="error-text" role="alert">
            {err}
          </div>
        )}
        <button className="btn btn-lg btn-primary btn-block" disabled={busy || !code || !pin} style={{ marginTop: 8 }}>
          {busy ? <span className="spinner" /> : null}
          Войти
        </button>
      </form>
    </main>
  );
}

function Results({ name, onLogout }: { name: string; onLogout: () => void }) {
  const [results, setResults] = useState<MyResultDto[]>();
  const [appeals, setAppeals] = useState<AppealDto[]>([]);
  const [err, setErr] = useState<unknown>();
  const [appealFor, setAppealFor] = useState<MyResultDto>();
  const load = async () => {
    setErr(undefined);
    try {
      const [r, a] = await Promise.all([resultsApi.get<MyResultDto[]>('/me/results'), resultsApi.get<AppealDto[]>('/me/appeals')]);
      setResults(r);
      setAppeals(a);
    } catch (e) {
      setErr(e);
    }
  };
  useEffect(() => {
    void load();
  }, []);

    return (
    <main className="page" style={W}>
      <div className="title-row reveal" style={at(0)}>
        <div className="titles">
          <span className="eyebrow">Результаты ЕГЭ</span>
          <h1 className="display">Мои результаты</h1>
          <p className="sub">
            Баллы публикуются после официального объявления. Апелляцию о несогласии с выставленными баллами можно подать в течение двух рабочих дней после публикации.
          </p>
        </div>
        <div className="pills">
          {name && (
            <span className="pill">
              <Icon name="user" />
              <span className="sr-only">Участник: </span>
              {name}
            </span>
          )}
          <button type="button" className="btn" onClick={onLogout}>
            <Icon name="logout" /> Выйти
          </button>
        </div>
      </div>

            {err ? (
        <ErrorBox error={err} onRetry={load} />
      ) : !results ? (
        <Skeleton h={360} r={24} />
      ) : !results.length ? (
        <div className="glass card-lg reveal" style={at(1)}>
          <Empty icon="clock">Опубликованных результатов пока нет. Они появятся после официального объявления.</Empty>
        </div>
      ) : (
        <div className="stack" style={{ '--gap': '12px' } as CSSProperties}>
          {results.map((r, i) => {
            const own = appeals.filter((a) => a.sessionId === r.sessionId);
            return (
              <div key={r.sessionId} className="stack" style={{ '--gap': '12px' } as CSSProperties}>
                <ResultCard r={r} appeals={own} i={1 + i * 2} />
                <AppealCard r={r} appeals={own} i={2 + i * 2} onAppeal={() => setAppealFor(r)} />
              </div>
            );
          })}
        </div>
      )}
      {appealFor && <AppealForm r={appealFor} onClose={() => setAppealFor(undefined)} onDone={load} />}
    </main>
  );
}

const isActive = (a: AppealDto) => a.status === 'registered' || a.status === 'reviewing';

function ResultCard({ r, appeals, i }: { r: MyResultDto; appeals: AppealDto[]; i: number }) {
  const solved = r.tasks.filter((t) => t.score > 0).length;
  const main = r.testScore ?? r.grade ?? 0;
  return (
    <article className="glass card-lg reveal" style={at(i)} aria-labelledby={`r-${r.sessionId}`}>
      <div className="card-head wrap">
        <div className="stack" style={{ '--gap': '4px' } as CSSProperties}>
          <h2 id={`r-${r.sessionId}`} className="h2">
            {r.examTitle}
          </h2>
          <span className="meta">Экзамен {fmtDate(r.date)}</span>
        </div>
        {appeals.some(isActive) ? <StatusBadge tone="accent">Апелляция на рассмотрении</StatusBadge> : <StatusBadge>Результат опубликован</StatusBadge>}
      </div>

            <div className="score-hero">
        <div className="tile-accent inner card score-tile">
          <span className="score-label">{r.testScore !== undefined ? 'Тестовый балл' : 'Отметка'}</span>
          <span className="score-value">{main}</span>
          <span className="score-primary">
            Первичный балл: {r.primaryScore} из {r.maxPrimary}
          </span>
          {r.passed ? (
            <StatusBadge tone="ok" icon="checkCircle">
              Порог {r.threshold} пройден
            </StatusBadge>
          ) : (
            <StatusBadge tone="warn" icon="alert">
              Ниже порога {r.threshold}
            </StatusBadge>
          )}
        </div>
        <dl className="kv">
          <dt>Решено верно</dt>
          <dd>
            {solved} из {r.tasks.length} {plural(r.tasks.length, 'задания', 'заданий', 'заданий')}
          </dd>
          <dt>Минимальный порог</dt>
          <dd>{r.threshold}</dd>
          <dt>Дата публикации</dt>
          <dd>{fmtDateTime(r.publishedAt)}</dd>
        </dl>
      </div>
            <h3 className="h3" style={{ margin: '32px 0 12px' }}>
        Ответы по заданиям
      </h3>
      <ul className="task-results" role="list">
        {r.tasks.map((t) => {
          const ok = t.score > 0;
          return (
            <li key={t.number} className={`task-result ${ok ? 'ok' : 'no'}`} title={`Ваш ответ: ${t.answer || 'нет ответа'}`}>
              <span className="n" aria-hidden="true">
                № {t.number}
              </span>
              <span className="a" aria-hidden="true">
                <Icon name={ok ? 'check' : 'x'} size={16} />
                <span className="ans">{t.answer ? t.answer.replace(/^-/, '−') : '—'}</span>
                <span className="s">{t.score}</span>
              </span>
              <span className="sr-only">
                Задание {t.number}: {ok ? 'верно' : 'неверно'}, ответ {t.answer || 'не дан'}, {t.score} {plural(t.score, 'балл', 'балла', 'баллов')}
              </span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function AppealCard({ r, appeals, i, onAppeal }: { r: MyResultDto; appeals: AppealDto[]; i: number; onAppeal: () => void }) {
  const now = new Date().toISOString();
  const windowOpen = now >= r.appealWindow.from && now <= r.appealWindow.to;
  const active = appeals.some(isActive);
  return (
    <section className="glass card reveal" style={at(i)} aria-labelledby={`ap-${r.sessionId}`}>
      <div className="card-head wrap">
        <div className="stack" style={{ '--gap': '4px' } as CSSProperties}>
          <h3 id={`ap-${r.sessionId}`} className="h3">
            Апелляция о несогласии с баллами
          </h3>
          <span className="meta">{windowOpen ? `Подать можно до ${fmtDateTime(r.appealWindow.to)}` : `Срок подачи истёк ${fmtDateTime(r.appealWindow.to)}`}</span>
        </div>
        <button type="button" className="btn btn-lg" disabled={!windowOpen || active} onClick={onAppeal} title={!windowOpen ? 'Окно подачи апелляции закрыто' : active ? 'Апелляция уже на рассмотрении' : undefined}>
          Подать апелляцию
        </button>
      </div>
import { useEffect, useRef, useState } from 'react';
import type { TaskView } from '../../../../shared/types';
import { filterShortInput, FORMAT_HINT } from '../../../../shared/format';
import { Icon } from '../../components/Icon';
import { Brand, Modal } from '../../components/ui';
import { Formula, SafeHtml } from '../../lib/richtext';
import { fmtDuration, fmtTime, plural } from '../../lib/format';
import type { ExamEngine } from './useExam';
import './exam.css';

/** Подсказка формата под полем ответа (D.2): в КИМ ответ — целое число или конечная десятичная дробь. */
const DECIMAL_HINT = 'Целое число или конечная десятичная дробь, например −3 или 0,25';

/**
 * ЭФ-04 «Задание» и ЭФ-05 «Сводка перед завершением» (ТЗ КЧ FR-05–FR-16, FR-18–FR-21).
 * Экран без анимаций (.calm) и без модальных окон, прерывающих ввод (ТЗ КЧ 4.2, 6.6).
 */
export function TaskScreen({ exam }: { exam: ExamEngine }) {
  const v = exam.variant!;
  const tasks = v.tasks;
  const idx = Math.max(0, tasks.findIndex((t) => t.id === exam.currentId));
  const task = tasks[idx];
  const [summary, setSummary] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const [msgsOpen, setMsgsOpen] = useState(false);
  const answered = tasks.filter((t) => (exam.answers[t.id] ?? '').trim()).length;
  // Прочитанные сообщения организатора: точка на кнопке — только для новых (хранится до конца попытки)
  const seenKey = `exam-msgs-seen:${exam.state?.attemptId ?? ''}`;
  const [seen, setSeen] = useState(() => {
    try {
      return Number(sessionStorage.getItem(seenKey)) || 0;
    } catch {
      return 0;
    }
  });
  const openMsgs = () => {
    setMsgsOpen(true);
    setSeen(exam.messages.length);
    try {
      sessionStorage.setItem(seenKey, String(exam.messages.length));
    } catch {
      /* без sessionStorage — счётчик живёт до перезагрузки */
    }
  };

    const go = (i: number) => {
    const t = tasks[Math.max(0, Math.min(tasks.length - 1, i))];
    if (t && t.id !== exam.currentId) exam.select(t.id);
  };

  // Alt+← / Alt+→ — переход между заданиями с клавиатуры (NFR-25)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // не листать задания за открытым окном и под сводкой
      if (!e.altKey || refsOpen || msgsOpen || summary) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(idx + 1);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(idx - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
    return (
    <div className="exam calm">
      <ExamTopBar exam={exam} onRefs={() => setRefsOpen(true)} onMsgs={openMsgs} unread={Math.max(0, exam.messages.length - seen)} hasRefs={v.references.length > 0} />
      <div className="exam-body">
        <nav className="glass exam-nav" aria-label="Задания">
          <div className="exam-nav-head">
            <b>Задания</b>
            <span>
              {answered} из {tasks.length}
            </span>
          </div>
          <div className="progress" aria-hidden="true">
            <i style={{ width: `${(answered / tasks.length) * 100}%` }} />
          </div>
                    <ul className="task-grid" role="list">
            {tasks.map((t) => {
              const has = !!(exam.answers[t.id] ?? '').trim();
              const flagged = exam.flags.includes(t.id);
              // под сводкой ни одно задание не «текущее»
              const current = !summary && t.id === task.id;
              // ответ записан локально, но ещё не подтверждён сервером (нет связи или ждёт отправки)
              const unsynced = has && (!exam.online || exam.dirtyIds.includes(t.id));
              const status = `${has ? (unsynced ? 'ответ записан, ещё не отправлен' : 'ответ сохранён') : 'нет ответа'}${flagged ? ', отмечено для возврата' : ''}`;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`task-cell${has ? ' has' : ''}${current ? ' current' : ''}`}
                    aria-current={current ? 'step' : undefined}
                    aria-label={`Задание ${t.number}: ${status}`}
                    title={`Задание ${t.number}: ${status}`}
                    onClick={() => exam.select(t.id)}
                  >
                    {t.number}
                    {has && !unsynced && <Icon name="check" size={12} className="tick" />}
                    {flagged && (
                      <span className="task-flag" aria-hidden="true">
                        <Icon name="flag" size={10} />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
                      </ul>
          <div className="legend">
            <span>
              <span className="task-cell mini" aria-hidden="true" /> нет ответа
            </span>
            <span>
              <span className="task-cell mini has" aria-hidden="true" /> ответ сохранён
            </span>
            <span>
              <Icon name="flag" /> отмечено для возврата
            </span>
          </div>
          <div className="exam-finish">
            <button type="button" className="btn btn-lg btn-block" onClick={() => setSummary(true)}>
              Завершить экзамен
            </button>
          </div>
        </nav>
        
                <main className="exam-main" id="main">
          <ExamNotices exam={exam} />
          {summary ? (
            <Summary
              exam={exam}
              onBack={() => setSummary(false)}
              onOpen={(id) => {
                setSummary(false);
                exam.select(id);
              }}
            />
          ) : (
            <TaskCard
              key={task.id}
              task={task}
              exam={exam}
              index={idx}
              total={tasks.length}
              onPrev={() => go(idx - 1)}
              onNext={() => go(idx + 1)}
              onFinish={() => setSummary(true)}
            />
          )}
        </main>
      </div>

            {refsOpen && (
        <Modal title="Справочные материалы" onClose={() => setRefsOpen(false)} wide>
          <div className="stack" style={{ '--gap': '12px' } as React.CSSProperties} data-kim>
            {v.references.map((r) => (
              <section key={r.id} className="tile card">
                <div className="h3" style={{ marginBottom: 8 }}>
                  {r.title}
                </div>
                {r.latex && <Formula src={r.latex} display />}
                {r.rows && (
                  <table className="table">
                    <thead>
                      <tr>{r.rows[0].map((c, i) => <th key={i}>{c}</th>)}</tr>
                    </thead>
                    <tbody>
                      {r.rows.slice(1).map((row, i) => (
                        <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            ))}
          </div>
        </Modal>

              )}
      {msgsOpen && (
        <Modal title="Сообщения организатора" onClose={() => setMsgsOpen(false)}>
          {exam.messages.length ? (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0, '--gap': '8px' } as React.CSSProperties}>
              {exam.messages.map((m) => (
                <li key={m.id} className="tile card-tight stack" style={{ '--gap': '4px' } as React.CSSProperties}>
                  <span className="tiny muted num">{fmtTime(m.at)}</span>
                  <span>{m.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Сообщений нет.</p>
          )}
        </Modal>
      )}
    </div>
  );
}

function ExamTopBar({ exam, onRefs, onMsgs, unread, hasRefs }: { exam: ExamEngine; onRefs: () => void; onMsgs: () => void; unread: number; hasRefs: boolean }) {
  const ms = exam.remainingMs ?? 0;
  const low = ms < 5 * 60_000;
  const warn = ms < 30 * 60_000;
  // Объявления таймера для скринридера — только на рубежах, без прерывания ввода (NFR-28)
  const [announce, setAnnounce] = useState('');
  const marks = useRef(new Set<number>());
  useEffect(() => {
    const min = Math.ceil(ms / 60_000);
    for (const m of [60, 30, 15, 5, 1]) {
      if (min === m && !marks.current.has(m)) {
        marks.current.add(m);
        setAnnounce(`До окончания экзамена ${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
      }
    }
  }, [ms]);

    return (
    <header className="glass-float exam-top">
      {/* знак отдельно от .who: правило `.who span` не должно задевать плитку знака */}
      <div className="row" style={{ minWidth: 0 }}>
        <Brand compact />
        <div className="who">
          <div>
            <b>{exam.state?.exam.title}</b>
            <span>
              {exam.state?.participant.displayName} · ауд. {exam.state?.room.number} · вариант {exam.variant?.number}
            </span>
          </div>
        </div>
      </div>
      <div className="actions">
        {/* .exam-status — без стилей, крючок для сценариев e2e (текст состояния сохранения) */}
        <div className="row exam-status" role="status" aria-live="polite">
          <SaveState exam={exam} />
        </div>
        {hasRefs && (
          <button type="button" className="btn refs-btn" onClick={onRefs} aria-label="Справка" title="Справочные материалы">
            <Icon name="book" /> <span className="refs-label">Справка</span>
          </button>
        )}
        <button type="button" className="btn btn-icon" onClick={onMsgs} aria-label={unread ? `Сообщения организатора, новых: ${unread}` : 'Сообщения организатора'} title="Сообщения организатора">
          <Icon name="message" />
          {unread > 0 && <span className="msg-dot" aria-hidden="true" />}
        </button>
        <div className={`timer${low ? ' low' : warn ? ' warn' : ''}`} role="timer" aria-label="Оставшееся время">
          <Icon name="clock" />
          <span>{fmtDuration(ms)}</span>
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </header>
  );
}

/** Состояние сохранения в верхней панели (D.2): сохраняется · сохранено в ЧЧ:ММ:СС · изменений нет · нет связи. */
function SaveState({ exam }: { exam: ExamEngine }) {
  if (!exam.online)
    return (
      <span className="badge warn save-state">
        <Icon name="wifiOff" /> Нет связи · ответы сохраняются на компьютере
      </span>
    );
  if (exam.pendingCount)
    return (
      <span className="badge save-state">
        <Icon name="cloud" /> Сохраняется…
      </span>
    );
  if (exam.savedAt)
    return (
      <span className="badge ok save-state">
        <Icon name="check" /> Сохранено в {fmtTime(exam.savedAt, undefined, true)}
      </span>
    );
  return (
    <span className="badge save-state">
      <Icon name="cloud" /> Изменений нет
    </span>
  );
}

function ExamNotices({ exam }: { exam: ExamEngine }) {
  const ms = exam.remainingMs ?? Infinity;
  const [dismissed, setDismissed] = useState<number[]>([]);
  const timeWarn = ms <= 5 * 60_000 ? 5 : ms <= 30 * 60_000 ? 30 : 0;
  return (
    <div className="exam-notices">
      {timeWarn > 0 && !dismissed.includes(timeWarn) && (
        <div className="notice warn" role="status">
          <span className="notice-body">
            <Icon name="clock" className="lead-icon" size={20} />
            <span>До окончания экзамена осталось меньше {timeWarn} минут. Проверьте задания без ответа.</span>
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => setDismissed((d) => [...d, timeWarn])}>
            Понятно
          </button>
        </div>
      )}
      {exam.notice && (
        <div className={`notice ${exam.notice.tone}`} role="status">
          <span className="notice-body">
            <Icon name={exam.notice.tone === 'warn' ? 'info' : 'message'} className="lead-icon" size={20} />
            <span>{exam.notice.text}</span>
          </span>
          <button type="button" className="btn btn-ghost" onClick={exam.dismissNotice}>
            Скрыть
          </button>
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  exam,
  index,
  total,
  onPrev,
  onNext,
  onFinish,
}: {
  task: TaskView;
  exam: ExamEngine;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onFinish: () => void;
}) {
  const flagged = exam.flags.includes(task.id);
  const last = index === total - 1;
  const [notesOpen, setNotesOpen] = useState(!!exam.notes[task.id]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => revealHeading(headingRef.current), [task.id]);
  return (
    <article className="glass glass-thick task-card" aria-labelledby="task-h">
      <div className="task-head">
        <div className="task-title">
          <h1 id="task-h" ref={headingRef} tabIndex={-1} className="h-exam">
            Задание {task.number}
          </h1>
          <span className="badge outline">
            {task.maxScore} {plural(task.maxScore, 'балл', 'балла', 'баллов')}
          </span>
        </div>
        <button type="button" className="btn btn-toggle" aria-pressed={flagged} onClick={() => exam.toggleFlag(task.id)}>
          <Icon name="flag" /> {flagged ? 'Отмечено для возврата' : 'Отметить для возврата'}
        </button>
      </div>
            <div className="kim-text no-select" data-kim>
        <SafeHtml html={task.condition} />
      </div>

      <div className="answer-zone">
        <ShortAnswer task={task} exam={exam} />
      </div>

      <div className="notes">
        <button type="button" className="btn btn-ghost" aria-expanded={notesOpen} aria-controls={`note-${task.id}`} onClick={() => setNotesOpen(!notesOpen)}>
          <Icon name="note" /> Черновик <span className="muted">· не проверяется</span>
          <Icon name="chevronDown" size={16} style={{ transform: notesOpen ? 'rotate(180deg)' : undefined }} />
        </button>
        {notesOpen && (
          <textarea
            id={`note-${task.id}`}
            className="textarea"
            rows={4}
            aria-label={`Черновик к заданию ${task.number}. Не проверяется`}
            placeholder="Записи для себя. Не проверяются."
            value={exam.notes[task.id] ?? ''}
            onChange={(e) => exam.setNote(task.id, e.target.value)}
          />
        )}
      </div>
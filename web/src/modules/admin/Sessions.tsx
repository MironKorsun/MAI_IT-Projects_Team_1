import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ExamSessionDto } from '../../../../shared/types';
import { RESULTS_STATUS_LABEL } from '../../../../shared/types';
import { ApiError, staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Empty, ErrorBox, Modal, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, fmtMinutes } from '../../lib/format';

/** ЭФ-13 «Экзаменационные сессии» (ТЗ КЧ FR-38). */
export const SESSION_STATUS: Record<ExamSessionDto['status'], string> = { preparation: 'Подготовка', active: 'Идёт экзамен', completed: 'Проведена' };

export function resultsTone(s: ExamSessionDto['resultsStatus']) {
  return s === 'published' ? 'ok' : s === 'approved' ? 'accent' : undefined;
}

/** Статус сессии; во время экзамена — мятная «дышащая» точка, как в списке аудиторий. */
export function SessionBadge({ status }: { status: ExamSessionDto['status'] }) {
  return (
    <StatusBadge tone={status === 'active' ? 'ok' : undefined} live={status === 'active'}>
      {SESSION_STATUS[status]}
    </StatusBadge>
  );
}

export default function Sessions() {
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => staffApi.get<ExamSessionDto[]>('/exam-sessions'));
  const [create, setCreate] = useState(false);
  return (
    <>
      <PageHead
        eyebrow="Администрирование кампании"
        title="Экзаменационные сессии"
        subtitle="Подготовка сессий, распределение участников и публикация результатов."
        actions={
          <button type="button" className="btn btn-lg btn-primary" onClick={() => setCreate(true)}>
            <Icon name="plus" /> Создать сессию
          </button>
        }
      />
      {error ? <ErrorBox error={error} onRetry={reload} /> : null}
      <section className="glass table-panel reveal" style={{ '--i': 1, marginTop: error ? 12 : undefined } as React.CSSProperties} aria-label="Экзаменационные сессии">
        {!data && !error && <Skeleton h={240} />}
        {data && !data.length && <Empty>Сессий пока нет.</Empty>}
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Экзамен</th>
                  <th className="r">Аудиторий</th>
                  <th className="r">Участников</th>
                  <th>Статус</th>
                  <th className="r">
                    <span className="sr-only">Открыть</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.map((s) => {
                  const url = `/staff/admin/sessions/${s.id}`;
                  return (
                    // Вся строка ведёт на карточку сессии; ссылка в ячейке даты — для клавиатуры и чтения с экрана
                    <tr key={s.id} className="row-link" onClick={(e) => !(e.target as HTMLElement).closest('a, button') && nav(url)}>
                      <td data-label="Дата">
                        <Link to={url} className="strong num" style={{ color: 'inherit' }}>
                          {fmtDate(s.date)}
                        </Link>
                        <div className="tiny muted num">начало {s.startLocal}</div>
                      </td>
                      <td data-label="Экзамен">
                        <div>{s.title}</div>
                        <div className="tiny muted">
                          {fmtMinutes(s.durationMin)} · вариантов: {s.variants}
                          {s.proctoring ? ' · прокторинг' : ''}
                        </div>
                      </td>
                      <td className="r" data-label="Аудиторий">
                        {s.rooms.length}
                      </td>
                      <td className="r" data-label="Участников">
                        {s.attempts}
                      </td>
                      <td data-label="Статус">
                        <div className="row wrap" style={{ '--gap': '6px' } as React.CSSProperties}>
                          <SessionBadge status={s.status} />
                          <StatusBadge tone={resultsTone(s.resultsStatus)} icon="award">
                            {RESULTS_STATUS_LABEL[s.resultsStatus]}
                          </StatusBadge>
                        </div>
                      </td>
                      <td className="r hide-sm">
                        <Link to={url} className="btn-round" tabIndex={-1} aria-hidden="true">
                          <Icon name="chevronRight" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {create && <CreateSession onClose={() => setCreate(false)} onCreated={reload} />}
    </>
  );
}

interface ExamDir {
  code: string;
  title: string;
  durationMin: number;
  variants: { id: string; number: number; title: string }[];
}
interface Ppe {
  id: string;
  code: string;
  name: string;
  region: string;
  tz: string;
}
interface Staff {
  id: string;
  fullName: string;
  roles: string[];
}

function CreateSession({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const exams = useLoad(() => staffApi.get<ExamDir[]>('/exams'));
  const ppes = useLoad(() => staffApi.get<Ppe[]>('/ppes'));
  const staff = useLoad(() => staffApi.get<Staff[]>('/staff'));
  const [f, setF] = useState({ examCode: 'math-profile', date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), startLocal: '10:00', proctoring: true, variantIds: [] as string[], ppeId: '', number: '301', seats: 15, organizerId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>();
  const exam = exams.data?.find((e) => e.code === f.examCode);
  const submit = async () => {
    setErrors({});
    setErr(undefined);
    try {
      await staffApi.post('/exam-sessions', {
        examCode: f.examCode,
        date: f.date,
        startLocal: f.startLocal,
        proctoring: f.proctoring,
        variantIds: f.variantIds,
        rooms: f.ppeId ? [{ ppeId: f.ppeId, number: f.number, seats: f.seats, organizerIds: f.organizerId ? [f.organizerId] : [] }] : [],
      });
      toast('Сессия создана в статусе «Подготовка»', 'ok');
      onCreated();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fieldErrors());
      setErr(e);
    }
  };
  return (
    <Modal
      title="Новая экзаменационная сессия"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-primary" onClick={submit}>
            Создать сессию
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field full">
          <span className="label">Экзамен</span>
          <select className="select" value={f.examCode} onChange={(e) => setF({ ...f, examCode: e.target.value, variantIds: [] })}>
            {exams.data?.map((e) => (
              <option key={e.code} value={e.code}>
                {e.title} · {fmtMinutes(e.durationMin)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Дата</span>
          <input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Начало (местное)</span>
          <input className="input" type="time" value={f.startLocal} onChange={(e) => setF({ ...f, startLocal: e.target.value })} />
        </label>
        <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="label" style={{ padding: 0, marginBottom: 4 }}>
            Варианты КИМ
          </legend>
          {exam?.variants.length ? (
            <div className="row wrap" style={{ '--gap': '0 24px' } as React.CSSProperties}>
              {exam.variants.map((v) => (
                <label key={v.id} className="check">
                  <input type="checkbox" checked={f.variantIds.includes(v.id)} onChange={(e) => setF({ ...f, variantIds: e.target.checked ? [...f.variantIds, v.id] : f.variantIds.filter((x) => x !== v.id) })} />
                  {v.title}
                </label>
              ))}
            </div>
          ) : (
            <span className="hint">Для экзамена нет импортированных вариантов.</span>
          )}
          {errors.variantIds && <span className="error-text">{errors.variantIds}</span>}
        </fieldset>
        <label className="field">
          <span className="label">ППЭ</span>
          <select className="select" value={f.ppeId} onChange={(e) => setF({ ...f, ppeId: e.target.value })} aria-invalid={!!errors.rooms}>
            <option value="">Выберите ППЭ</option>
            {ppes.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.region}
              </option>
            ))}
          </select>
          {errors.rooms && <span className="error-text">{errors.rooms}</span>}
        </label>
        <label className="field">
          <span className="label">Организатор</span>
          <select className="select" value={f.organizerId} onChange={(e) => setF({ ...f, organizerId: e.target.value })}>
            <option value="">Без организатора</option>
            {staff.data
              ?.filter((u) => u.roles.includes('organizer'))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Аудитория</span>
          <input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        </label>
        <label className="field">
          <span className="label">Мест (≤ 25)</span>
          <input className="input" type="number" min={1} max={25} value={f.seats} onChange={(e) => setF({ ...f, seats: Number(e.target.value) })} />
        </label>
        <label className="check full">
          <input type="checkbox" checked={f.proctoring} onChange={(e) => setF({ ...f, proctoring: e.target.checked })} /> Контроль целостности (прокторинг)
        </label>
      </div>
      {err ? <ErrorBox error={err} /> : null}
    </Modal>
  );
}

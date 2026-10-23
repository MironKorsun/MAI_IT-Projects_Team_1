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
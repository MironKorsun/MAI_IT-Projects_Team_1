import { useMemo, useState } from 'react';
import type { AuditEventDto } from '../../../../shared/types';
import { INTEGRITY_LABEL } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Empty, ErrorBox, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDateTime, plural } from '../../lib/format';

/** ЭФ-18 «Журнал событий» (ТЗ КЧ FR-44): фильтры, курсорная выборка, выгрузка CSV, проверка цепочки хэшей. */
interface Page {
  items: AuditEventDto[];
  nextCursor?: string;
  total: number;
  categories: string[];
}

const TYPE_LABEL: Record<string, string> = {
  'auth.login': 'Вход',
  'auth.failed': 'Неудачный вход',
  'auth.lockout': 'Блокировка ввода',
  'auth.logout': 'Выход',
  'auth.idleTimeout': 'Завершение сеанса по бездействию',
  'room.accessCodeIssued': 'Выпуск кода аудитории',
  'room.accessCodeReissued': 'Перевыпуск кода, прежний аннулирован',
  'room.started': 'Старт экзамена',
  'room.message': 'Сообщение участникам',
  'attempt.ready': 'Готовность, начало отсчёта',
  'attempt.finished': 'Завершение участником',
  'attempt.timeExpired': 'Истечение времени',
  'attempt.timeCompensated': 'Компенсация времени',
  'attempt.relocated': 'Перевод на другое место',
  'attempt.incident': 'Акт о нарушении',
  'attempt.earlyFinish': 'Завершение по объективной причине',
  'answer.lateAccepted': 'Приём изменения в окне после окончания',
  'kim.keyIssued': 'Выдача ключа варианта',
  'kim.keyDenied': 'Отказ в выдаче ключа',
  'kim.imported': 'Импорт КИМ',
  'kim.keyCorrected': 'Исправление эталона',
  'admin.sessionCreated': 'Создание сессии',
  'admin.allocationApplied': 'Применение распределения',
  'admin.rolesChanged': 'Изменение ролей',
  'admin.staffCreated': 'Создание учётной записи',
  'admin.staffBlocked': 'Блокировка учётной записи',
  'admin.specialConditions': 'Назначение особых условий',
  'admin.resultsPublished': 'Публикация результатов',
  'results.status': 'Статус результатов',
  'result.recalculated': 'Перерасчёт',
  'scale.loaded': 'Загрузка шкалы',
  'appeal.registered': 'Регистрация апелляции',
  'appeal.status': 'Статус апелляции',
  'workstation.checked': 'Проверка рабочего места',
  'access.denied': 'Обращение к чужому ресурсу',
  'data.exported': 'Выгрузка данных',
  'analytics.calculated': 'Аналитический расчёт',
};

export function eventLabel(type: string) {
  if (type.startsWith('integrity.')) return INTEGRITY_LABEL[type.slice(10)] ?? type;
  return TYPE_LABEL[type] ?? type;
}

export default function AuditLog() {
  const toast = useToast();
  const [f, setF] = useState({ category: '', ppe: '', from: '', to: '' });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (f.category) p.set('category', f.category);
    if (f.ppe) p.set('ppe', f.ppe);
    if (f.from) p.set('from', new Date(f.from).toISOString());
    if (f.to) p.set('to', new Date(f.to).toISOString());
    return p.toString();
  }, [f]);
  const { data, error, reload, setData } = useLoad(() => staffApi.get<Page>(`/audit-events?limit=50&${query}`), [query]);
  const [more, setMore] = useState(false);

  const loadMore = async () => {
    if (!data?.nextCursor) return;
    setMore(true);
    try {
      const next = await staffApi.get<Page>(`/audit-events?limit=50&cursor=${data.nextCursor}&${query}`);
      setData({ ...next, items: [...data.items, ...next.items] });
    } finally {
      setMore(false);
    }
  };
  const verify = async () => {
    const r = await staffApi.get<{ ok: boolean; records: number; brokenAt?: number }>('/audit-events/verify');
    toast(r.ok ? `Цепочка хэшей целостна: ${r.records} ${plural(r.records, 'запись', 'записи', 'записей')}` : `Нарушение цепочки в записи № ${r.brokenAt}`, r.ok ? 'ok' : 'bad');
  };

  return (
    <>
      <PageHead
        eyebrow="Мониторинг"
        title="Журнал событий"
        subtitle="Только чтение. Каждая запись связана хэшем SHA-256 с предыдущей."
        actions={
          <>
            <button type="button" className="btn" onClick={verify}>
              <Icon name="hash" /> Проверить целостность
            </button>
            <button type="button" className="btn btn-primary" onClick={() => staffApi.download(`/audit-events/export?${query}`, 'audit-events.csv')}>
              <Icon name="download" /> Выгрузить CSV
            </button>
          </>
        }
      />
      <div className="reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="filter-bar" role="search">
          <select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Тип события">
            <option value="">Все типы событий</option>
            {data?.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input className="input" style={{ width: 160 }} placeholder="Код ППЭ" value={f.ppe} onChange={(e) => setF({ ...f, ppe: e.target.value })} aria-label="Код ППЭ" />
          <label className="row small muted" style={{ '--gap': '8px' } as React.CSSProperties}>
            с <input className="input" style={{ width: 232 }} type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="Начало периода" />
          </label>
          <label className="row small muted" style={{ '--gap': '8px' } as React.CSSProperties}>
            по <input className="input" style={{ width: 232 }} type="datetime-local" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Конец периода" />
          </label>
          <span className="small muted num push">{data ? `${data.total} ${plural(data.total, 'запись', 'записи', 'записей')}` : ''}</span>
        </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        <section className="glass table-panel" aria-label="Записи журнала" style={error ? { marginTop: 12 } : undefined}>
          {!data && <Skeleton h={400} />}
          {data && (
            <div className="table-wrap scroll">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Тип</th>
                    <th>Событие</th>
                    <th>Субъект</th>
                    <th>Объект</th>
                    <th>ППЭ / ауд.</th>
                    <th>Результат</th>
                    <th>Хэш</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id}>
                      <td className="small num" style={{ whiteSpace: 'nowrap' }}>
                        {fmtDateTime(e.at)}
                      </td>
                      <td className="small muted nowrap">{e.category}</td>
                      <td className="small" style={{ maxWidth: 260 }}>
                        {eventLabel(e.type)}
                        {e.details && <div className="tiny muted">{e.details}</div>}
                      </td>
                      <td className="tiny muted">
                        {/* субъект — в две задуманные строки: роль и идентификатор */}
                        <div className="nowrap">{e.actorRole}</div>
                        {e.actorId && <div className="mono nowrap">{e.actorId}</div>}
                      </td>
                      <td className="tiny mono" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.object}
                      </td>
                      <td className="small num nowrap">{e.ppeCode ? `${e.ppeCode} / ${e.roomNumber ?? '—'}` : '—'}</td>
                      <td className="nowrap">
                        {e.result === 'ok' ? (
                          // успех — обычное состояние, тихий текст; бейдж — только у отказа
                          <span className="small ink2 row" style={{ '--gap': '6px' } as React.CSSProperties}>
                            <Icon name="check" size={16} style={{ color: 'var(--ok)' }} />
                            успех
                          </span>
                        ) : (
                          <StatusBadge tone="bad" icon="x">
                            отказ
                          </StatusBadge>
                        )}
                      </td>
                      <td className="tiny mono muted" title={e.hash}>
                        {e.hash.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                  {!data.items.length && (
                    <tr>
                      <td colSpan={8}>
                        <Empty icon="list">Записей, подходящих под фильтры, нет.</Empty>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          {data && data.items.length > 0 && (
            <div className="panel-foot row between wrap">
              <span className="num">
                Показано {data.items.length} из {data.total}
              </span>
              {data.nextCursor && (
                <button type="button" className="btn" onClick={loadMore} disabled={more}>
                  {more ? <span className="spinner" /> : null}
                  Показать ещё
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
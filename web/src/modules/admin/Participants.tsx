import { useEffect, useState } from 'react';
import type { SpecialConditions } from '../../../../shared/types';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Confirm, Empty, ErrorBox, Skeleton, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { plural } from '../../lib/format';

/** ЭФ-14 «Особые условия» (ТЗ КЧ FR-42). */
interface Row {
  id: string;
  code: string;
  displayName: string;
  regionCode: string;
  specialConditions: SpecialConditions;
}

const hasConditions = (s: SpecialConditions) => s.extraTime || s.scale !== 100 || s.contrast;

export default function Participants() {
  const toast = useToast();
  const [q, setQ] = useState('');
  // запрос к серверу — после паузы во вводе
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const [cond, setCond] = useState<'' | 'any' | 'none'>('');
  // поиск и фильтр по особым условиям — на сервере (до среза первых 100); устаревший ответ отбрасывает useLoad
  const { data, error, reload } = useLoad(() => staffApi.get<{ total: number; items: Row[] }>(`/participants?q=${encodeURIComponent(query)}${cond ? `&cond=${cond}` : ''}`), [query, cond]);
  const [edit, setEdit] = useState<Row>();
  const [sc, setSc] = useState<SpecialConditions>({ extraTime: false, scale: 100, contrast: false });
  const rows = data?.items;
  const total = data?.total ?? 0;

  return (
    <>
      <PageHead eyebrow="Администрирование" title="Участники и особые условия" subtitle="Увеличение продолжительности на 1,5 ч, масштаб интерфейса и контрастная тема для участников с ОВЗ." />
      <div className="reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="filter-bar" role="search">
          <div className="search">
            <Icon name="search" />
            <input className="input" type="text" placeholder="Код участника или фамилия" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск участника" />
          </div>
          <select className="select" value={cond} onChange={(e) => setCond(e.target.value as typeof cond)} aria-label="Особые условия">
            <option value="">Все участники</option>
            <option value="any">С особыми условиями</option>
            <option value="none">Без особых условий</option>
          </select>
          {(q || cond) && (
            <button type="button" className="btn btn-lg btn-ghost" onClick={() => { setQ(''); setCond(''); }}>
              <Icon name="x" /> Сбросить
            </button>
          )}
          {rows && (
            <span className="small muted num push">
              {total} {plural(total, 'участник', 'участника', 'участников')}
              {total > rows.length ? ` · показаны первые ${rows.length}` : ''}
            </span>
          )}
        </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        <section className="glass table-panel" aria-label="Участники" style={error ? { marginTop: 12 } : undefined}>
          {!rows && !error && <Skeleton h={300} />}
          {rows && !rows.length && <Empty icon="search">Участники не найдены.</Empty>}
          {rows && rows.length > 0 && (
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr>
                    <th>Код</th>
                    <th>Участник</th>
                    <th>Регион</th>
                    <th>Особые условия</th>
                    <th className="r">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const s = p.specialConditions;
                    return (
                      <tr key={p.id}>
                        <td className="mono small" data-label="Код">
                          {p.code}
                        </td>
                        <td data-label="Участник">{p.displayName}</td>
                        <td className="small muted" data-label="Регион">
                          {p.regionCode}
                        </td>
                        <td data-label="Особые условия">
                          <div className="row wrap" style={{ '--gap': '6px' } as React.CSSProperties}>
                            {!hasConditions(s) && <span className="small muted">нет</span>}
                            {s.extraTime && <span className="badge accent">+1,5 ч</span>}
                            {s.scale !== 100 && <span className="badge accent">масштаб {s.scale} %</span>}
                            {s.contrast && <span className="badge accent">контраст</span>}
                          </div>
                        </td>
                        <td className="r" data-label="Действия">
                          <div className="row-actions">
                            <button type="button" className="btn btn-sm" onClick={() => { setEdit(p); setSc(p.specialConditions); }}>
                              Изменить
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {edit && (
        <Confirm
          title={`Особые условия · ${edit.displayName}`}
          confirmLabel="Сохранить"
          secondStep={false}
          onClose={() => setEdit(undefined)}
          onConfirm={async () => {
            await staffApi.put(`/participants/${edit.id}/special-conditions`, sc);
            toast('Особые условия сохранены', 'ok');
            await reload();
          }}
        >
          <label className="check">
            <input type="checkbox" checked={sc.extraTime} onChange={(e) => setSc({ ...sc, extraTime: e.target.checked })} /> Увеличить продолжительность на 1,5 часа
          </label>
          {/* не <label>: щелчок по подписи нажимал бы первую кнопку группы */}
          <div className="field">
            <span className="label" id="scale-label">
              Масштаб интерфейса
            </span>
            <div className="seg" role="group" aria-labelledby="scale-label" style={{ alignSelf: 'flex-start' }}>
              {([100, 150, 200] as const).map((v) => (
                <button key={v} type="button" aria-pressed={sc.scale === v} onClick={() => setSc({ ...sc, scale: v })}>
                  {v} %
                </button>
              ))}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={sc.contrast} onChange={(e) => setSc({ ...sc, contrast: e.target.checked })} /> Контрастная тема
          </label>
          <p className="hint">Условия применяются в модуле «Экзамен» до начала отсчёта; изменить продолжительность после начала попытки нельзя.</p>
        </Confirm>
      )}
    </>
  );
}

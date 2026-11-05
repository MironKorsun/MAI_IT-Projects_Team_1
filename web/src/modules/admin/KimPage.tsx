import { useState } from 'react';
import { staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { ErrorBox, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDateTime, plural } from '../../lib/format';
import './admin.css';

/** Импорт вариантов КИМ (ТЗ СЧ FR-28; ТЗ КИМ FR-23, FR-26) и шкалы перевода (ТЗ СЧ FR-34; ТЗ АО FR-01). */
interface ExamDir {
  code: string;
  title: string;
  scale: 'test' | 'grade';
  variants: { id: string; number: number; title: string; tasks: number; importedAt: string; checksum: string }[];
}
interface Scale {
  examCode: string;
  year: number;
  version: string;
  kind: 'test' | 'grade';
  values: number[];
  threshold: number;
  loadedAt: string;
}

export default function KimPage() {
  const toast = useToast();
  const exams = useLoad(() => staffApi.get<ExamDir[]>('/exams'));
  const scales = useLoad(() => staffApi.get<Scale[]>('/scales'));
  const [json, setJson] = useState('');
  const [check, setCheck] = useState<{ valid: boolean; errors: { pointer: string; detail: string }[]; ms: number }>();
  const [err, setErr] = useState<unknown>();

  const parsed = () => {
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  };
  const validate = async () => {
    setErr(undefined);
    const body = parsed();
    if (!body) return setCheck({ valid: false, errors: [{ pointer: '/', detail: 'Файл не является корректным JSON' }], ms: 0 });
    try {
      setCheck(await staffApi.post('/kim/validate', body));
    } catch (e) {
      setErr(e);
    }
  };
  const importIt = async () => {
    try {
      const r = await staffApi.post<{ title: string; tasks: number }>('/kim/imports', parsed());
      toast(`Импортирован «${r.title}» (${r.tasks} ${plural(r.tasks, 'задание', 'задания', 'заданий')})`, 'ok');
      setJson('');
      setCheck(undefined);
      await exams.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const latest = (code: string) => scales.data?.filter((s) => s.examCode === code).at(-1);
  const total = exams.data?.reduce((n, e) => n + e.variants.length, 0) ?? 0;

  return (
    <>
      <PageHead eyebrow="Администрирование" title="КИМ и шкалы перевода" subtitle="Варианты хранятся зашифрованными; эталоны ответов не передаются клиентам." />
      <div className="bento reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <section className="glass card span-6 t-span-12" aria-labelledby="pkg-h">
          <div className="card-head">
            <h2 id="pkg-h" className="h3">
              Варианты КИМ
            </h2>
            {exams.data && (
              <span className="meta num">
                {total} {plural(total, 'вариант', 'варианта', 'вариантов')}
              </span>
            )}
          </div>
          {exams.error ? <ErrorBox error={exams.error} onRetry={exams.reload} /> : null}
          {!exams.data && !exams.error && <Skeleton h={160} />}
          <div className="stack" style={{ '--gap': '24px' } as React.CSSProperties}>
            {exams.data?.map((e) => (
              <div key={e.code} className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
                <div className="row between wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
                  <span className="strong">{e.title}</span>
                  <span className="badge outline">{e.scale === 'test' ? 'тестовый балл 0–100' : 'отметка 2–5'}</span>
                </div>
                {e.variants.length ? (
                  e.variants.map((v) => (
                    <div key={v.id} className="tile row between" style={{ padding: '12px 16px', '--gap': '12px' } as React.CSSProperties}>
                      <div className="stack" style={{ '--gap': '2px', minWidth: 0 } as React.CSSProperties}>
                        <span className="small strong">{v.title}</span>
                        <span className="tiny muted">
                          {v.tasks} {plural(v.tasks, 'задание', 'задания', 'заданий')} · импорт {fmtDateTime(v.importedAt)}
                        </span>
                      </div>
                      <span className="tiny mono muted row" style={{ '--gap': '4px', flex: 'none' } as React.CSSProperties} title="SHA-256 открытого текста">
                        <Icon name="lock" size={12} /> {v.checksum.slice(0, 12)}…
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="small muted">Варианты не импортированы.</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="glass card span-6 t-span-12" aria-labelledby="scale-h">
          <div className="card-head">
            <h2 id="scale-h" className="h3">
              Шкалы перевода
            </h2>
            <span className="meta">серым — ниже порога</span>
          </div>
          {scales.error ? <ErrorBox error={scales.error} onRetry={scales.reload} /> : null}
          {(!exams.data || !scales.data) && !exams.error && !scales.error && <Skeleton h={160} />}
          {exams.data && scales.data && (
            <div className="stack" style={{ '--gap': '24px' } as React.CSSProperties}>
              {exams.data.map((e) => (
                <ScaleView key={e.code} title={e.title} scale={latest(e.code)} />
              ))}
            </div>
          )}
        </section>

        <section className="glass card span-12" aria-labelledby="imp-h">
          <div className="card-head wrap">
            <div className="stack" style={{ '--gap': '4px' } as React.CSSProperties}>
              <h2 id="imp-h" className="h3">
                Импорт варианта
              </h2>
              <span className="small muted">
                JSON по схеме <span className="mono">kim.schema.json</span>. Вариант проверяется по схеме, формату эталонов и критериям и принимается только целиком.
              </span>
            </div>
            <label className="btn">
              <Icon name="upload" /> Выбрать файл
              <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => e.target.files?.[0]?.text().then((t) => { setJson(t); setCheck(undefined); })} />
            </label>
          </div>
          <div className="stack">
            <textarea className="textarea mono" rows={10} style={{ fontSize: 13 }} value={json} onChange={(e) => { setJson(e.target.value); setCheck(undefined); }} placeholder='{ "variant": 3, "examCode": "math-profile", "title": "…", "tasks": [ … ] }' aria-label="Содержимое варианта в формате JSON" />
            <div className="row wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
              <button type="button" className="btn" onClick={validate} disabled={!json.trim()}>
                <Icon name="checkCircle" /> Проверить
              </button>
              <button type="button" className="btn btn-primary" onClick={importIt} disabled={!check?.valid}>
                Импортировать
              </button>
            </div>
            {check && (
              <div className="tile card-tight stack fade-in" style={{ '--gap': '8px' } as React.CSSProperties} role="status">
                {check.valid ? (
                  <StatusBadge tone="ok" icon="checkCircle">
                    Ошибок нет · проверка {check.ms} мс
                  </StatusBadge>
                ) : (
                  <>
                    <StatusBadge tone="bad" icon="xCircle">
                      Ошибок: {check.errors.length}
                    </StatusBadge>
                    {check.errors.slice(0, 20).map((e, i) => (
                      <div key={i} className="small">
                        <span className="mono muted">{e.pointer}</span> — {e.detail}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            {err ? <ErrorBox error={err} /> : null}
          </div>
        </section>
      </div>
    </>
  );
}

/** Шкала перевода — компактная таблица в строку; длинная шкала делится на равные части. */
function ScaleView({ title, scale }: { title: string; scale?: Scale }) {
  if (!scale)
    return (
      <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
        <span className="strong">{title}</span>
        <p className="small muted">Шкала не загружена.</p>
      </div>
    );
  const n = scale.values.length;
  const per = Math.ceil(n / Math.ceil(n / 13));
  const parts = Array.from({ length: Math.ceil(n / per) }, (_, k) => scale.values.slice(k * per, (k + 1) * per).map((v, j) => ({ primary: k * per + j, v })));
  const pass = scale.values.findIndex((v) => v >= scale.threshold);
  return (
    <div className="stack" style={{ '--gap': '8px' } as React.CSSProperties}>
      <div className="row between wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
        <span className="strong">{title}</span>
        <span className="small muted num">
          {scale.year} · версия {scale.version} · порог {scale.threshold}
        </span>
      </div>
      {parts.map((cells, k) => (
        <div key={k} className="table-wrap">
          <table className="table table-compact scale-table">
            <caption className="sr-only">
              Шкала перевода «{title}», версия {scale.version}
              {parts.length > 1 ? `, часть ${k + 1} из ${parts.length}` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="row">Первичный</th>
                {cells.map((c) => (
                  <th key={c.primary} scope="col">
                    {c.primary}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{scale.kind === 'test' ? 'Тестовый' : 'Отметка'}</th>
                {cells.map((c) => (
                  <td key={c.primary} className={c.v < scale.threshold ? 'below' : c.primary === pass ? 'pass' : undefined}>
                    {c.v}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

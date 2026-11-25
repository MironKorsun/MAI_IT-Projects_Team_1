import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { KimCandidate, KimEditorInfo, KimPosition, KimPreview, KimSelection } from '../../../../shared/kim';
import { PageHead } from '../../components/Shell';
import { useStaff } from '../../components/StaffSession';
import { ErrorBox, Modal, Skeleton, useLoad } from '../../components/ui';
import { staffApi } from '../../lib/api';
import { Formula } from '../../lib/richtext';
import { Markdown } from '../exam/Markdown';
import { TaskContent } from '../exam/TaskContent';
import './admin.css';

const level = { basic: 'Базовый', advanced: 'Повышенный' };

export default function KimEditor() {
  const { me } = useStaff();
  const editor = useLoad(() => staffApi.get<KimEditorInfo>('/kim/editor'));
  return (
    <>
      <PageHead eyebrow="Материалы" title="Редактор КИМ" />
      {editor.error ? <ErrorBox error={editor.error} onRetry={editor.reload} /> : null}
      {!editor.data && !editor.error && <Skeleton h={240} />}
      {editor.data && me && <BankEditor key={me.id} info={editor.data} storageKey={`ege.kim.draft.${me.id}`} canEdit={me.roles.includes('admin')} />}
    </>
  );
}

function loadDraft(key: string, count: number): KimSelection {
  try {
    const draft = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (draft && Number.isInteger(draft.number) && Array.isArray(draft.taskIds)
      && draft.taskIds.length === count && draft.taskIds.every((id: unknown) => typeof id === 'string')) return draft;
  } catch {
    // Хранилище недоступно или черновик повреждён.
  }
  return { number: 1001, taskIds: Array<string>(count).fill('') };
}

function BankEditor({ info, storageKey, canEdit }: { info: KimEditorInfo; storageKey: string; canEdit: boolean }) {
  const [subject, setSubject] = useState(canEdit ? '' : info.examCode);
  const [draft, setDraft] = useState(() => loadDraft(storageKey, info.positions.length));
  const [active, setActive] = useState<number>();
  const [preview, setPreview] = useState<KimPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [storageError, setStorageError] = useState(false);
  const [downloaded, setDownloaded] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const version = draft.version ?? '1.0.0';
  const ready = /^\d+\.\d+\.\d+$/.test(version) && Number.isInteger(draft.number) && draft.number > 0 && draft.number <= 100_000 && draft.taskIds.every(Boolean);
  const positions = info.positions.filter(p => !difficulty || p.difficulty === difficulty);
  const selectedPosition = info.positions.find(p => p.number === active);

  useEffect(() => {
    if (!canEdit) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [draft, storageKey, canEdit]);

  async function run(action: 'preview' | 'export') {
    setBusy(true);
    setError(undefined);
    setDownloaded('');
    try {
      if (action === 'preview') {
        setPreview(await staffApi.post<KimPreview>('/kim/editor/preview', draft));
      } else {
        const response = await staffApi.post<Response>('/kim/editor/export', draft, { raw: true });
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = `kim-variant-${draft.number}.zip`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        setDownloaded(response.headers.get('x-checksum-sha256') ?? '');
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <section className="glass card stack" aria-label="Предмет и кодификатор">
        <label className="field">
          Предмет
          <select className="input" value={subject} disabled={busy} onChange={e => setSubject(e.target.value)}>
            <option value="">Выберите предмет</option>
            <option value={info.examCode}>{info.subject}</option>
          </select>
        </label>
        {subject && <>
          <p className="muted">{info.variants} вариантов · {info.taskCount} заданий · {info.duration} минут на экзамен</p>
          <details>
            <summary>Темы кодификатора ({info.topics.length})</summary>
            <p>{info.topics.join(', ')}</p>
          </details>
        </>}
      </section>
      {subject && (
        <section className="glass card stack" aria-labelledby="plan-h">
          <div className="row between wrap">
            <h2 id="plan-h" className="h3">План варианта</h2>
            {canEdit && (
              <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(info.demo); setDownloaded(''); setError(undefined); }}>
                Открыть вариант № {info.demo.number}
              </button>
            )}
          </div>
          {canEdit && (
            <div className="form-grid">
              <label className="field">
                Номер собираемого варианта
                <input type="number" min={1} max={100000} className="input" value={draft.number || ''} disabled={busy} onChange={e => { setDraft({ ...draft, number: Number(e.target.value) }); setDownloaded(''); }} />
              </label>
              <label className="field">
                Версия пакета
                <input className="input" value={version} maxLength={24} disabled={busy} onChange={e => { setDraft({ ...draft, version: e.target.value }); setDownloaded(''); }} />
              </label>
            </div>
          )}
          <label className="field">
            Сложность
            <select className="input" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              <option value="">Все уровни</option>
              <option value="basic">Базовый</option>
              <option value="advanced">Повышенный</option>
            </select>
          </label>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th scope="col">Позиция</th><th scope="col">Допустимые темы</th><th scope="col">Сложность</th><th scope="col">Норматив, мин</th>{canEdit && <th scope="col">Задание</th>}</tr>
              </thead>
              <tbody>
                {positions.map(p => (
                  <tr key={p.number}>
                    <th scope="row">{p.number}</th>
                    <td>{p.topic_options.map(t => t.topic_code).join(', ')}</td>
                    <td>{level[p.difficulty]}</td>
                    <td>{p.recommended_min}</td>
                    {canEdit && <td><button type="button" className="btn" disabled={busy} onClick={() => setActive(p.number)} aria-label={`Подобрать задание для позиции ${p.number}`}>
                      {draft.taskIds[p.number - 1] || 'Подобрать'}
                    </button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit && (
            <>
              <p role="status">Заполнено {draft.taskIds.filter(Boolean).length} из {info.positions.length}{storageError ? ' · браузер не сохранил черновик' : ''}</p>
              <div className="row wrap">
                <button type="button" className="btn" disabled={!ready || busy} onClick={() => void run('preview')}>Предпросмотр</button>
                <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void run('export')}>Проверить и скачать ZIP</button>
                <Link className="btn" to="/staff/admin/kim">К импорту КИМ</Link>
              </div>
              {downloaded && <p className="small" style={{ overflowWrap: 'anywhere' }} role="status">ZIP скачан. SHA-256 {downloaded}</p>}
              {error ? <ErrorBox error={error} /> : null}
            </>
          )}
        </section>
      )}
      {selectedPosition && <CandidatePicker key={selectedPosition.number} position={selectedPosition} onClose={() => setActive(undefined)} onSelect={id => {
        setDraft(prev => ({ ...prev, taskIds: prev.taskIds.map((taskId, i) => i === selectedPosition.number - 1 ? id : taskId) }));
        setActive(undefined);
        setDownloaded('');
        setError(undefined);
      }} />}
      {preview && <Preview preview={preview} onClose={() => setPreview(undefined)} />}
    </div>
  );
}

function CandidatePicker({ position, onClose, onSelect }: { position: KimPosition; onClose(): void; onSelect(id: string): void }) {
  const [topic, setTopic] = useState('');
  const [search, setSearch] = useState('');
  const candidates = useLoad(
    () => staffApi.get<KimCandidate[]>(`/kim/editor/candidates/${position.number}?topic=${encodeURIComponent(topic)}`),
    [position.number, topic],
  );
  const query = search.trim().toLocaleLowerCase('ru');
  const list = candidates.data?.filter(c => `${c.id} ${c.label}`.toLocaleLowerCase('ru').includes(query)) ?? [];
  return (
    <Modal title={`Задание для позиции ${position.number}`} onClose={onClose} wide>
      <div className="stack">
        <p>Уровень по плану: {level[position.difficulty].toLowerCase()}</p>
        <label className="field">
          Тема
          <select className="input" value={topic} onChange={e => setTopic(e.target.value)}>
            <option value="">Все допустимые темы</option>
            {position.topic_options.map(t => <option key={t.topic_code} value={t.topic_code}>{t.topic_code}</option>)}
          </select>
        </label>
        <label className="field">Поиск по условию или ID<input className="input" value={search} onChange={e => setSearch(e.target.value)} /></label>
        {candidates.loading && <Skeleton h={100} />}
        {candidates.error ? <ErrorBox error={candidates.error} onRetry={candidates.reload} /> : null}
        {!candidates.loading && !candidates.error && (
          <>
            <p role="status">Найдено: {list.length}{list.length > 50 ? ' · показано 50, уточните поиск' : ''}</p>
            <div className="stack" style={{ maxHeight: '42vh', overflow: 'auto' }}>
              {list.slice(0, 50).map(c => (
                <button type="button" key={c.id} className="btn" style={{ height: 'auto', whiteSpace: 'normal', textAlign: 'left', justifyContent: 'start' }} onClick={() => onSelect(c.id)}>
                  {c.id} · {c.topic} · {c.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Preview({ preview, onClose }: { preview: KimPreview; onClose(): void }) {
  const [number, setNumber] = useState(preview.tasks[0].number);
  const task = preview.tasks.find(t => t.number === number)!;
  return (
    <Modal title={preview.title} onClose={onClose} wide>
      <div className="stack">
        <label className="field">
          Задание
          <select className="input" value={number} onChange={e => setNumber(Number(e.target.value))}>
            {preview.tasks.map(t => <option key={t.id} value={t.number}>{t.number}</option>)}
          </select>
        </label>
        <TaskContent task={task} />
        <label className="field">Ответ<input className="input" key={task.id} placeholder={task.formatHint} inputMode="decimal" /></label>
        {preview.references.filter(r => task.referenceIds?.includes(r.id)).map(r => (
          <section key={r.id}>
            <h3>{r.title}</h3>
            {r.latex && (Array.isArray(r.latex) ? r.latex : [r.latex]).map((formula, i) => <Formula key={i} src={formula} display />)}
          </section>
        ))}
        <details><summary>Инструкция участника</summary><Markdown text={preview.instruction} skipTitle /></details>
      </div>
    </Modal>
  );
}

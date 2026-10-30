import { useState } from 'react';
import type { StaffRole } from '../../../../shared/types';
import { ROLE_LABEL } from '../../../../shared/types';
import { ApiError, staffApi } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Confirm, Empty, ErrorBox, Skeleton, StatusBadge, useLoad, useToast } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { fmtDate, plural } from '../../lib/format';

/** ЭФ-15 «Пользователи и роли» (ТЗ КЧ FR-40). */
interface U {
  id: string;
  login: string;
  fullName: string;
  roles: StaffRole[];
  blocked: boolean;
  createdAt: string;
}
const ROLES: StaffRole[] = ['organizer', 'admin', 'observer', 'analyst'];

export default function StaffUsers() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => staffApi.get<U[]>('/staff'));
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState<U>();
  const [block, setBlock] = useState<U>();
  const [f, setF] = useState({ login: '', fullName: '', password: '', roles: [] as StaffRole[] });
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [role, setRole] = useState<StaffRole | ''>('');

  const toggle = (list: StaffRole[], r: StaffRole) => (list.includes(r) ? list.filter((x) => x !== r) : [...list, r]);
  const needle = q.trim().toLowerCase();
  const rows = data?.filter((u) => (!role || u.roles.includes(role)) && (!needle || u.fullName.toLowerCase().includes(needle) || u.login.toLowerCase().includes(needle)));

    return (
    <>
      <PageHead
        eyebrow="Администрирование"
        title="Персонал и роли"
        subtitle="Учётные записи участника и персонала не совмещаются."
        actions={
          <button type="button" className="btn btn-lg btn-primary" onClick={() => { setF({ login: '', fullName: '', password: '', roles: [] }); setFieldErr({}); setCreate(true); }}>
            <Icon name="plus" /> Новый сотрудник
          </button>
        }
      />
            <div className="reveal" style={{ '--i': 1 } as React.CSSProperties}>
        <div className="filter-bar" role="search">
          <div className="search">
            <Icon name="search" />
            <input className="input" type="text" placeholder="ФИО или логин" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск сотрудника" />
          </div>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value as StaffRole | '')} aria-label="Роль">
            <option value="">Все роли</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          {(q || role) && (
            <button type="button" className="btn btn-lg btn-ghost" onClick={() => { setQ(''); setRole(''); }}>
              <Icon name="x" /> Сбросить
            </button>
          )}
          {rows && (
            <span className="small muted num push">
              {rows.length} {plural(rows.length, 'сотрудник', 'сотрудника', 'сотрудников')}
            </span>
          )}
                  </div>
        {error ? <ErrorBox error={error} onRetry={reload} /> : null}
        <section className="glass table-panel" aria-label="Сотрудники" style={error ? { marginTop: 12 } : undefined}>
          {!rows && !error && <Skeleton h={260} />}
          {rows && !rows.length && <Empty icon="users">Сотрудники не найдены.</Empty>}
          {rows && rows.length > 0 && (
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr>
                    <th>Сотрудник</th>
                    <th>Логин</th>
                    <th>Роли</th>
                    <th>Создан</th>
                    <th>Статус</th>
                    <th className="r">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td data-label="Сотрудник">
                        <div className="row" style={{ '--gap': '12px' } as React.CSSProperties}>
                          <span className="avatar" style={{ width: 32, height: 32, fontSize: 12 }} aria-hidden="true">
                            {u.fullName
                              .split(' ')
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((x) => x[0].toUpperCase())
                              .join('')}
                          </span>
                          {u.fullName}
                        </div>
                      </td>
                      <td className="mono small" data-label="Логин">
                        {u.login}
                      </td>
                                            <td data-label="Роли">
                        <div className="row wrap" style={{ '--gap': '4px' } as React.CSSProperties}>
                          {u.roles.map((r) => (
                            <span key={r} className="badge outline">
                              {ROLE_LABEL[r]}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="small muted num" data-label="Создан">
                        {fmtDate(u.createdAt)}
                      </td>
                      <td data-label="Статус">
                        {u.blocked ? (
                          <StatusBadge tone="bad" icon="lock">
                            Заблокирован
                          </StatusBadge>
                        ) : (
                          // обычное состояние — тихий текст; бейдж только у исключения «Заблокирован»
                          <span className="small ink2 row" style={{ '--gap': '6px' } as React.CSSProperties}>
                            <Icon name="check" size={16} style={{ color: 'var(--ok)' }} />
                            Активен
                          </span>
                        )}
                      </td>
                      <td className="r" data-label="Действия">
                        <div className="row-actions">
                          <button type="button" className="btn btn-sm" onClick={() => setEdit(u)}>
                            Роли
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => setBlock(u)}>
                            {u.blocked ? 'Разблокировать' : 'Заблокировать'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

            {create && (
        <Confirm
          title="Новый сотрудник"
          confirmLabel="Создать"
          secondStep={false}
          onClose={() => setCreate(false)}
          onConfirm={async () => {
            try {
              await staffApi.post('/staff', f);
            } catch (e) {
              if (e instanceof ApiError) setFieldErr(e.fieldErrors());
              throw e;
            }
            toast('Учётная запись создана', 'ok');
            await reload();
          }}
                  >
          <div className="form-grid">
            <label className="field full">
              <span className="label">ФИО</span>
              <input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
            </label>
            <label className="field">
              <span className="label">Логин</span>
              <input className="input mono" autoComplete="off" value={f.login} onChange={(e) => setF({ ...f, login: e.target.value.toLowerCase() })} aria-invalid={!!fieldErr.login} />
              {fieldErr.login && <span className="error-text">{fieldErr.login}</span>}
            </label>
            <label className="field">
              <span className="label">Пароль (≥ 12 символов)</span>
              <input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-invalid={!!fieldErr.password} />
              {f.password && f.password.length < 12 && <span className="error-text">Ещё {12 - f.password.length} симв.</span>}
            </label>
            <RolePicker className="full" value={f.roles} onToggle={(r) => setF({ ...f, roles: toggle(f.roles, r) })} />
          </div>
        </Confirm>
      )}
      {edit && <RolesDialog user={edit} onClose={() => setEdit(undefined)} onSaved={reload} />}
      {block && (
        <Confirm
          title={block.blocked ? 'Разблокировать учётную запись?' : 'Заблокировать учётную запись?'}
          confirmLabel={block.blocked ? 'Разблокировать' : 'Заблокировать'}
          danger={!block.blocked}
          secondStep={!block.blocked}
          onClose={() => setBlock(undefined)}
          onConfirm={async () => {
            await staffApi.patch('/staff', { id: block.id, blocked: !block.blocked });
            toast(block.blocked ? 'Учётная запись разблокирована' : 'Учётная запись заблокирована, сеансы завершены', 'ok');
            await reload();
          }}
        >
          <p className="muted">
            {block.fullName} · {block.login}
          </p>
        </Confirm>
      )}
    </>
  );
}

/** Выбор ролей: выбранная — сплошной белый со значком «✓», не только цвет. */
function RolePicker({ value, onToggle, className }: { value: StaffRole[]; onToggle: (r: StaffRole) => void; className?: string }) {
  return (
    <fieldset className={`field${className ? ` ${className}` : ''}`} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
        Роли
      </legend>
      <div className="row wrap" style={{ '--gap': '8px' } as React.CSSProperties}>
        {ROLES.map((r) => {
          const on = value.includes(r);
          return (
            <button key={r} type="button" className="btn btn-choice" aria-pressed={on} onClick={() => onToggle(r)}>
              <Icon name={on ? 'check' : 'plus'} /> {ROLE_LABEL[r]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function RolesDialog({ user, onClose, onSaved }: { user: U; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [roles, setRoles] = useState(user.roles);
  return (
    <Confirm title={`Роли · ${user.fullName}`} confirmLabel="Сохранить" secondStep={false} onClose={onClose} onConfirm={async () => {
      await staffApi.patch('/staff', { id: user.id, roles });
      toast('Роли изменены', 'ok');
      onSaved();
    }}>
      <RolePicker value={roles} onToggle={(r) => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])} />
    </Confirm>
  );
}
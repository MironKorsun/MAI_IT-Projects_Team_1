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
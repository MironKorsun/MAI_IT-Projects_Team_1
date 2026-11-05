import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { StaffRole } from '../../../shared/types';
import { ROLE_LABEL } from '../../../shared/types';
import { Icon, type IconName } from './Icon';
import { Backdrop, Brand } from './ui';
import { useStaff } from './StaffSession';

interface NavDef {
  to: string;
  label: string;
  icon: IconName;
  roles: StaffRole[];
  section: string;
  /** Счётчик на пункте (например, новые обращения); 0 и пусто не показываются. */
  count?: number;
}

const NAV: NavDef[] = [
  { to: '/staff/rooms', label: 'Мои аудитории', icon: 'users', roles: ['organizer'], section: 'Проведение' },
  { to: '/staff/admin/sessions', label: 'Экзаменационные сессии', icon: 'layers', roles: ['admin'], section: 'Администрирование' },
  { to: '/staff/admin/participants', label: 'Участники', icon: 'user', roles: ['admin'], section: 'Администрирование' },
  { to: '/staff/admin/staff', label: 'Персонал и роли', icon: 'shield', roles: ['admin'], section: 'Администрирование' },
  { to: '/staff/admin/kim', label: 'КИМ и шкалы', icon: 'book', roles: ['admin'], section: 'Администрирование' },
  { to: '/staff/admin/appeals', label: 'Апелляции', icon: 'message', roles: ['admin'], section: 'Администрирование' },
  { to: '/staff/monitor', label: 'Сводная панель', icon: 'monitor', roles: ['observer', 'admin'], section: 'Мониторинг' },
  { to: '/staff/monitor/log', label: 'Журнал событий', icon: 'list', roles: ['observer', 'admin'], section: 'Мониторинг' },
  { to: '/staff/analytics', label: 'Аналитика', icon: 'chart', roles: ['analyst', 'admin', 'observer'], section: 'Аналитика' },
];

const FOCUSABLE = 'a[href], button:not([disabled])';
/** Ширина, начиная с которой вместо выдвижного меню показывается боковая панель (B.9). */
const WIDE = '(min-width: 1024px)';

interface NavProps {
  items: NavDef[];
  sections: string[];
  fullName: string;
  roles: string;
  initials: string;
  onLogout: () => void;
  /** Только в выдвижном меню (.drawer — position: fixed): кнопка «Закрыть» справа от знака. */
  onClose?: () => void;
}

/** Содержимое навигации — общее для боковой панели и выдвижного меню. */
function NavContent({ items, sections, fullName, roles, initials, onLogout, onClose }: NavProps) {
  // Разные id у боковой панели и выдвижного меню (оба могут быть в DOM одновременно)
  const idPrefix = `nav-${useId().replace(/:/g, '')}`;
  return (
    <>
      <Brand />
      {onClose && (
        // В ряду знака (48 px под верхним отступом 16 px), справа
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Закрыть меню" title="Закрыть меню" style={{ position: 'absolute', top: 18, right: 12 }}>
          <Icon name="x" />
        </button>
      )}
      <div className="nav-scroll">
        {sections.map((s, n) => (
          <div key={s} className="nav-group" role="group" aria-labelledby={`${idPrefix}-${n}`}>
            <div id={`${idPrefix}-${n}`} className="nav-section">
              {s}
            </div>
            {items
              .filter((i) => i.section === s)
              .map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/staff/monitor'} className="nav-item" data-label={i.label}>
                  <Icon name={i.icon} />
                  <span className="nav-label">{i.label}</span>
                  {i.count ? <span className="nav-count">{i.count}</span> : null}
                </NavLink>
              ))}
          </div>
        ))}
      </div>
      <div className="user-card">
        <span className="avatar" aria-hidden="true" title={fullName}>
          {initials}
        </span>
        <div className="grow">
          <div className="user-name" title={fullName}>
            {fullName}
          </div>
          <div className="user-roles">{roles}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onLogout} aria-label="Выйти" title="Выйти">
          <Icon name="logout" />
        </button>
      </div>
    </>
  );
}

export function StaffShell() {
  const { me, logout } = useStaff();
  const loc = useLocation();
  // Первый экран после загрузки появляется с .reveal; после перехода — только мягкое проявление (E.3)
  const firstKey = useRef(loc.key);
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);

  // Переход по разделу закрывает меню; фокус — на содержимое новой страницы, а не на «Меню»
  useEffect(() => {
    if (!wasOpen.current) return;
    wasOpen.current = false;
    setDrawer(false);
    requestAnimationFrame(() => document.getElementById('main')?.focus());
  }, [loc.key]);

  // Открытое меню модально: страница под ним не прокручивается и недоступна (inert) для клавиатуры и скринридера
  useEffect(() => {
    const els = [barRef.current, mainRef.current] as (HTMLElement & { inert: boolean })[];
    for (const el of els) if (el) el.inert = drawer;
    document.body.style.overflow = drawer ? 'hidden' : '';
    return () => {
      for (const el of els) if (el) el.inert = false;
      document.body.style.overflow = '';
    };
  }, [drawer]);

  // Расширение окна до боковой панели закрывает меню
  useEffect(() => {
    const mq = window.matchMedia?.(WIDE);
    if (!mq) return;
    const onChange = () => mq.matches && setDrawer(false);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Открыто: фокус на первый раздел, Esc закрывает, Tab не выходит за меню. Закрыто: фокус возвращается на кнопку «Меню».
  useEffect(() => {
    if (!drawer) {
      if (wasOpen.current) {
        wasOpen.current = false;
        menuBtn.current?.focus();
      }
      return;
    }
    wasOpen.current = true;
    const el = drawerRef.current;
    el?.querySelector<HTMLElement>('.nav-item')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setDrawer(false);
      }
      if (e.key === 'Tab' && el) {
        const f = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  if (!me) return null;
  const items = NAV.filter((n) => n.roles.some((r) => me.roles.includes(r)));
  const sections = [...new Set(items.map((i) => i.section))];
  const initials = me.fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');
  const nav: NavProps = {
    items,
    sections,
    fullName: me.fullName,
    roles: me.roles.map((r) => ROLE_LABEL[r]).join(', '),
    initials,
    onLogout: () => logout(),
  };
  return (
    <div className="shell">
      <Backdrop />
      <a className="skip-link" href="#main">
        К содержимому
      </a>
      <header ref={barRef} className="mobilebar">
        <Brand />
        <button
          ref={menuBtn}
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label="Меню"
          aria-expanded={drawer}
          aria-controls={drawer ? 'staff-drawer' : undefined}
          onClick={() => setDrawer(true)}
        >
          <Icon name="list" />
        </button>
      </header>
      <aside className="sidebar">
        <nav className="sidebar-inner" aria-label="Разделы">
          <NavContent {...nav} />
        </nav>
      </aside>
      {drawer && (
        <>
          <div className="drawer-overlay" aria-hidden="true" onClick={() => setDrawer(false)} />
          <div id="staff-drawer" ref={drawerRef} className="drawer glass-float" role="dialog" aria-modal="true" aria-label="Меню">
            <nav className="drawer-nav" aria-label="Разделы">
              <NavContent {...nav} onClose={() => setDrawer(false)} />
            </nav>
          </div>
        </>
      )}
      <main ref={mainRef} id="main" key={loc.pathname} tabIndex={-1} className={loc.key === firstKey.current ? 'main' : 'main route-fade'}>
        <Outlet />
      </main>
    </div>
  );
}

/** Заголовок страницы персонала: подзаголовок-«бровь», H1, пояснение и действия справа. */
export function PageHead({ eyebrow, title, subtitle, actions }: { eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head reveal" style={{ '--i': 0 } as CSSProperties}>
      <div className="titles">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="h1">{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

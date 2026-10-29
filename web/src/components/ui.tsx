import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import { describeError } from '../lib/api';

/** Фон: спокойный светлый градиент с едва заметным мятным свечением сверху, без движения (`still` сохранён для совместимости). */
export function Backdrop(_props: { still?: boolean }) {
  return <div className="backdrop" aria-hidden="true" />;
}

/**
 * Знак системы: мятная плитка с «Σ» и подпись. `compact` — только знак;
 * `href` — знак становится ссылкой (на портале и в М6 — на главную).
 */
export function Brand({ compact, href, label = 'ВП ТС ЕГЭ, на главную' }: { compact?: boolean; href?: string; label?: string }) {
  const content = (
    <>
      <span className="brand-mark" aria-hidden="true">
        <Icon name="sigma" />
      </span>
      {!compact && (
        <span className="brand-text">
          ВП ТС ЕГЭ
          <small>тестирующая система</small>
        </span>
      )}
    </>
  );
  if (href)
    return (
      <Link to={href} className="brand" aria-label={label}>
        {content}
      </Link>
    );
  return <div className="brand">{content}</div>;
}

// ---------- контрастная тема ----------
const THEME_KEY = 'ege-theme';

/** Восстанавливает сохранённую контрастную тему (вызывается до первого рендера, кроме М1). */
export function restoreTheme() {
  try {
    if (localStorage.getItem(THEME_KEY) === 'contrast') document.documentElement.dataset.theme = 'contrast';
  } catch {
    // хранилище недоступно (приватный режим) — тема по умолчанию
  }
}

/** Переключатель контрастной темы (портал, М6); выбор сохраняется в браузере. */
export function ContrastToggle({ className = '' }: { className?: string }) {
  const [on, setOn] = useState(() => document.documentElement.dataset.theme === 'contrast');
  const toggle = () => {
    const next = !on;
    const root = document.documentElement;
    if (next) root.dataset.theme = 'contrast';
    else delete root.dataset.theme;
    try {
      if (next) localStorage.setItem(THEME_KEY, 'contrast');
      else localStorage.removeItem(THEME_KEY);
    } catch {
      // без сохранения: тема действует до перезагрузки страницы
    }
    setOn(next);
  };
  return (
    <button type="button" className={`btn btn-icon${className ? ` ${className}` : ''}`} aria-pressed={on} aria-label="Контрастная тема" title="Контрастная тема" onClick={toggle}>
      <Icon name="eye" />
    </button>
  );
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Модальное окно с ловушкой фокуса и закрытием по Esc. */
export function Modal({
  title,
  children,
  onClose,
  wide,
  footer,
  labelledBy = 'dialog-title',
}: {
  title: ReactNode;
  children: ReactNode;
  onClose?: () => void;
  wide?: boolean;
  footer?: ReactNode;
  labelledBy?: string;
  }) {
  const ref = useRef<HTMLDivElement>(null);
  // Элемент, с которого открыли окно, — запоминается до autoFocus полей внутри окна
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // Обработчик закрытия через ref: родитель может передавать новую функцию на каждом рендере
  // (например, по тику таймера в М1), и фокус при этом не должен перескакивать.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = ref.current;
    const focusables = (root: ParentNode | null | undefined = el) => Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((x) => !x.hasAttribute('disabled'));
    // Фокус — на первое поле содержимого (или поле с autoFocus), иначе на кнопку «Закрыть»
    if (!el?.contains(document.activeElement)) (focusables(el?.querySelector('.dialog-body'))[0] ?? focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && close.current) close.current();
      if (e.key === 'Tab') {
        const f = focusables();
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
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus?.();
    };
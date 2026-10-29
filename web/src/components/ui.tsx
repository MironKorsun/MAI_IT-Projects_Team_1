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
      }, [opener]);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close.current?.()}>
      <div ref={ref} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1}>
        <div className="dialog-head">
          <h2 id={labelledBy} className="h2">
            {title}
          </h2>
          {onClose && (
            <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Закрыть" title="Закрыть">
              <Icon name="x" />
            </button>
          )}
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Двухшаговое подтверждение необратимых действий (ТЗ КЧ 6.6). */
export function Confirm({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
  secondStep = true,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
  secondStep?: boolean;
  }) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const go = async () => {
    if (secondStep && step === 1) return setStep(2);
    setBusy(true);
    setErr(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
    return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger solid' : 'btn-primary'}`} onClick={go} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {step === 1 && secondStep ? 'Продолжить' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack" style={{ '--gap': '12px' } as CSSProperties}>
        {children}
        {step === 2 && (
          <div className="notice warn top fade-in" role="alert">
            <Icon name="alert" className="lead-icon" size={20} />
            <span className="grow">Подтвердите ещё раз: действие нельзя отменить.</span>
          </div>
        )}
        {err ? <ErrorBox error={err} /> : null}
      </div>
    </Modal>
  );
}

/** Сообщение об ошибке в едином формате (FR-51). */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const d = describeError(error);
  return (
    <div className="notice bad top fade-in" role="alert">
      <Icon name="alert" className="lead-icon" size={20} />
      <div className="stack grow" style={{ '--gap': '4px', minWidth: 0 } as CSSProperties}>
        <span className="strong">{d.title}</span>
        <span className="small muted">{d.action}</span>
        {d.code && <span className="tiny muted mono">Код обращения: {d.code}</span>}
      </div>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

// ---------- уведомления ----------
interface Toast {
  id: number;
  text: ReactNode;
  tone?: 'ok' | 'bad' | 'info';
}
const TOAST_ICON: Record<NonNullable<Toast['tone']>, IconName> = { ok: 'checkCircle', bad: 'alert', info: 'info' };
const ToastCtx = createContext<(text: ReactNode, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: ReactNode, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone ?? 'info'}`}>
            <Icon name={TOAST_ICON[t.tone ?? 'info']} size={20} />
            <div className="grow" style={{ minWidth: 0 }}>
              {t.text}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
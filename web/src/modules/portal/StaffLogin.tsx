import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Backdrop, Brand } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { homeFor, useStaff } from '../../components/StaffSession';
import { ApiError } from '../../lib/api';

/** ЭФ-21 «Вход персонала» (ТЗ КЧ FR-50, NFR-23). */
export default function StaffLogin() {
  const { me, ready, login, idleNotice } = useStaff();
  const loc = useLocation();
  const [form, setForm] = useState({ login: '', password: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (ready && me) return <Navigate to={(loc.state as { from?: string })?.from ?? homeFor(me.roles)} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(form.login, form.password);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AUTH_LOCKED') setError('Вход заблокирован на 5 минут после 5 неудачных попыток.');
      else if (err instanceof ApiError) setError('Неверный логин или пароль.');
      else setError('Нет связи с сервером. Повторите попытку.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Backdrop />
      <main className="page-narrow">
        <div className="row between reveal" style={{ marginBottom: 24 }}>
          <Brand />
          <Link to="/" className="btn btn-ghost btn-sm">
            <Icon name="arrowLeft" /> На главную
          </Link>
        </div>
        <form className="glass panel card-lg stack reveal" style={{ '--i': 1, '--gap': '16px' } as CSSProperties} onSubmit={submit} noValidate>
          <div className="stack" style={{ '--gap': '8px', marginBottom: 8 } as CSSProperties}>
            <span className="eyebrow">ЕГЭ · Математика</span>
            <h1 className="h1">Вход для персонала</h1>
            <p className="muted small">Сеанс завершается автоматически после 30 минут бездействия.</p>
          </div>
          {idleNotice && (
            <div className="notice info" role="status">
              <Icon name="clock" className="lead-icon" size={20} />
              <span className="grow small">Сеанс завершён из-за бездействия. Войдите снова.</span>
            </div>
          )}
          <label className="field">
            <span className="label">Логин</span>
            <input
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={form.login}
              onChange={(e) => setForm({ ...form, login: e.target.value })}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span className="label">Пароль</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
            />
          </label>
          {error && (
            <div className="error-text" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !form.login || !form.password} style={{ marginTop: 8 }}>
            {busy ? <span className="spinner" /> : null}
            Войти
          </button>
        </form>
      </main>
    </div>
  );
}

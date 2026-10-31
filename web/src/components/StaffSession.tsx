import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { StaffRole } from '../../../shared/types';
import { staffApi } from '../lib/api';

export interface StaffMe {
  id: string;
  login: string;
  fullName: string;
  roles: StaffRole[];
  roomIds: string[];
}

interface Ctx {
  me?: StaffMe;
  ready: boolean;
  login: (login: string, password: string) => Promise<void>;
  logout: (reason?: 'user' | 'idle') => Promise<void>;
  idleNotice: boolean;
}

const C = createContext<Ctx>({ ready: false, login: async () => undefined, logout: async () => undefined, idleNotice: false });
export const useStaff = () => useContext(C);

const IDLE_MS = 30 * 60_000;

/**
 * Сеанс персонала: маркер в памяти, обновление по cookie; бездействие 30 мин завершает сеанс
 * во всех вкладках (ТЗ КЧ FR-50) — синхронизация через BroadcastChannel.
 */
export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<StaffMe>();
  const [ready, setReady] = useState(false);
  const [idleNotice, setIdleNotice] = useState(false);
  const lastActivity = useRef(Date.now());
  const channel = useRef<BroadcastChannel>();

  const loadMe = useCallback(async () => {
    const m = await staffApi.get<StaffMe>('/me');
    setMe(m);
  }, []);

  useEffect(() => {
    (async () => {
      if (await staffApi.refresh()) {
        try {
          await loadMe();
        } catch {
          /* нет сеанса */
        }
      }
      setReady(true);
    })();
    const off = staffApi.onUnauthorized(() => setMe(undefined));
    return () => {
      off();
    };
  }, [loadMe]);

  const logout = useCallback(async (reason: 'user' | 'idle' = 'user') => {
    await staffApi.logout(reason);
    setMe(undefined);
    if (reason === 'idle') setIdleNotice(true);
    channel.current?.postMessage({ type: 'logout', reason });
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('ege-staff');
    channel.current = ch;
    ch.onmessage = (e) => {
      if (e.data?.type === 'logout') {
        staffApi.setToken(undefined);
        setMe(undefined);
        if (e.data.reason === 'idle') setIdleNotice(true);
      }
      if (e.data?.type === 'activity') lastActivity.current = Math.max(lastActivity.current, e.data.at);
    };
    return () => ch.close();
  }, []);

  useEffect(() => {
    if (!me) return;
    let lastBroadcast = 0;
    const onAct = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastBroadcast > 30_000) {
        lastBroadcast = Date.now();
        channel.current?.postMessage({ type: 'activity', at: lastActivity.current });
      }
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_MS) void logout('idle');
    }, 15_000);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onAct));
      clearInterval(t);
    };
  }, [me, logout]);

  const login = useCallback(
    async (login: string, password: string) => {
      await staffApi.login('/auth/staff/login', { login, password });
      lastActivity.current = Date.now();
      setIdleNotice(false);
      await loadMe();
    },
    [loadMe],
  );

  return <C.Provider value={{ me, ready, login, logout, idleNotice }}>{children}</C.Provider>;
}

export function homeFor(roles: StaffRole[]) {
  if (roles.includes('organizer')) return '/staff/rooms';
  if (roles.includes('admin')) return '/staff/admin/sessions';
  if (roles.includes('observer')) return '/staff/monitor';
  if (roles.includes('analyst')) return '/staff/analytics';
  return '/staff/login';
}

export function RequireStaff({ roles, children }: { roles?: StaffRole[]; children: ReactNode }) {
  const { me, ready } = useStaff();
  const loc = useLocation();
  if (!ready) return null;
  if (!me) return <Navigate to="/staff/login" replace state={{ from: loc.pathname }} />;
  if (roles && !roles.some((r) => me.roles.includes(r))) return <Navigate to={homeFor(me.roles)} replace />;
  return <>{children}</>;
}
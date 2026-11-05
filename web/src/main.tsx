import { StrictMode, Suspense, lazy, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/onest';
import '@fontsource-variable/golos-text';
import './styles/global.css';
import { ToastProvider, restoreTheme } from './components/ui';
import { StaffSessionProvider, RequireStaff, useStaff, homeFor } from './components/StaffSession';
import { StaffShell } from './components/Shell';
import { startTelemetry } from './lib/telemetry';

// Модули М1 и М6 — отдельные фрагменты сборки: код одного не загружается при работе в другом (ТЗ КЧ 3.2).
const Portal = lazy(() => import('./modules/portal/Portal'));
const ExamApp = lazy(() => import('./modules/exam/ExamApp'));
const ResultsApp = lazy(() => import('./modules/results/ResultsApp'));
const StaffLogin = lazy(() => import('./modules/portal/StaffLogin'));
const RoomsList = lazy(() => import('./modules/room/RoomsList'));
const RoomPage = lazy(() => import('./modules/room/RoomPage'));
const Sessions = lazy(() => import('./modules/admin/Sessions'));
const SessionDetail = lazy(() => import('./modules/admin/SessionDetail'));
const Participants = lazy(() => import('./modules/admin/Participants'));
const StaffUsers = lazy(() => import('./modules/admin/StaffUsers'));
const KimPage = lazy(() => import('./modules/admin/KimPage'));
const Appeals = lazy(() => import('./modules/admin/Appeals'));
const MonitorDashboard = lazy(() => import('./modules/monitor/MonitorDashboard'));
const AuditLog = lazy(() => import('./modules/monitor/AuditLog'));
const Analytics = lazy(() => import('./modules/analytics/Analytics'));

function StaffHome() {
  const { me, ready } = useStaff();
  if (!ready) return null;
  return <Navigate to={me ? homeFor(me.roles) : '/staff/login'} replace />;
}

function Staff() {
  return (
    <StaffSessionProvider>
      <Routes>
        <Route path="login" element={<StaffLogin />} />
        <Route index element={<StaffHome />} />
        <Route
          element={
            <RequireStaff>
              <StaffShell />
            </RequireStaff>
          }
        >
          <Route path="rooms" element={<RequireStaff roles={['organizer']}><RoomsList /></RequireStaff>} />
          <Route path="rooms/:id" element={<RequireStaff roles={['organizer', 'observer', 'admin']}><RoomPage /></RequireStaff>} />
          <Route path="admin/sessions" element={<RequireStaff roles={['admin']}><Sessions /></RequireStaff>} />
          <Route path="admin/sessions/:id" element={<RequireStaff roles={['admin']}><SessionDetail /></RequireStaff>} />
          <Route path="admin/participants" element={<RequireStaff roles={['admin']}><Participants /></RequireStaff>} />
          <Route path="admin/staff" element={<RequireStaff roles={['admin']}><StaffUsers /></RequireStaff>} />
          <Route path="admin/kim" element={<RequireStaff roles={['admin']}><KimPage /></RequireStaff>} />
          <Route path="admin/appeals" element={<RequireStaff roles={['admin']}><Appeals /></RequireStaff>} />
          <Route path="monitor" element={<RequireStaff roles={['observer', 'admin']}><MonitorDashboard /></RequireStaff>} />
          <Route path="monitor/log" element={<RequireStaff roles={['observer', 'admin']}><AuditLog /></RequireStaff>} />
          <Route path="analytics" element={<RequireStaff roles={['analyst', 'admin', 'observer']}><Analytics /></RequireStaff>} />
        </Route>
        <Route path="*" element={<StaffHome />} />
      </Routes>
    </StaffSessionProvider>
  );
}

/**
 * Анимация появления — только на первом маршруте после загрузки документа:
 * при первом переходе класс `anim` снимается, и последующие экраны открываются без «въезда».
 */
function RouteMotion() {
  const loc = useLocation();
  const first = useRef(loc.key);
  useLayoutEffect(() => {
    if (loc.key !== first.current) document.documentElement.classList.remove('anim');
  }, [loc.key]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <RouteMotion />
      <ToastProvider>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/" element={<Portal />} />
            <Route path="/exam" element={<ExamApp />} />
            <Route path="/results/*" element={<ResultsApp />} />
            <Route path="/staff/*" element={<Staff />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  );
}

startTelemetry();
// Контрастная тема, выбранная на портале или в М6, сохраняется между визитами.
// М1 тему не наследует: её задают особые условия участника (ExamApp).
if (!location.pathname.startsWith('/exam')) restoreTheme();
requestAnimationFrame(() => document.documentElement.classList.add('anim'));
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
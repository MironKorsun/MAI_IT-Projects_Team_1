import { StrictMode, Suspense, lazy, useMemo, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/onest';
import '@fontsource-variable/golos-text';
import './styles/global.css';
import { ToastProvider } from './components/ui';
import { StaffSessionProvider, RequireStaff } from './components/StaffSession';
import { StaffShell } from './components/Shell';
import StaffLogin from './modules/portal/StaffLogin';

// import.meta.glob даёт ленивые загрузчики для всех файлов, которые уже существуют: страницы, которых ещё нет, не ломают сборку
const pages = import.meta.glob('./modules/**/*.tsx') as Record<string, () => Promise<{ default: ComponentType }>>;

function Page({ name }: { name: string }) {
  const Comp = useMemo(() => {
    const load = pages[`./modules/${name}.tsx`];
    return load ? lazy(load) : () => <p style={{ padding: 32 }}>Страница {name} ещё не написана.</p>;
  }, [name]);
  return <Comp />;
}

function Staff() {
  return (
    <StaffSessionProvider>
      <Routes>
        <Route path="login" element={<StaffLogin />} />
        <Route element={<RequireStaff><StaffShell /></RequireStaff>}>
            <Route path="admin/sessions" element={<RequireStaff roles={['admin']}><Page name="admin/Sessions" /></RequireStaff>} />
            <Route path="admin/sessions/:id" element={<RequireStaff roles={['admin']}><Page name="admin/SessionDetail" /></RequireStaff>} />
            <Route path="admin/participants" element={<RequireStaff roles={['admin']}><Page name="admin/Participants" /></RequireStaff>} />
            <Route path="admin/staff" element={<RequireStaff roles={['admin']}><Page name="admin/StaffUsers" /></RequireStaff>} />
            <Route path="admin/appeals" element={<RequireStaff roles={['admin']}><Page name="admin/Appeals" /></RequireStaff>} />
        </Route>
        <Route path="*" element={<Navigate to="/staff/login" replace />} />
      </Routes>
    </StaffSessionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/staff/*" element={<Staff />} />
            <Route path="/results/*" element={<Page name="results/ResultsApp" />} />
            <Route path="*" element={<Navigate to="/staff/login" replace />} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
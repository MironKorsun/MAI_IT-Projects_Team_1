import { StrictMode, Suspense, lazy, useMemo, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import '@fontsource-variable/onest';
import '@fontsource-variable/golos-text';
import './styles/global.css';
import { ToastProvider } from './components/ui';

const pages = import.meta.glob('./modules/**/*.tsx') as Record<string, () => Promise<{ default: ComponentType }>>;

function Page({ name }: { name: string }) {
  const Comp = useMemo(() => {
    const load = pages[`./modules/${name}.tsx`];
    return load ? lazy(load) : () => <p style={{ padding: 32 }}>Страница {name} ещё не написана.</p>;
  }, [name]);
  return <Comp />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/exam" element={<Page name="exam/ExamApp" />} />
            <Route path="*" element={<p style={{ padding: 32 }}>Откройте /exam#ws=секрет-рабочего-места</p>} />
          </Routes>
        </Suspense>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
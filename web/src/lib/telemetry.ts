/**
 * Клиентская телеметрия RUM (ТЗ КЧ NFR-40): LCP, CLS, INP (приближённо), необработанные ошибки.
 * Пакеты не чаще 1 раза в 30 с; персональные данные не собираются; доля сеансов задаётся сервером.
 */
const metrics: { name: string; value: number }[] = [];
const errors: { message: string }[] = [];
let sampleRate = 1;
let sampled = true;

function moduleName() {
  const p = location.pathname;
  if (p.startsWith('/exam')) return 'M1';
  if (p.startsWith('/results')) return 'M6';
  if (p.startsWith('/staff/rooms')) return 'M2';
  if (p.startsWith('/staff/admin')) return 'M4';
  if (p.startsWith('/staff/monitor')) return 'M5';
  if (p.startsWith('/staff/analytics')) return 'analytics';
  return 'portal';
}

async function send() {
  if (!sampled || (!metrics.length && !errors.length)) return;
  const body = { module: moduleName(), metrics: metrics.splice(0, 100), errors: errors.splice(0, 20) };
  try {
    const res = await fetch('/api/v1/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
    if (res.ok) {
      const r = (await res.json()) as { sampleRate: number };
      if (r.sampleRate !== sampleRate) {
        sampleRate = r.sampleRate;
        sampled = Math.random() < sampleRate;
      }
    }
  } catch {
    /* телеметрия не влияет на работу */
  }
}

export function startTelemetry() {
  try {
    new PerformanceObserver((l) => {
      const e = l.getEntries().at(-1);
      if (e) metrics.push({ name: 'LCP', value: Math.round(e.startTime) });
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    let cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as PerformanceEventTiming[]) if (e.duration > 40) metrics.push({ name: 'INP', value: Math.round(e.duration) });
    }).observe({ type: 'event', buffered: true, durationThreshold: 40 } as PerformanceObserverInit);
    addEventListener('pagehide', () => {
      metrics.push({ name: 'CLS', value: Math.round(cls * 1000) / 1000 });
      void send();
    });
  } catch {
    /* PerformanceObserver недоступен */
  }
  addEventListener('error', (e) => errors.push({ message: String(e.message).slice(0, 300) }));
  addEventListener('unhandledrejection', (e) => errors.push({ message: String((e.reason as Error)?.message ?? e.reason).slice(0, 300) }));
  setInterval(send, 30_000);
}

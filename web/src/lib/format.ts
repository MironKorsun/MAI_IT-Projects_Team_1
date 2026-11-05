/** Форматы дат и времени по NFR-39: ДД.ММ.ГГГГ, 24-часовой формат, часовой пояс ППЭ. */

export function fmtDate(iso?: string, tz?: string) {
  if (!iso) return '—';
  const d = iso.length === 10 ? new Date(iso + 'T12:00:00Z') : new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz ?? (iso.length === 10 ? 'UTC' : undefined) });
}

export function fmtTime(iso?: string, tz?: string, seconds = false) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined, hour12: false, timeZone: tz });
}

export function fmtDateTime(iso?: string, tz?: string) {
  if (!iso) return '—';
  return `${fmtDate(iso, tz)} ${fmtTime(iso, tz)}`;
}

/** Смещение пояса от UTC для экранов персонала: «UTC+3». */
export function tzOffset(tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
  return (parts.find((p) => p.type === 'timeZoneName')?.value ?? 'UTC').replace('GMT', 'UTC');
}

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function fmtMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} ч${m ? ` ${m} мин` : ''}` : `${m} мин`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function relTime(iso?: string, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  return fmtTime(iso);
}

export const fmtNum = (n: number, d = 0) => n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Процент в едином виде для всего интерфейса: десятичная запятая и неразрывный пробел — «93,1 %». */
export const fmtPct = (n: number, d = 1) => `${fmtNum(n, d)}\u00a0%`;

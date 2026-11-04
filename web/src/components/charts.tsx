import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtPct } from '../lib/format';

/**
 * Лёгкие SVG-графики: одна ось, тонкие метки 12 px, скругление 4 px у конца столбца, всплывающая подсказка.
 * Один ряд — один оттенок; если у столбцов задан порог (highlight), над графиком — легенда из двух меток.
 * Цвета читаются из токенов темы (--series, --series-pass, --series-muted — в т. ч. контрастной),
 * запасные значения — константы ниже. Рост — один раз при появлении, не дольше 600 мс.
 */
export const SERIES = '#677191';
export const SERIES_PASS = '#3f9557';
export const SERIES_MUTED = '#878da0';
const TRACK = 'rgba(27,29,38,.07)';
const GRID = 'rgba(18,28,20,.06)';
const TICK = '#676b79';
const MARKER = '#1b1d26';
const MARKER_LABEL = '#444856';

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const GROW_MS = 600;
const STAGGER_MS = 40;
const NUM: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

interface Palette {
  series: string;
  pass: string;
  muted: string;
  track: string;
  grid: string;
  tick: string;
  marker: string;
  markerLabel: string;
}

function readPalette(): Palette {
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : undefined;
  const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback;
  return {
    series: v('--series', SERIES),
    pass: v('--series-pass', SERIES_PASS),
    muted: v('--series-muted', SERIES_MUTED),
    track: v('--series-track', TRACK),
    grid: v('--chart-grid', GRID),
    tick: v('--faint', TICK),
    marker: v('--ink', MARKER),
    markerLabel: v('--ink-2', MARKER_LABEL),
  };
}

/** Цвета из токенов: читаются при появлении графика и при смене темы (data-theme). */
function usePalette() {
  const [p, setP] = useState(readPalette);
  useEffect(() => {
    const mo = new MutationObserver(() => setP(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return p;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Однократный рост при монтировании. `grown` — показывать итоговые значения,
 * `animating` — пока идёт рост (после него изменения данных применяются без анимации).
 * При prefers-reduced-motion — сразу итог.
 */
function useGrow(extraMs = 0) {
  const [still] = useState(reducedMotion);
  const [grown, setGrown] = useState(still);
  const [animating, setAnimating] = useState(!still);
  const extra = useRef(extraMs);
  useEffect(() => {
    if (still) return;
    const id = requestAnimationFrame(() => setGrown(true));
    const fallback = setTimeout(() => setGrown(true), 120);
    const done = setTimeout(() => setAnimating(false), 200 + GROW_MS + extra.current);
    return () => {
      cancelAnimationFrame(id);
      clearTimeout(fallback);
      clearTimeout(done);
    };
  }, [still]);
  return { grown, animating };
}

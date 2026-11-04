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

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: color, flex: 'none' }} />;
}

export interface Bar {
  label: string;
  value: number;
  tip?: ReactNode;
  /** true — не ниже порога (мятный), false — ниже порога; если задан хотя бы у одного столбца, показывается легенда. */
  highlight?: boolean;
}

export function Columns({ data, height = 220, unit = '', ariaLabel, marker }: { data: Bar[]; height?: number; unit?: string; ariaLabel: string; marker?: { at: number; label: string } }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pal = usePalette();
  const { grown, animating } = useGrow();
  const [hover, setHover] = useState<number>();
  const pad = { l: 34, r: 8, t: 14, b: 28 };
  const max = Math.max(1, ...data.map((d) => d.value));
  const niceMax = Math.ceil(max / 5) * 5 || 5;
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const slot = iw / Math.max(1, data.length);
  const bw = Math.max(4, Math.min(56, slot - 6));
  const ticks = [0, 0.5, 1].map((k) => Math.round(niceMax * k));
  const y = (v: number) => pad.t + ih - (v / niceMax) * ih;
  const legend = data.some((d) => d.highlight !== undefined);
    return (
    <div>
      {legend && (
        <div className="small muted" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Swatch color={pal.pass} />
            не ниже порога
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Swatch color={pal.series} />
            ниже порога
          </span>
        </div>
      )}
            <div ref={ref} style={{ position: 'relative' }}>
        <svg width={width} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(undefined)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke={pal.grid} />
              <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="12" fill={pal.tick} style={NUM}>
                {t}
              </text>
            </g>
          ))}
          {marker && (
            <g>
              <line x1={pad.l + marker.at * slot} x2={pad.l + marker.at * slot} y1={pad.t - 6} y2={pad.t + ih} stroke={pal.marker} strokeDasharray="3 4" strokeOpacity=".35" />
              <text x={pad.l + marker.at * slot + 6} y={pad.t + 4} fontSize="12" fill={pal.markerLabel} style={NUM}>
                {marker.label}
              </text>
            </g>
          )}
                    {data.map((d, i) => {
            const h = grown ? (d.value / niceMax) * ih : 0;
            const x = pad.l + i * slot + (slot - bw) / 2;
            const r = Math.min(4, bw / 2, h);
            const top = pad.t + ih - h;
            return (
              <g key={i} onMouseEnter={() => setHover(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
                <path
                  d={`M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`}
                  fill={d.highlight === true ? pal.pass : pal.series}
                  opacity={hover === undefined || hover === i ? 1 : 0.55}
                  style={{ transition: animating ? `d ${GROW_MS}ms ${EASE}, opacity 140ms` : 'opacity 140ms' }}
                />
                <text x={pad.l + i * slot + slot / 2} y={height - 9} textAnchor="middle" fontSize="12" fill={pal.tick} style={NUM}>
                  {d.label}
                </text>
              </g>
            );
          })}
        </svg>
        {hover !== undefined && data[hover] && (
          <div className="chart-tip" style={{ left: pad.l + hover * slot + slot / 2, top: y(data[hover].value) }}>
            {data[hover].tip ?? (
              <>
                <b>{data[hover].label}</b>: {data[hover].value}
                {unit}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
/** Горизонтальные полосы со значением в процентах (только внутри карточек). */
export function Bars({ rows, max = 100, format = (v) => fmtPct(v) }: { rows: { label: ReactNode; value: number; aside?: ReactNode; tone?: 'muted' | 'normal' }[]; max?: number; format?: (v: number) => string }) {
  const pal = usePalette();
  const { grown, animating } = useGrow(Math.max(0, rows.length - 1) * STAGGER_MS);
  return (
    <div className="stack" style={{ '--gap': '10px' } as CSSProperties}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ '--gap': '12px' } as CSSProperties}>
          <div style={{ width: 150, flex: 'none' }} className="small ink2">
            {r.label}
          </div>
          <div className="grow" title={format(r.value)}>
            <div style={{ height: 10, borderRadius: 999, background: pal.track, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: grown ? `${Math.max(0, Math.min(100, (r.value / max) * 100))}%` : 0,
                  borderRadius: 999,
                  background: r.tone === 'muted' ? pal.muted : pal.series,
                  transition: animating ? `width ${GROW_MS}ms ${EASE} ${i * STAGGER_MS}ms` : 'none',
                }}
              />
            </div>
          </div>
          <div className="small num" style={{ width: 56, textAlign: 'right' }}>
            {format(r.value)}
          </div>
          {r.aside && <div style={{ width: 140 }}>{r.aside}</div>}
        </div>
      ))}
    </div>
  );
}

/** Линия по времени с перекрестием и подсказкой. */
export function Line({ points, height = 120, ariaLabel, format }: { points: { x: string; y: number }[]; height?: number; ariaLabel: string; format?: (p: { x: string; y: number }) => ReactNode }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const pal = usePalette();
  const gid = `lg-area-${useId().replace(/:/g, '')}`;
  const [hover, setHover] = useState<number>();
  const pad = { l: 6, r: 6, t: 10, b: 10 };
  const max = Math.max(1, ...points.map((p) => p.y));
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const X = (i: number) => pad.l + (points.length > 1 ? (i / (points.length - 1)) * iw : iw / 2);
  const Y = (v: number) => pad.t + ih - (v / max) * ih;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
  const area = points.length ? `${d} L${X(points.length - 1)},${pad.t + ih} L${X(0)},${pad.t + ih} Z` : '';
    return (
    <div ref={ref} style={{ position: 'relative' }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        onMouseMove={(e) => {
          if (!points.length) return;
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - pad.l) / iw) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
        onMouseLeave={() => setHover(undefined)}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={pal.series} stopOpacity=".18" />
            <stop offset="1" stopColor={pal.series} stopOpacity="0" />
          </linearGradient>
        </defs>
        {area && <path d={area} fill={`url(#${gid})`} />}
        {d && <path d={d} fill="none" stroke={pal.series} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
        {hover !== undefined && points[hover] && (
          <g>
            <line x1={X(hover)} x2={X(hover)} y1={pad.t} y2={pad.t + ih} stroke="rgba(27,29,38,.18)" />
            <circle cx={X(hover)} cy={Y(points[hover].y)} r="4.5" fill="#fff" stroke={pal.series} strokeWidth="2" />
          </g>
        )}
      </svg>
      {hover !== undefined && points[hover] && (
        <div className="chart-tip" style={{ left: X(hover), top: Y(points[hover].y) }}>
          {format ? format(points[hover]) : `${points[hover].x}: ${points[hover].y}`}
        </div>
      )}
    </div>
  );
}

/** Кольцевой индикатор доли (0…1). */
export function Ring({ value, size = 120, label }: { value: number; size?: number; label: ReactNode }) {
  const pal = usePalette();
  const { grown, animating } = useGrow();
  const k = Math.max(0, Math.min(1, value || 0));
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} role="img" aria-label={`${Math.round(k * 100)} %`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={pal.track} strokeWidth="7" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={pal.pass}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={grown ? c * (1 - k) : c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: animating ? `stroke-dashoffset ${GROW_MS}ms ${EASE}` : 'none' }}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>{label}</div>
    </div>
  );
}
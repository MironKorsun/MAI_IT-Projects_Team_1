import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';

export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const digits = (n: number) => Array.from({ length: n }, () => randomInt(0, 10)).join('');

export function addMinutes(iso: string, min: number) {
  return new Date(new Date(iso).getTime() + min * 60_000).toISOString();
}

/** Простой генератор псевдослучайных чисел для воспроизводимых демонстрационных данных. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Рабочие дни по производственному календарю (упрощённо: суббота и воскресенье — выходные). */
export function addWorkingDays(date: Date, days: number) {
  const d = new Date(date);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

import { describe, expect, it } from 'vitest';
import { filterShortInput, isShortFormatValid } from '../../../shared/format';
import { backoffDelay } from './api';

describe('поле краткого ответа (ТЗ КЧ FR-07)', () => {
  it('недопустимые символы не вводятся', () => {
    expect(filterShortInput('integer', '-1a2-3')).toBe('-123');
    expect(filterShortInput('decimal', '0,2.5x')).toBe('0,25');
    expect(filterShortInput('digits', '3 1 4-1')).toBe('3141');
    expect(filterShortInput('word', 'ёлка 1!')).toBe('ёлка');
  });
  it('типографский минус и тире принимаются как знак «минус»', () => {
    expect(filterShortInput('integer', '−12')).toBe('-12');
    expect(filterShortInput('decimal', '–0,5')).toBe('-0,5');
  });
  it('длина ограничена 50 символами', () => {
    expect(filterShortInput('digits', '1'.repeat(80))).toHaveLength(50);
  });
  it('формат проверяется', () => {
    expect(isShortFormatValid('decimal', '0,25')).toBe(true);
    expect(isShortFormatValid('decimal', ',25')).toBe(false);
  });
});

describe('повторы при перегрузке (ТЗ КЧ NFR-14)', () => {
  it('экспоненциальная задержка 1 с × 2ⁿ с разбросом ±20 % и пределом 30 с', () => {
    for (let n = 0; n < 8; n++) {
      const base = Math.min(1000 * 2 ** n, 30_000);
      for (let i = 0; i < 50; i++) {
        const d = backoffDelay(n);
        expect(d).toBeGreaterThanOrEqual(base * 0.8 - 1);
        expect(d).toBeLessThanOrEqual(base * 1.2 + 1);
      }
    }
  });
  it('соблюдается Retry-After', () => {
    expect(backoffDelay(0, '7')).toBe(7000);
    expect(backoffDelay(0, '120')).toBe(30_000);
  });
});
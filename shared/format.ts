import type { ShortFormat } from './types';

/**
 * Правила ввода краткого ответа (ТЗ КЧ FR-07, NFR-39; ТЗ СЧ ДП-11).
 * Клиент только отфильтровывает недопустимые символы; верность ответа не оценивает.
 */
export const MAX_SHORT_LENGTH = 50;

export const FORMAT_HINT: Record<ShortFormat, string> = {
  integer: 'Целое число, например −12',
  decimal: 'Целое число или десятичная дробь, например: 0,25',
  digits: 'Последовательность цифр без пробелов, например: 3142',
  word: 'Слово без пробелов и знаков препинания',
};

export function filterShortInput(format: ShortFormat, raw: string): string {
  // типографский минус и тире (вставка из справки, D.2) — это знак «минус»
  let v = raw.replace(/\s+/g, '').replace(/[−–]/g, '-');
  switch (format) {
    case 'integer':
      v = v.replace(/[^\d-]/g, '');
      v = v.replace(/(?!^)-/g, '');
      break;
    case 'decimal': {
      v = v.replace(/[^\d.,-]/g, '');
      v = v.replace(/(?!^)-/g, '');
      const idx = v.search(/[.,]/);
      if (idx >= 0) v = v.slice(0, idx + 1) + v.slice(idx + 1).replace(/[.,]/g, '');
      break;
    }
    case 'digits':
      v = v.replace(/\D/g, '');
      break;
    case 'word':
      v = v.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
      break;
  }
  return v.slice(0, MAX_SHORT_LENGTH);
}

export function isShortFormatValid(format: ShortFormat, v: string): boolean {
  if (!v || v.length > MAX_SHORT_LENGTH) return false;
  switch (format) {
    case 'integer':
      return /^-?\d+$/.test(v);
    case 'decimal':
      return /^-?\d+([.,]\d+)?$/.test(v);
    case 'digits':
      return /^\d+$/.test(v);
    case 'word':
      return /^[A-Za-zА-Яа-яЁё]+$/.test(v);
  }
}
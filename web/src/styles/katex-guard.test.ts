import { describe, expect, it } from 'vitest';

/**
 * Стили приложения не должны задевать разметку KaTeX: класс `.overlay` у стрелок \vec однажды получил
 * position: fixed от слоя диалога, и стрелки исчезли из формул на экране задания.
 * Проверяем, что ни один селектор не начинается с имени класса KaTeX (в составе `.badge.accent` — можно).
 */
const KATEX_CLASSES = [
  'overlay', 'accent', 'inner', 'base', 'strut', 'root', 'mord', 'mop', 'mbin', 'mrel', 'mopen', 'mclose', 'mpunct', 'minner',
  'vlist', 'vlist-t', 'vlist-r', 'vlist-s', 'pstrut', 'sizing', 'fontsize-ensurer', 'frac-line', 'sqrt', 'mspace', 'mtable',
  'delimsizing', 'nulldelimiter', 'svg-align', 'stretchy', 'hide-tail', 'accent-body', 'katex-html', 'katex-mathml', 'op-limits',
];

const sheets = import.meta.glob('../**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('стили приложения и KaTeX', () => {
  it('найдены таблицы стилей', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(3);
  });
  for (const [file, css] of Object.entries(sheets)) {
    it(`${file}: нет селекторов по классам KaTeX`, () => {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const re = new RegExp(`(^|[\\s,>+~(}])\\.(${KATEX_CLASSES.join('|')})(?![\\w-])`, 'gm');
      const hits = [...text.matchAll(re)].map((m) => `.${m[2]}`);
      expect(hits).toEqual([]);
    });
  }
});

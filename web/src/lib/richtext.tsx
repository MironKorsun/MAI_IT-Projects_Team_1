import { Fragment, type ReactNode } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/**
 * Отображение текста КИМ (ТЗ КЧ NFR-18): HTML проходит санитайзер по белому списку тегов
 * без атрибутов и превращается в элементы React; формулы $…$ рендерятся KaTeX (trust: false).
 */
const ALLOWED = new Set(['B', 'I', 'EM', 'STRONG', 'SUB', 'SUP', 'BR', 'P', 'UL', 'OL', 'LI', 'SPAN']);
const cache = new Map<string, string>();

export function renderLatex(src: string, display = false): string {
  const key = (display ? 'D' : 'I') + src;
  let html = cache.get(key);
  if (html === undefined) {
    try {
      html = katex.renderToString(src, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
    } catch {
      html = '';
    }
    cache.set(key, html);
  }
  return html;
}

export function Formula({ src, display }: { src: string; display?: boolean }) {
  const html = renderLatex(src, display);
  if (!html) return <code>{src}</code>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Текст с формулами $…$ без HTML. Формула и знак препинания сразу за ней — в одном неразрывном блоке (.nobr),
 * чтобы строка не начиналась с «,» или «.».
 */
export function MathText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\$[^$]+\$[,.;:!?)]*)/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\$([^$]+)\$([,.;:!?)]*)$/.exec(p);
        if (!m) return <Fragment key={i}>{p}</Fragment>;
        if (!m[2]) return <Formula key={i} src={m[1]} />;
        return (
          <span key={i} className="nobr">
            <Formula src={m[1]} />
            {m[2]}
          </span>
        );
      })}
    </>
  );
}

function walk(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return <MathText key={key} text={node.textContent ?? ''} />;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const children = Array.from(el.childNodes).map((c, i) => walk(c, `${key}.${i}`));
  if (!ALLOWED.has(el.tagName)) return <Fragment key={key}>{children}</Fragment>;
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return <br key={key} />;
  const Tag = tag as keyof JSX.IntrinsicElements;
  return <Tag key={key}>{children}</Tag>;
}

export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return <div className={className}>{Array.from(doc.body.childNodes).map((n, i) => walk(n, String(i)))}</div>;
}
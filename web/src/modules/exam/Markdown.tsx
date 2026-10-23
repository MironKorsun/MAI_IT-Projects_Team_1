import { Fragment, type ReactNode } from 'react';

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((t, i) =>
    t.startsWith('**') ? <strong key={i}>{t.slice(2, -2)}</strong> : t.startsWith('`') ? <code key={i} className="mono">{t.slice(1, -1)}</code> : <Fragment key={i}>{t}</Fragment>,
  );
}

export function Markdown({ text, skipTitle }: { text: string; skipTitle?: boolean }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? 'ol' : 'ul';
    out.push(
      <L key={out.length} style={{ paddingLeft: 22, margin: '6px 0 10px', '--gap': '6px' } as React.CSSProperties} className="stack">
        {list.items.map((x, i) => (
          <li key={i}>{inline(x)}</li>
        ))}
      </L>,
    );
    list = null;
  };

  for (const line of text.split('\n')) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*-\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      if (list && list.ordered !== !!ol) flush();
      list ??= { ordered: !!ol, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    flush();
    if (h) {
      if (h[1].length === 1 && skipTitle) continue;
      out.push(
        <div key={out.length} className={h[1].length === 1 ? 'h2' : 'h3'} style={{ margin: '14px 0 4px' }}>
          {h[2]}
        </div>,
      );
    } else if (line.trim()) out.push(<p key={out.length} style={{ margin: '4px 0' }}>{inline(line)}</p>);
  }
  flush();
  return <div>{out}</div>;
}
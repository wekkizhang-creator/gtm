import type { ReactNode } from 'react';

export type TaskNoteInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; text: string; href: string };

export type TaskNoteBlock =
  | { type: 'heading'; level: 1 | 2 | 3; content: TaskNoteInline[] }
  | { type: 'paragraph'; content: TaskNoteInline[] }
  | { type: 'list'; ordered: boolean; items: TaskNoteInline[][] };

const INLINE_PATTERN = /(`[^`\n]+`|\[[^\]\n]+\]\([^) \n]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

export function safeTaskNoteHref(value: string): string | null {
  const href = value.trim();
  if (!href) return null;
  if (href.toLowerCase().startsWith('mailto:')) return href;
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
  } catch {
    return null;
  }
  return null;
}

export function parseTaskNoteInline(text: string): TaskNoteInline[] {
  const tokens: TaskNoteInline[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push({ type: 'text', text: text.slice(lastIndex, index) });
    if (raw.startsWith('`')) {
      tokens.push({ type: 'code', text: raw.slice(1, -1) });
    } else if (raw.startsWith('**')) {
      tokens.push({ type: 'strong', text: raw.slice(2, -2) });
    } else if (raw.startsWith('*')) {
      tokens.push({ type: 'em', text: raw.slice(1, -1) });
    } else {
      const link = raw.match(/^\[([^\]\n]+)\]\(([^) \n]+)\)$/);
      const href = link ? safeTaskNoteHref(link[2]) : null;
      tokens.push(href ? { type: 'link', text: link![1], href } : { type: 'text', text: raw });
    }
    lastIndex = index + raw.length;
  }
  if (lastIndex < text.length) tokens.push({ type: 'text', text: text.slice(lastIndex) });
  return tokens.length ? tokens : [{ type: 'text', text }];
}

export function parseTaskNoteMarkdown(markdown: string): TaskNoteBlock[] {
  const blocks: TaskNoteBlock[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', content: parseTaskNoteInline(text) });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push({ type: 'list', ordered: list.ordered, items: list.items.map(parseTaskNoteInline) });
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushAll();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        content: parseTaskNoteInline(heading[2].trim()),
      });
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (list && list.ordered !== nextOrdered) flushList();
      if (!list) list = { ordered: nextOrdered, items: [] };
      list.items.push((ordered?.[1] ?? unordered?.[1] ?? '').trim());
      continue;
    }
    flushList();
    paragraph.push(line.trimEnd());
  }
  flushAll();
  return blocks;
}

function renderInline(tokens: TaskNoteInline[]): ReactNode {
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === 'code') return <code key={key}>{token.text}</code>;
    if (token.type === 'strong') return <strong key={key}>{token.text}</strong>;
    if (token.type === 'em') return <em key={key}>{token.text}</em>;
    if (token.type === 'link') {
      return (
        <a key={key} href={token.href} target="_blank" rel="noreferrer">
          {token.text}
        </a>
      );
    }
    return <span key={key}>{token.text}</span>;
  });
}

export function TaskNoteMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseTaskNoteMarkdown(markdown);
  if (!blocks.length) return <div className="td-note-preview td-note-preview-empty">暂无备注</div>;
  return (
    <div className="td-note-preview">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = (`h${block.level + 3}` as keyof JSX.IntrinsicElements);
          return <Tag key={`h-${index}`}>{renderInline(block.content)}</Tag>;
        }
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={`l-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`li-${itemIndex}`}>{renderInline(item)}</li>
              ))}
            </Tag>
          );
        }
        return <p key={`p-${index}`}>{renderInline(block.content)}</p>;
      })}
    </div>
  );
}

import { parseTaskNoteInline, parseTaskNoteMarkdown, safeTaskNoteHref } from '../client/src/taskNoteMarkdown';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function tokenTypes(tokens: ReturnType<typeof parseTaskNoteInline>): string {
  return tokens.map((token) => token.type).join('|');
}

async function main() {
  const blocks = parseTaskNoteMarkdown(`# Plan

- Review [PRD](https://example.com/prd)
- Keep \`source\` real

1. Write tests
2. Ship **verified** slice

Plain note with *emphasis* and [unsafe](javascript:alert(1))`);

  assert(blocks.length === 4, `expected four markdown blocks, got ${blocks.length}`);
  assert(blocks[0].type === 'heading' && blocks[0].level === 1, 'heading block missing');
  assert(blocks[1].type === 'list' && !blocks[1].ordered && blocks[1].items.length === 2, 'unordered list block mismatch');
  assert(blocks[2].type === 'list' && blocks[2].ordered && blocks[2].items.length === 2, 'ordered list block mismatch');
  assert(blocks[3].type === 'paragraph', 'paragraph block missing');

  const firstListItem = blocks[1].type === 'list' ? blocks[1].items[0] : [];
  assert(tokenTypes(firstListItem).includes('link'), 'safe markdown link should become a link token');
  const link = firstListItem.find((token) => token.type === 'link');
  assert(link?.type === 'link' && link.href === 'https://example.com/prd', `safe href mismatch: ${link?.type === 'link' ? link.href : ''}`);

  const secondListItem = blocks[1].type === 'list' ? blocks[1].items[1] : [];
  assert(tokenTypes(secondListItem).includes('code'), 'inline code should become a code token');

  const paragraph = blocks[3].type === 'paragraph' ? blocks[3].content : [];
  assert(tokenTypes(paragraph).includes('em'), 'emphasis token missing');
  assert(!tokenTypes(paragraph).includes('link'), 'unsafe javascript link must not render as a link token');
  assert(safeTaskNoteHref('mailto:support@example.com') === 'mailto:support@example.com', 'mailto href should be allowed');
  assert(safeTaskNoteHref('/relative/path') === null, 'relative href should not be allowed in task notes');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

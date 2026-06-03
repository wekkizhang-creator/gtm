import {
  quickAddDraftSummary,
  quickAddSubmitOptions,
  quickAddTokenLabel,
  type QuickAddPreviewState,
} from '../client/src/quickAddPreview';
import type { QuickParseResult } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const parsed: QuickParseResult = {
  tokens: [
    { type: 'date', raw: '明天', value: 'tomorrow' },
    { type: 'time', raw: '下午3点', value: '15:00' },
    { type: 'priority', raw: '!高', value: 3 },
    { type: 'tag', raw: '#工作', value: '工作' },
    { type: 'text', raw: '明天下午3点开会', value: '明天下午3点开会' },
  ],
  draft: {
    title: '明天下午3点开会',
    dueDate: '2030-01-02T15:00:00.000Z',
    startDate: '2030-01-02T15:00:00.000Z',
    isAllDay: false,
    priority: 3,
    estimatedMinutes: null,
    recurrenceRule: null,
    note: null,
    tags: ['工作'],
  },
};

function main() {
  assert(quickAddTokenLabel(parsed.tokens[2]) === '优先级: !高 -> 高', 'priority token label mismatch');
  assert(quickAddTokenLabel(parsed.tokens[3]) === '标签: #工作 -> 工作', 'tag token label mismatch');
  const summary = quickAddDraftSummary(parsed);
  assert(summary.includes('标题: 明天下午3点开会'), 'summary should include parsed title');
  assert(summary.includes('优先级: 高'), 'summary should include parsed priority');
  assert(summary.includes('标签: 工作'), 'summary should include parsed tags');

  const ready: QuickAddPreviewState = { status: 'ready', text: '明天下午3点开会 #工作 !高', result: parsed };
  const readySubmit = quickAddSubmitOptions('明天下午3点开会 #工作 !高', ready);
  assert(readySubmit?.parsed === parsed, 'ready preview should submit parsed result');

  const dismissed: QuickAddPreviewState = { status: 'dismissed', text: '明天下午3点开会 #工作 !高' };
  const rawSubmit = quickAddSubmitOptions('明天下午3点开会 #工作 !高', dismissed);
  assert(rawSubmit?.skipParse === true, 'dismissed preview should skip parsing');

  const staleSubmit = quickAddSubmitOptions('改过的文本', ready);
  assert(!staleSubmit?.parsed && !staleSubmit?.skipParse, 'stale preview should require parsing again');
}

main();

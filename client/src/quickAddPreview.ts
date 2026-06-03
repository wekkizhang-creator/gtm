import type { QuickParseResult, QuickParseToken } from './types';

export interface QuickAddSubmitOptions {
  parsed?: QuickParseResult;
  skipParse?: boolean;
}

export type QuickAddPreviewState =
  | { status: 'idle' }
  | { status: 'loading'; text: string }
  | { status: 'ready'; text: string; result: QuickParseResult }
  | { status: 'dismissed'; text: string }
  | { status: 'error'; text: string; message: string };

const TYPE_LABELS: Record<QuickParseToken['type'], string> = {
  date: '日期',
  time: '时间',
  priority: '优先级',
  tag: '标签',
  estimate: '预计',
  recurrence: '重复',
  url: '链接',
  text: '标题',
};

const PRIORITY_LABELS: Record<number, string> = {
  0: '无',
  1: '低',
  2: '中',
  3: '高',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function quickAddTokenLabel(token: QuickParseToken): string {
  const value =
    token.type === 'priority' && typeof token.value === 'number'
      ? PRIORITY_LABELS[token.value] ?? String(token.value)
      : token.type === 'date' || token.type === 'time'
        ? String(token.value)
        : String(token.value);
  return `${TYPE_LABELS[token.type]}: ${token.raw}${token.raw === value ? '' : ` -> ${value}`}`;
}

export function quickAddDraftSummary(result: QuickParseResult): string[] {
  const out = [`标题: ${result.draft.title}`];
  if (result.draft.startDate) out.push(`时间: ${formatDateTime(result.draft.startDate)}`);
  else if (result.draft.dueDate) out.push(`日期: ${formatDateTime(result.draft.dueDate)}`);
  if (result.draft.priority) out.push(`优先级: ${PRIORITY_LABELS[result.draft.priority] ?? result.draft.priority}`);
  if (result.draft.estimatedMinutes != null) out.push(`预计: ${result.draft.estimatedMinutes} 分钟`);
  if (result.draft.recurrenceRule) out.push(`重复: ${result.draft.recurrenceRule}`);
  if (result.draft.tags.length) out.push(`标签: ${result.draft.tags.join(', ')}`);
  if (result.draft.note) out.push('备注: 已保留链接');
  return out;
}

export function quickAddSubmitOptions(text: string, state: QuickAddPreviewState): QuickAddSubmitOptions | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (state.status === 'ready' && state.text === trimmed) return { parsed: state.result };
  if (state.status === 'dismissed' && state.text === trimmed) return { skipParse: true };
  return {};
}

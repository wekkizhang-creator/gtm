export type ModuleKey = 'tasks' | 'goals' | 'calendar' | 'matrix' | 'focus' | 'habits' | 'countdown' | 'notes';

export const DEFAULT_MODULE_ORDER: ModuleKey[] = ['goals', 'tasks', 'calendar', 'matrix', 'focus', 'habits', 'countdown', 'notes'];

const MODULE_SET = new Set<string>(DEFAULT_MODULE_ORDER);

export function normalizeModuleOrder(order: readonly string[] | null | undefined): ModuleKey[] {
  const out: ModuleKey[] = [];
  const seen = new Set<string>();
  for (const key of order ?? []) {
    if (!MODULE_SET.has(key) || seen.has(key)) continue;
    out.push(key as ModuleKey);
    seen.add(key);
  }
  for (const key of DEFAULT_MODULE_ORDER) {
    if (!seen.has(key)) out.push(key);
  }
  return out;
}

export function reorderModuleOrder(order: readonly string[] | null | undefined, source: ModuleKey, target: ModuleKey): ModuleKey[] {
  const normalized = normalizeModuleOrder(order);
  const from = normalized.indexOf(source);
  const to = normalized.indexOf(target);
  if (from < 0 || to < 0 || from === to) return normalized;
  const [moved] = normalized.splice(from, 1);
  normalized.splice(to, 0, moved);
  return normalized;
}

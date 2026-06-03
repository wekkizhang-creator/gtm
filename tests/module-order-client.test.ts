import { DEFAULT_MODULE_ORDER, normalizeModuleOrder, reorderModuleOrder } from '../client/src/moduleOrder';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(normalizeModuleOrder(null).join('|') === DEFAULT_MODULE_ORDER.join('|'), 'missing order should fall back to defaults');
  assert(
    normalizeModuleOrder(['focus', 'tasks', 'focus', 'unknown']).join('|') === 'focus|tasks|goals|calendar|matrix|habits|countdown|notes',
    'normalization should remove duplicates/unknown keys and append missing modules',
  );

  const moved = reorderModuleOrder(DEFAULT_MODULE_ORDER, 'focus', 'tasks');
  assert(moved.join('|') === 'goals|focus|tasks|calendar|matrix|habits|countdown|notes', `focus should move before tasks, got ${moved.join('|')}`);

  const unchanged = reorderModuleOrder(DEFAULT_MODULE_ORDER, 'tasks', 'tasks');
  assert(unchanged.join('|') === DEFAULT_MODULE_ORDER.join('|'), 'moving a module to itself should be stable');
}

main();

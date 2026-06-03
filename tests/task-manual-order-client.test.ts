import { taskManualOrderUpdates } from '../client/src/taskManualOrder';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const tasks = [
  { id: 'a', sortOrder: 10 },
  { id: 'b', sortOrder: 20 },
  { id: 'c', sortOrder: 30 },
];

function main() {
  const up = taskManualOrderUpdates(tasks, 'b', 'up');
  assert(up.length === 2, 'move up should swap with previous task');
  assert(up[0].id === 'b' && up[0].sortOrder === 10, 'move up should assign previous sortOrder to current task');
  assert(up[1].id === 'a' && up[1].sortOrder === 20, 'move up should assign current sortOrder to previous task');

  const down = taskManualOrderUpdates(tasks, 'b', 'down');
  assert(down.length === 2, 'move down should swap with next task');
  assert(down[0].id === 'b' && down[0].sortOrder === 30, 'move down should assign next sortOrder to current task');
  assert(down[1].id === 'c' && down[1].sortOrder === 20, 'move down should assign current sortOrder to next task');

  const top = taskManualOrderUpdates(tasks, 'c', 'top');
  assert(top.length === 1 && top[0].id === 'c' && top[0].sortOrder === 9, 'pin top should write an order before the current first task');

  assert(taskManualOrderUpdates(tasks, 'a', 'up').length === 0, 'first task cannot move up');
  assert(taskManualOrderUpdates(tasks, 'c', 'down').length === 0, 'last task cannot move down');
  assert(taskManualOrderUpdates(tasks, 'missing', 'top').length === 0, 'missing task should not create updates');
}

main();

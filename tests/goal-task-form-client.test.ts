import { buildGoalTaskCreateInput, buildGoalTaskEditPatch } from '../client/src/goalTaskForm';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const splitInput = buildGoalTaskCreateInput({
  title: '  Build landing page  ',
  parentId: 'parent-task',
  estimatedMinutesText: '180',
  scheduleEnergyType: 'high',
  scheduleTaskType: 'engineering',
  isSplittable: true,
  minScheduleMinutesText: '60',
});

assert(splitInput.title === 'Build landing page', 'title should be trimmed');
assert(splitInput.parentId === 'parent-task', 'parent task id should be preserved');
assert(splitInput.estimatedMinutes === 180, 'estimated minutes should be numeric');
assert(splitInput.scheduleEnergyType === 'high', 'energy type should be preserved');
assert(splitInput.scheduleTaskType === 'engineering', 'task type should be trimmed and preserved');
assert(splitInput.isSplittable === true, 'split toggle should be sent to the API');
assert(splitInput.minScheduleMinutes === 60, 'minimum schedule block should be sent when splitting is enabled');

const unsplitInput = buildGoalTaskCreateInput({
  title: 'Admin follow-up',
  parentId: '',
  estimatedMinutesText: '',
  scheduleEnergyType: '',
  scheduleTaskType: '  ',
  isSplittable: false,
  minScheduleMinutesText: '45',
});

assert(unsplitInput.parentId === null, 'empty parent should be null');
assert(unsplitInput.estimatedMinutes === null, 'empty estimate should be null');
assert(unsplitInput.scheduleEnergyType === null, 'empty energy should be null');
assert(unsplitInput.scheduleTaskType === null, 'blank task type should be null');
assert(unsplitInput.isSplittable === false, 'split toggle should support false');
assert(unsplitInput.minScheduleMinutes === null, 'minimum block should not be sent for unsplittable tasks');

const editPatch = buildGoalTaskEditPatch({
  title: '  Rewrite onboarding copy  ',
  priority: 3,
  dueDateText: '2030-01-12',
  estimatedMinutesText: '75',
  scheduleEnergyType: 'medium',
  scheduleTaskType: 'writing',
  isSplittable: true,
  minScheduleMinutesText: '30',
});

assert(editPatch.title === 'Rewrite onboarding copy', 'edit title should be trimmed');
assert(editPatch.priority === 3, 'edit priority should be preserved');
assert(editPatch.dueDate === new Date(2030, 0, 12, 0, 0, 0, 0).toISOString(), 'edit due date should be converted from date input');
assert(editPatch.isAllDay === true, 'edited due date should remain an all-day deadline');
assert(editPatch.estimatedMinutes === 75, 'edit estimate should be numeric');
assert(editPatch.scheduleEnergyType === 'medium', 'edit energy type should be preserved');
assert(editPatch.scheduleTaskType === 'writing', 'edit task type should be trimmed and preserved');
assert(editPatch.isSplittable === true && editPatch.minScheduleMinutes === 30, 'edit split settings should be sent together');

const unsplitEditPatch = buildGoalTaskEditPatch({
  title: 'QA pass',
  priority: 1,
  dueDateText: '',
  estimatedMinutesText: '',
  scheduleEnergyType: '',
  scheduleTaskType: '',
  isSplittable: false,
  minScheduleMinutesText: '30',
});

assert(unsplitEditPatch.dueDate === null, 'empty edit due date should clear the deadline');
assert(unsplitEditPatch.estimatedMinutes === null, 'empty edit estimate should clear the estimate');
assert(unsplitEditPatch.scheduleEnergyType === null, 'empty edit energy should clear energy type');
assert(unsplitEditPatch.scheduleTaskType === null, 'empty edit type should clear task type');
assert(unsplitEditPatch.minScheduleMinutes === null, 'unsplittable edit should clear minimum schedule block');

console.log('goal-task-form-client: all assertions passed');

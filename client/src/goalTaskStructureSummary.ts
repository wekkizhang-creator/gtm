import type { AITaskStructureResult, AITaskStructureUpdate, Task } from './types';

export interface GoalTaskStructureFieldChange {
  field: 'estimatedMinutes' | 'scheduleEnergyType' | 'scheduleTaskType' | 'isSplittable' | 'minScheduleMinutes' | 'suggestedDueDate';
  label: string;
  value: string;
}

export interface GoalTaskStructureSummaryItem {
  taskId: string;
  title: string;
  reason: string | null;
  changes: GoalTaskStructureFieldChange[];
}

const FIELD_LABELS: Record<GoalTaskStructureFieldChange['field'], string> = {
  estimatedMinutes: '预计耗时',
  scheduleEnergyType: '精力类型',
  scheduleTaskType: '任务类型',
  isSplittable: '可拆分',
  minScheduleMinutes: '最小时间块',
  suggestedDueDate: '建议截止',
};

const ENERGY_LABELS = {
  high: '高精力',
  medium: '中等精力',
  low: '低精力',
} as const;

function formatFieldValue(field: GoalTaskStructureFieldChange['field'], value: AITaskStructureUpdate[typeof field]): string {
  if (value == null || value === '') return '未设置';
  if (field === 'scheduleEnergyType') return ENERGY_LABELS[value as keyof typeof ENERGY_LABELS] ?? String(value);
  if (field === 'isSplittable') return value ? '允许拆分' : '不拆分';
  if (field === 'estimatedMinutes' || field === 'minScheduleMinutes') return `${value} 分钟`;
  if (field === 'suggestedDueDate') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 16);
  }
  return String(value);
}

export function buildGoalTaskStructureSummary(result: AITaskStructureResult): GoalTaskStructureSummaryItem[] {
  const taskById = new Map(result.tasks.map((task) => [task.id, task]));
  const fields: GoalTaskStructureFieldChange['field'][] = [
    'estimatedMinutes',
    'scheduleEnergyType',
    'scheduleTaskType',
    'isSplittable',
    'minScheduleMinutes',
    'suggestedDueDate',
  ];
  return result.updates.map((update) => {
    const task: Task | undefined = taskById.get(update.taskId);
    return {
      taskId: update.taskId,
      title: task?.title ?? update.title,
      reason: update.reason,
      changes: fields.map((field) => ({
        field,
        label: FIELD_LABELS[field],
        value: formatFieldValue(field, update[field]),
      })),
    };
  });
}

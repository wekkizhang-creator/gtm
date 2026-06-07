import { loginCookie } from './auth-test-helper';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolvePromise(typeof addr === 'object' && addr ? addr.port : 0));
    });
    s.on('error', reject);
  });
}

async function startSmtp(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let mode: 'line' | 'data' = 'line';
    let data = '';
    socket.write('220 test.smtp.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (mode === 'data') {
        data += text;
        if (data.includes('\r\n.\r\n')) {
          messages.push(data.slice(0, data.indexOf('\r\n.\r\n')));
          data = '';
          mode = 'line';
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (cmd.startsWith('MAIL FROM')) socket.write('250 sender ok\r\n');
        else if (cmd.startsWith('RCPT TO')) socket.write('250 recipient ok\r\n');
        else if (cmd === 'DATA') {
          mode = 'data';
          socket.write('354 end with dot\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return {
    port,
    messages,
    close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())),
  };
}

async function waitForHealth(base: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    }
  }
  throw new Error('server did not become healthy');
}

function cookiesFrom(res: Response): string {
  const h: any = res.headers as any;
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const joined = all.join(', ');
  const found = joined.match(/el_(?:access|refresh)=[^;,\s]+/g) ?? [];
  assert(found.length >= 2, `expected auth cookies, got ${joined}`);
  return found.join('; ');
}

async function json(res: Response): Promise<any> {
  const body = await res.text();
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`invalid JSON ${res.status}: ${body}`);
  }
}

async function req(base: string, path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ res: Response; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  return { res, body: await json(res) };
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `goals-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'goals-token-secret',
    AUTH_IDENTIFIER_SECRET: 'goals-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'goals-alice@example.com', smtp.messages);
    const start = new Date(Date.now() + 24 * 3600_000);
    start.setHours(9, 0, 0, 0);
    const deadline = new Date(start.getTime() + 4 * 24 * 3600_000);
    deadline.setHours(18, 0, 0, 0);

    const bulkGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Content launch checklist',
        description: 'Coordinate launch content and handoff.',
        deadlineAt: deadline.toISOString(),
        priority: 2,
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
        tasksText: 'Research audience\n\n- Draft outline\n[ ] Publish recap',
      }),
    });
    assert(bulkGoal.res.status === 201, `bulk goal create failed: ${bulkGoal.res.status} ${JSON.stringify(bulkGoal.body)}`);
    assert(bulkGoal.body.goal.title === 'Content launch checklist', 'bulk goal should return the created goal');
    assert(bulkGoal.body.goal.priority === 2, 'bulk goal should persist created priority');
    assert(bulkGoal.body.tasks.length === 3, `expected three initial tasks, got ${bulkGoal.body.tasks.length}`);
    assert(
      bulkGoal.body.tasks.map((task: any) => task.title).join('|') === 'Research audience|Draft outline|Publish recap',
      'bulk goal should trim empty lines and common task bullets',
    );
    const bulkTree = await req(base, `/api/goals/${bulkGoal.body.goal.id}/tree`, { cookie });
    assert(bulkTree.body.tasks.length === 3, `bulk goal tree should expose three created tasks, got ${bulkTree.body.tasks.length}`);
    assert(bulkTree.body.goal.description === 'Coordinate launch content and handoff.', 'goal create should persist the goal description');
    assert(bulkTree.body.goal.priority === 2, 'goal tree should expose created priority');
    const updatedDeadline = new Date(deadline.getTime() + 24 * 3600_000);
    const editedGoal = await req(base, `/api/goals/${bulkGoal.body.goal.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        title: 'Content launch operating plan',
        description: 'Updated positioning and launch operating notes.',
        deadlineAt: updatedDeadline.toISOString(),
        priority: 3,
      }),
    });
    assert(editedGoal.res.status === 200, `goal edit failed: ${editedGoal.res.status} ${JSON.stringify(editedGoal.body)}`);
    assert(editedGoal.body.goal.title === 'Content launch operating plan', 'goal edit should update the title');
    assert(editedGoal.body.goal.description === 'Updated positioning and launch operating notes.', 'goal edit should update the description');
    assert(editedGoal.body.goal.deadlineAt === updatedDeadline.toISOString(), 'goal edit should update the deadline');
    assert(editedGoal.body.goal.priority === 3, 'goal edit should update the priority');
    const goalsAfterEdit = await req(base, '/api/goals', { cookie });
    assert(
      goalsAfterEdit.body.goals.some(
        (goal: any) =>
          goal.id === bulkGoal.body.goal.id &&
          goal.title === 'Content launch operating plan' &&
          goal.description === 'Updated positioning and launch operating notes.' &&
          goal.deadlineAt === updatedDeadline.toISOString() &&
          goal.priority === 3,
      ),
      'goal list should expose edited title, description, deadline and priority',
    );
    const bulkTreeAfterEdit = await req(base, `/api/goals/${bulkGoal.body.goal.id}/tree`, { cookie });
    assert(bulkTreeAfterEdit.body.goal.title === 'Content launch operating plan', 'goal tree should expose edited title');
    assert(bulkTreeAfterEdit.body.goal.description === 'Updated positioning and launch operating notes.', 'goal tree should expose edited description');
    assert(bulkTreeAfterEdit.body.goal.priority === 3, 'goal tree should expose edited priority');
    const [bulkCompletedTask, bulkScheduledTask, bulkOverdueTask] = bulkTreeAfterEdit.body.tasks;
    const bulkScheduleStart = new Date(start.getTime() + 2 * 3600_000).toISOString();
    const bulkScheduleEnd = new Date(start.getTime() + 3 * 3600_000).toISOString();
    const bulkPastDue = new Date(Date.now() - 3600_000).toISOString();
    await req(base, `/api/tasks/${bulkCompletedTask.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ completed: true }),
    });
    await req(base, `/api/tasks/${bulkScheduledTask.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        startDate: bulkScheduleStart,
        dueDate: bulkScheduleEnd,
        plannedStartAt: bulkScheduleStart,
        plannedEndAt: bulkScheduleEnd,
        isAllDay: false,
      }),
    });
    await req(base, `/api/tasks/${bulkOverdueTask.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ dueDate: bulkPastDue, isAllDay: true }),
    });
    const bulkTreeForSummary = await req(base, `/api/goals/${bulkGoal.body.goal.id}/tree`, { cookie });
    const summaryTasks = new Map(bulkTreeForSummary.body.tasks.map((task: any) => [task.id, task]));
    assert((summaryTasks.get(bulkCompletedTask.id) as any).completed === true, 'goal tree should expose completed task state for progress summary');
    assert((summaryTasks.get(bulkScheduledTask.id) as any).plannedStartAt === bulkScheduleStart, 'goal tree should expose scheduled task time blocks');
    assert((summaryTasks.get(bulkOverdueTask.id) as any).dueDate === bulkPastDue, 'goal tree should expose overdue task deadline data');
    const dbAfterBulkGoal = new DatabaseSync(dbPath);
    try {
      const linkedTasks = dbAfterBulkGoal
        .prepare('SELECT COUNT(*) c FROM tasks WHERE goal_id = ? AND deleted_at IS NULL')
        .get(bulkGoal.body.goal.id) as { c: number };
      assert(linkedTasks.c === 3, `expected three DB tasks linked to bulk goal, got ${linkedTasks.c}`);
      const goalRow = dbAfterBulkGoal
        .prepare('SELECT title, description, deadline_at, priority FROM goals WHERE id = ?')
        .get(bulkGoal.body.goal.id) as { title: string; description: string | null; deadline_at: string | null; priority: number };
      assert(goalRow.title === 'Content launch operating plan', 'DB should persist edited goal title');
      assert(goalRow.description === 'Updated positioning and launch operating notes.', 'DB should persist edited goal description');
      assert(goalRow.deadline_at === updatedDeadline.toISOString(), 'DB should persist edited goal deadline');
      assert(goalRow.priority === 3, 'DB should persist edited goal priority');
    } finally {
      dbAfterBulkGoal.close();
    }
    const deleteBulkGoal = await req(base, `/api/goals/${bulkGoal.body.goal.id}`, { method: 'DELETE', cookie });
    assert(deleteBulkGoal.res.status === 204, `delete bulk goal failed: ${deleteBulkGoal.res.status}`);

    const statusGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Status managed plan',
        startAt: start.toISOString(),
        deadlineAt: deadline.toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
      }),
    });
    assert(statusGoal.res.status === 201, `status goal create failed: ${statusGoal.res.status} ${JSON.stringify(statusGoal.body)}`);
    const statusTask = await req(base, `/api/goals/${statusGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Schedulable while active', estimatedMinutes: 30 }),
    });
    assert(statusTask.res.status === 201, `status goal task create failed: ${statusTask.res.status} ${JSON.stringify(statusTask.body)}`);
    const taskStartedAt = new Date(start.getTime() + 30 * 60_000).toISOString();
    const startedTask = await req(base, `/api/tasks/${statusTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'doing', actualStartAt: taskStartedAt, actualEndAt: null }),
    });
    assert(startedTask.res.status === 200, `start goal task failed: ${startedTask.res.status} ${JSON.stringify(startedTask.body)}`);
    assert(startedTask.body.task.status === 'doing' && startedTask.body.task.actualStartAt === taskStartedAt, 'goal task should move to doing with actualStartAt');
    const taskCompletedAt = new Date(start.getTime() + 60 * 60_000).toISOString();
    const completedTask = await req(base, `/api/tasks/${statusTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ completed: true, status: 'done', actualEndAt: taskCompletedAt }),
    });
    assert(completedTask.res.status === 200, `complete goal task failed: ${completedTask.res.status} ${JSON.stringify(completedTask.body)}`);
    assert(completedTask.body.task.completed === true && completedTask.body.task.status === 'done', 'goal task should move to completed');
    assert(completedTask.body.task.completedAt, 'completed goal task should expose completedAt');
    const taskSkippedAt = new Date(start.getTime() + 75 * 60_000).toISOString();
    const skippedTask = await req(base, `/api/tasks/${statusTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'skipped', completed: false, actualEndAt: taskSkippedAt }),
    });
    assert(skippedTask.res.status === 200, `skip goal task failed: ${skippedTask.res.status} ${JSON.stringify(skippedTask.body)}`);
    assert(skippedTask.body.task.status === 'skipped' && skippedTask.body.task.completed === false, 'goal task should move to skipped without counting completed');
    const reopenedTask = await req(base, `/api/tasks/${statusTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'todo', completed: false, actualStartAt: null, actualEndAt: null }),
    });
    assert(reopenedTask.res.status === 200, `reopen goal task failed: ${reopenedTask.res.status} ${JSON.stringify(reopenedTask.body)}`);
    assert(
      reopenedTask.body.task.status === 'todo' &&
        reopenedTask.body.task.completed === false &&
        reopenedTask.body.task.actualStartAt === null &&
        reopenedTask.body.task.actualEndAt === null,
      'goal task should reopen to todo with cleared actual times',
    );
    const dbAfterTaskStatus = new DatabaseSync(dbPath);
    try {
      const statusRow = dbAfterTaskStatus
        .prepare('SELECT status, completed, actual_start_at, actual_end_at, completed_at FROM tasks WHERE id = ?')
        .get(statusTask.body.task.id) as {
        status: string;
        completed: number;
        actual_start_at: string | null;
        actual_end_at: string | null;
        completed_at: string | null;
      };
      assert(
        statusRow.status === 'todo' &&
          statusRow.completed === 0 &&
          statusRow.actual_start_at === null &&
          statusRow.actual_end_at === null &&
          statusRow.completed_at === null,
        'DB should persist reopened goal task status and cleared timestamps',
      );
    } finally {
      dbAfterTaskStatus.close();
    }
    const dependencyPrerequisite = await req(base, `/api/goals/${statusGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Write dependency copy', estimatedMinutes: 30 }),
    });
    const dependencyDependent = await req(base, `/api/goals/${statusGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Design after copy', estimatedMinutes: 30 }),
    });
    assert(
      dependencyPrerequisite.res.status === 201 && dependencyDependent.res.status === 201,
      'dependency UX test tasks should be created',
    );
    const dependencyStatusLink = await req(base, `/api/tasks/${dependencyDependent.body.task.id}/dependencies`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ dependencyId: dependencyPrerequisite.body.task.id }),
    });
    assert(dependencyStatusLink.res.status === 200, `dependency status link failed: ${dependencyStatusLink.res.status} ${JSON.stringify(dependencyStatusLink.body)}`);
    assert(
      dependencyStatusLink.body.task.dependencyTaskIds.includes(dependencyPrerequisite.body.task.id),
      'dependent task should store prerequisite id',
    );
    const dependencyPrerequisiteDone = await req(base, `/api/tasks/${dependencyPrerequisite.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ completed: true, status: 'done' }),
    });
    assert(
      dependencyPrerequisiteDone.res.status === 200 &&
        dependencyPrerequisiteDone.body.task.completed === true &&
        dependencyPrerequisiteDone.body.task.status === 'done',
      'completing prerequisite should persist through the task API',
    );
    const dependencyUnblockedProposal = await req(base, `/api/goals/${statusGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        from: start.toISOString(),
        to: deadline.toISOString(),
        selectedTaskIds: [dependencyDependent.body.task.id],
      }),
    });
    assert(
      dependencyUnblockedProposal.res.status === 201,
      `completed prerequisite should allow dependent proposal: ${dependencyUnblockedProposal.res.status} ${JSON.stringify(dependencyUnblockedProposal.body)}`,
    );
    assert(
      dependencyUnblockedProposal.body.proposal.changes.some((change: any) => change.taskId === dependencyDependent.body.task.id) &&
        !dependencyUnblockedProposal.body.proposal.conflicts.some(
          (conflict: any) => conflict.type === 'dependency_blocked' && conflict.taskId === dependencyDependent.body.task.id,
        ),
      'completed prerequisite should unblock selected dependent task scheduling',
    );
    const pauseGoal = await req(base, `/api/goals/${statusGoal.body.goal.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'paused' }),
    });
    assert(pauseGoal.res.status === 200, `pause goal failed: ${pauseGoal.res.status} ${JSON.stringify(pauseGoal.body)}`);
    assert(pauseGoal.body.goal.status === 'paused', 'goal status should update to paused');
    const pausedDashboard = await req(base, `/api/goals/daypilot-dashboard?date=${encodeURIComponent(start.toISOString())}`, { cookie });
    assert(
      !pausedDashboard.body.dashboard.activeGoals.some((goal: any) => goal.id === statusGoal.body.goal.id),
      'paused goals should not appear in the active DayPilot dashboard',
    );
    const pausedProposal = await req(base, `/api/goals/${statusGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ from: start.toISOString(), to: deadline.toISOString() }),
    });
    assert(pausedProposal.res.status === 409, `paused proposal should be rejected with 409, got ${pausedProposal.res.status}`);
    assert(pausedProposal.body.error.code === 'goal_not_schedulable', 'paused proposal should return goal_not_schedulable');
    const pausedAuto = await req(base, `/api/goals/${statusGoal.body.goal.id}/auto-schedule`, { method: 'POST', cookie });
    assert(pausedAuto.res.status === 409, `paused auto schedule should be rejected with 409, got ${pausedAuto.res.status}`);
    assert(pausedAuto.body.error.code === 'goal_not_schedulable', 'paused auto schedule should return goal_not_schedulable');
    const archiveGoal = await req(base, `/api/goals/${statusGoal.body.goal.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'archived' }),
    });
    assert(archiveGoal.res.status === 200 && archiveGoal.body.goal.status === 'archived', 'goal should update to archived');
    const resumeGoal = await req(base, `/api/goals/${statusGoal.body.goal.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'active' }),
    });
    assert(resumeGoal.res.status === 200 && resumeGoal.body.goal.status === 'active', 'goal should restore to active');
    const activeProposal = await req(base, `/api/goals/${statusGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ from: start.toISOString(), to: deadline.toISOString() }),
    });
    assert(activeProposal.res.status === 201, `active proposal should be allowed after restore: ${activeProposal.res.status} ${JSON.stringify(activeProposal.body)}`);
    const deleteStatusGoal = await req(base, `/api/goals/${statusGoal.body.goal.id}`, { method: 'DELETE', cookie });
    assert(deleteStatusGoal.res.status === 204, `delete status goal failed: ${deleteStatusGoal.res.status}`);
    const statusGoalTreeAfterDelete = await req(base, `/api/goals/${statusGoal.body.goal.id}/tree`, { cookie });
    assert(statusGoalTreeAfterDelete.res.status === 404, 'deleted goal should no longer have a tree');
    const dbAfterStatusDelete = new DatabaseSync(dbPath);
    try {
      const detached = dbAfterStatusDelete.prepare('SELECT goal_id, root_task_id, level FROM tasks WHERE id = ?').get(statusTask.body.task.id) as {
        goal_id: string | null;
        root_task_id: string | null;
        level: number;
      };
      assert(detached.goal_id === null && detached.root_task_id === null && detached.level === 1, 'deleting a goal should detach its tasks without deleting them');
    } finally {
      dbAfterStatusDelete.close();
    }

    const goalRes = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Launch demo',
        startAt: start.toISOString(),
        deadlineAt: deadline.toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
      }),
    });
    assert(goalRes.res.status === 201, `create goal failed: ${goalRes.res.status} ${JSON.stringify(goalRes.body)}`);
    const goalId = goalRes.body.goal.id;

    const parent = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Phase 1', estimatedMinutes: 180 }),
    });
    const read = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Read docs', parentId: parent.body.task.id, estimatedMinutes: 60 }),
    });
    const build = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Build demo', parentId: parent.body.task.id, estimatedMinutes: 90 }),
    });
    const locked = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Locked review', parentId: parent.body.task.id, estimatedMinutes: 30 }),
    });
    assert(read.body.task.level === 2 && build.body.task.level === 2, 'child goal tasks should be level 2');

    const editedTaskDue = new Date(start.getTime() + 24 * 3600_000).toISOString();
    const editedTask = await req(base, `/api/tasks/${locked.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        title: 'Review launch checklist',
        priority: 3,
        dueDate: editedTaskDue,
        isAllDay: true,
        estimatedMinutes: 45,
        scheduleEnergyType: 'medium',
        scheduleTaskType: 'review',
        isSplittable: true,
        minScheduleMinutes: 15,
      }),
    });
    assert(editedTask.res.status === 200, `goal task edit failed: ${editedTask.res.status} ${JSON.stringify(editedTask.body)}`);
    assert(editedTask.body.task.title === 'Review launch checklist', 'goal task edit should update title');
    assert(editedTask.body.task.priority === 3, 'goal task edit should update priority');
    assert(editedTask.body.task.dueDate === editedTaskDue, 'goal task edit should update due date');
    assert(editedTask.body.task.estimatedMinutes === 45, 'goal task edit should update estimate');
    assert(editedTask.body.task.scheduleEnergyType === 'medium', 'goal task edit should update energy type');
    assert(editedTask.body.task.scheduleTaskType === 'review', 'goal task edit should update task type');
    assert(editedTask.body.task.isSplittable === true && editedTask.body.task.minScheduleMinutes === 15, 'goal task edit should update split settings');
    const dbAfterTaskEdit = new DatabaseSync(dbPath);
    try {
      const editedRow = dbAfterTaskEdit
        .prepare('SELECT title, priority, due_date, estimated_minutes, schedule_energy_type, schedule_task_type, is_splittable, min_schedule_minutes FROM tasks WHERE id = ?')
        .get(locked.body.task.id) as {
          title: string;
          priority: number;
          due_date: string | null;
          estimated_minutes: number | null;
          schedule_energy_type: string | null;
          schedule_task_type: string | null;
          is_splittable: number;
          min_schedule_minutes: number | null;
        };
      assert(editedRow.title === 'Review launch checklist', 'DB should persist edited task title');
      assert(editedRow.priority === 3, 'DB should persist edited task priority');
      assert(editedRow.due_date === editedTaskDue, 'DB should persist edited task due date');
      assert(editedRow.estimated_minutes === 45, 'DB should persist edited task estimate');
      assert(editedRow.schedule_energy_type === 'medium', 'DB should persist edited task energy type');
      assert(editedRow.schedule_task_type === 'review', 'DB should persist edited task type');
      assert(editedRow.is_splittable === 1 && editedRow.min_schedule_minutes === 15, 'DB should persist edited split settings');
    } finally {
      dbAfterTaskEdit.close();
    }

    const dep = await req(base, `/api/tasks/${build.body.task.id}/dependencies`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ dependencyId: read.body.task.id }),
    });
    assert(dep.body.task.dependencyTaskIds.includes(read.body.task.id), 'dependency was not stored');
    const depRemoved = await req(base, `/api/tasks/${build.body.task.id}/dependencies/${read.body.task.id}`, {
      method: 'DELETE',
      cookie,
    });
    assert(!depRemoved.body.task.dependencyTaskIds.includes(read.body.task.id), 'dependency was not removed');
    const depRestored = await req(base, `/api/tasks/${build.body.task.id}/dependencies`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ dependencyId: read.body.task.id }),
    });
    assert(depRestored.body.task.dependencyTaskIds.includes(read.body.task.id), 'dependency was not restored after removal');
    const cycleDep = await req(base, `/api/tasks/${read.body.task.id}/dependencies`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ dependencyId: build.body.task.id }),
    });
    assert(cycleDep.res.status === 409, `dependency cycle should be rejected with 409, got ${cycleDep.res.status}`);
    assert(cycleDep.body.error.code === 'dependency_cycle', 'dependency cycle should return dependency_cycle');
    const readAfterCycleAttempt = await req(base, `/api/tasks/${read.body.task.id}`, { cookie });
    assert(
      !readAfterCycleAttempt.body.task.dependencyTaskIds.includes(build.body.task.id),
      'rejected dependency cycle should not be persisted',
    );

    const lockedStart = new Date(start.getTime() + 6 * 3600_000).toISOString();
    const lockedEnd = new Date(start.getTime() + 7 * 3600_000).toISOString();
    await req(base, `/api/tasks/${locked.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ isLockedSchedule: true, startDate: lockedStart, dueDate: lockedEnd, isAllDay: false }),
    });

    const auto = await req(base, `/api/goals/${goalId}/auto-schedule`, { method: 'POST', cookie });
    assert(auto.res.status === 200, `auto schedule failed: ${auto.res.status} ${JSON.stringify(auto.body)}`);
    assert(auto.body.scheduled.length === 2, `expected 2 scheduled leaf tasks, got ${auto.body.scheduled.length}`);
    const scheduledIds = auto.body.scheduled.map((t: any) => t.id);
    assert(scheduledIds.includes(read.body.task.id), 'read task was not scheduled');
    assert(scheduledIds.includes(build.body.task.id), 'build task was not scheduled');
    assert(!scheduledIds.includes(parent.body.task.id), 'parent task should not be auto-scheduled');
    assert(!scheduledIds.includes(locked.body.task.id), 'locked task should not be auto-scheduled');

    const tree = await req(base, `/api/goals/${goalId}/tree`, { cookie });
    const byId = new Map(tree.body.tasks.map((t: any) => [t.id, t]));
    const parentAfter = byId.get(parent.body.task.id) as any;
    const readAfter = byId.get(read.body.task.id) as any;
    const buildAfter = byId.get(build.body.task.id) as any;
    const lockedAfter = byId.get(locked.body.task.id) as any;
    assert(!parentAfter.plannedStartAt, 'parent task should remain unscheduled');
    assert(readAfter.plannedStartAt && readAfter.plannedEndAt, 'read task schedule missing');
    assert(buildAfter.plannedStartAt && buildAfter.plannedEndAt, 'build task schedule missing');
    assert(new Date(readAfter.plannedEndAt) <= new Date(buildAfter.plannedStartAt), 'dependency order was not respected');
    assert(lockedAfter.startDate === lockedStart && lockedAfter.dueDate === lockedEnd, 'locked schedule was overwritten');

    const urgentUnscheduled = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Urgent unscheduled task', estimatedMinutes: 45 }),
    });
    assert(urgentUnscheduled.res.status === 201, `urgent task create failed: ${urgentUnscheduled.res.status}`);
    const urgentDue = new Date(start.getTime() + 8 * 3600_000).toISOString();
    await req(base, `/api/tasks/${urgentUnscheduled.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ dueDate: urgentDue, isAllDay: true, priority: 3 }),
    });
    const impactRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'High energy tasks first',
        type: 'energy_preference',
        status: 'enabled',
        priority: 'preference',
        condition: { energyType: 'high' },
        action: { effect: 'prefer', period: 'morning' },
        scope: {},
      }),
    });
    assert(impactRule.res.status === 201, `dashboard impact rule create failed: ${impactRule.res.status} ${JSON.stringify(impactRule.body)}`);
    const impactProposal = await req(base, `/api/goals/${goalId}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ from: start.toISOString(), to: urgentDue, taskIds: [urgentUnscheduled.body.task.id] }),
    });
    assert(impactProposal.res.status === 201, `dashboard impact proposal failed: ${impactProposal.res.status} ${JSON.stringify(impactProposal.body)}`);
    assert(
      impactProposal.body.proposal.changes.some(
        (change: any) => change.taskId === urgentUnscheduled.body.task.id && change.ruleIds.includes(impactRule.body.rule.id),
      ),
      'dashboard setup proposal should persist a rule-affected change',
    );
    const treeWithScheduleInsights = await req(base, `/api/goals/${goalId}/tree`, { cookie });
    assert(
      treeWithScheduleInsights.body.scheduleInsights.some(
        (insight: any) =>
          insight.taskId === urgentUnscheduled.body.task.id &&
          insight.ruleIds.includes(impactRule.body.rule.id) &&
          insight.rules.some((rule: any) => rule.name === 'High energy tasks first') &&
          typeof insight.explanation === 'string' &&
          insight.explanation.length > 0,
      ),
      'goal tree should expose task-level schedule explanation and related rules from real proposals',
    );
    const blockingRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Today is protected',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { daysOfWeek: [start.getDay()], startTime: '09:00', endTime: '18:00' },
        action: { effect: 'block' },
        scope: {},
      }),
    });
    assert(blockingRule.res.status === 201, `dashboard blocking rule create failed: ${blockingRule.res.status} ${JSON.stringify(blockingRule.body)}`);
    const blockedProposal = await req(base, `/api/goals/${goalId}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ from: start.toISOString(), to: urgentDue }),
    });
    assert(blockedProposal.res.status === 201, `dashboard blocked proposal failed: ${blockedProposal.res.status} ${JSON.stringify(blockedProposal.body)}`);
    assert(
      blockedProposal.body.proposal.conflicts.some((conflict: any) => conflict.ruleIds.includes(blockingRule.body.rule.id)),
      'dashboard setup proposal should persist a rule-linked conflict',
    );
    const dashboard = await req(base, `/api/goals/daypilot-dashboard?date=${encodeURIComponent(start.toISOString())}`, { cookie });
    assert(dashboard.res.status === 200, `daypilot dashboard failed: ${dashboard.res.status} ${JSON.stringify(dashboard.body)}`);
    assert(dashboard.body.dashboard.range.from <= start.toISOString(), 'dashboard range should include the requested date');
    assert(dashboard.body.dashboard.activeGoals.some((goal: any) => goal.id === goalId), 'dashboard should include the active goal');
    assert(
      dashboard.body.dashboard.scheduledTasks.some((task: any) => task.id === read.body.task.id || task.id === build.body.task.id),
      'dashboard should include scheduled goal tasks',
    );
    const blockedScheduledTask = dashboard.body.dashboard.scheduledTasks.find((task: any) => task.id === build.body.task.id);
    assert(blockedScheduledTask, 'dashboard should include the scheduled dependent task');
    assert(
      blockedScheduledTask.dependencyTaskIds.includes(read.body.task.id) &&
        blockedScheduledTask.blockingDependencies.some((dependency: any) => dependency.id === read.body.task.id && dependency.title === 'Read docs'),
      'dashboard should expose unfinished blocking dependencies for scheduled tasks',
    );
    assert(
      dashboard.body.dashboard.risks.some(
        (risk: any) => risk.type === 'dependency_blocked' && risk.taskId === build.body.task.id && risk.message.includes('Read docs'),
      ),
      'dashboard should raise a dependency-blocked risk with the blocking task name',
    );
    assert(
      dashboard.body.dashboard.unscheduledTasks.some((task: any) => task.id === urgentUnscheduled.body.task.id),
      'dashboard should include the urgent unscheduled task',
    );
    assert(
      dashboard.body.dashboard.topTasks.some((task: any) => task.id === urgentUnscheduled.body.task.id),
      'dashboard top tasks should prioritize the urgent unscheduled task',
    );
    assert(
      dashboard.body.dashboard.risks.some((risk: any) => risk.type === 'unscheduled_today' && risk.taskId === urgentUnscheduled.body.task.id),
      'dashboard should expose an unscheduled-today risk',
    );
    const ruleRisk = dashboard.body.dashboard.risks.find(
      (risk: any) => risk.ruleIds.includes(blockingRule.body.rule.id) && risk.rules.some((rule: any) => rule.name === 'Today is protected'),
    );
    assert(ruleRisk, 'dashboard should explain rule-linked risk with the related rule name');
    const ruleImpact = dashboard.body.dashboard.ruleImpacts.find(
      (impact: any) =>
        impact.taskId === urgentUnscheduled.body.task.id &&
        impact.ruleIds.includes(impactRule.body.rule.id) &&
        impact.rules.some((rule: any) => rule.name === 'High energy tasks first'),
    );
    assert(ruleImpact, 'dashboard should expose rule-affected schedule changes with rule names');
    assert(dashboard.body.dashboard.summary.ruleImpactCount >= 1, 'dashboard summary should count rule-affected schedules');

    const bobCookie = await login(base, 'goals-bob@example.com', smtp.messages);
    const bobGoals = await req(base, '/api/goals', { cookie: bobCookie });
    assert(bobGoals.body.goals.length === 0, 'Bob should not see Alice goals');
    const bobTree = await req(base, `/api/goals/${goalId}/tree`, { cookie: bobCookie });
    assert(bobTree.res.status === 404, `expected Bob goal tree read to be 404, got ${bobTree.res.status}`);

    const exportA = await req(base, '/api/settings/export', { cookie });
    assert(exportA.body.goals.length === 1, 'export should include Alice goal');

    const db = new DatabaseSync(dbPath);
    try {
      const goalCount = db.prepare('SELECT COUNT(*) c FROM goals').get() as { c: number };
      const scheduledCount = db
        .prepare('SELECT COUNT(*) c FROM tasks WHERE goal_id = ? AND planned_start_at IS NOT NULL AND is_locked_schedule = 0')
        .get(goalId) as { c: number };
      const parentRows = db.prepare('SELECT COUNT(*) c FROM tasks WHERE id = ? AND planned_start_at IS NULL').get(parent.body.task.id) as { c: number };
      assert(goalCount.c === 1, `expected one goal row, got ${goalCount.c}`);
      assert(scheduledCount.c === 2, `expected two scheduled unlocked leaf tasks, got ${scheduledCount.c}`);
      assert(parentRows.c === 1, 'parent task should not have planned_start_at in DB');
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    for (const suffix of ['', '-shm', '-wal']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

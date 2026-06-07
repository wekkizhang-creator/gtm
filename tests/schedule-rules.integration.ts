import { loginCookie } from './auth-test-helper';
import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const busyIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:schedule-rules-busy@example.com
SUMMARY:Client Sync
DTSTART:20300108T120000Z
DTEND:20300108T133000Z
END:VEVENT
END:VCALENDAR`;
const replanIcs = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:schedule-rules-replan@example.com
SUMMARY:Investor Call
DTSTART:20300111T120000Z
DTEND:20300111T130000Z
END:VEVENT
END:VCALENDAR`;

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

async function nextClockTick(): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
}

async function login(base: string, email: string, smtpMessages: string[]): Promise<string> {
  return loginCookie(base, email, smtpMessages);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `schedule-rules-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'schedule-rules-token-secret',
    AUTH_IDENTIFIER_SECRET: 'schedule-rules-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'schedule-rules-alice@example.com', smtp.messages);
    const start = new Date('2030-01-07T20:30:00+08:00');
    const deadline = new Date('2030-01-09T23:00:00+08:00');

    const goalRes = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Night launch plan',
        startAt: start.toISOString(),
        deadlineAt: deadline.toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(goalRes.res.status === 201, `create goal failed: ${goalRes.res.status} ${JSON.stringify(goalRes.body)}`);
    const goalId = goalRes.body.goal.id;

    const deepTask = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Deep work block',
        estimatedMinutes: 90,
        scheduleEnergyType: 'high',
        scheduleTaskType: 'writing',
      }),
    });
    assert(deepTask.res.status === 201, `create goal task failed: ${deepTask.res.status} ${JSON.stringify(deepTask.body)}`);

    const templateList = await req(base, '/api/schedule-rules/templates', { cookie });
    assert(templateList.res.status === 200, `list rule templates failed: ${templateList.res.status} ${JSON.stringify(templateList.body)}`);
    assert(templateList.body.templates.length >= 4, `expected seeded rule templates, got ${templateList.body.templates.length}`);
    const morningTemplate = templateList.body.templates.find((template: any) => template.id === 'morning-deep-work');
    assert(morningTemplate, 'morning deep-work template should be seeded');
    assert(morningTemplate.status === 'enabled' && morningTemplate.type === 'energy_preference', 'template should expose a creatable rule draft');
    const templateRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify(morningTemplate),
    });
    assert(templateRule.res.status === 201, `create rule from template failed: ${templateRule.res.status} ${JSON.stringify(templateRule.body)}`);
    assert(templateRule.body.rule.name === morningTemplate.name, 'template-created rule should keep the template name');
    assert(templateRule.body.rule.type === 'energy_preference', 'template-created rule should keep the template type');

    const ruleRes = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'No work after 21:30',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { daysOfWeek: [1, 2, 3], startTime: '21:30', endTime: '23:59' },
        action: { effect: 'block' },
        scope: {},
      }),
    });
    assert(ruleRes.res.status === 201, `create rule failed: ${ruleRes.res.status} ${JSON.stringify(ruleRes.body)}`);
    const ruleId = ruleRes.body.rule.id;
    const inactiveTimeRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Sunday-only deep work block',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { daysOfWeek: [0], startTime: '20:00', endTime: '21:00' },
        action: { effect: 'block' },
        scope: { goalIds: [goalId] },
      }),
    });
    assert(inactiveTimeRule.res.status === 201, `create inactive time rule failed: ${inactiveTimeRule.res.status} ${JSON.stringify(inactiveTimeRule.body)}`);
    const rulePatch = await req(base, `/api/schedule-rules/${ruleId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'No work after 21:30', priority: 'hard' }),
    });
    assert(rulePatch.res.status === 200, `patch rule failed: ${rulePatch.res.status} ${JSON.stringify(rulePatch.body)}`);
    assert(rulePatch.body.rule.name === 'No work after 21:30', 'patched rule name should be returned');

    const competingGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Competing high priority plan',
        startAt: start.toISOString(),
        deadlineAt: deadline.toISOString(),
        priority: 3,
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(competingGoal.res.status === 201, `competing goal create failed: ${competingGoal.res.status} ${JSON.stringify(competingGoal.body)}`);
    const planPriorityRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'This week prioritize Night launch plan',
        type: 'plan_priority',
        status: 'enabled',
        priority: 'hard',
        condition: {},
        action: { effect: 'prefer_priority' },
        scope: { goalIds: [goalId] },
      }),
    });
    assert(planPriorityRule.res.status === 201, `create plan priority rule failed: ${planPriorityRule.res.status} ${JSON.stringify(planPriorityRule.body)}`);
    const planPriorityRuleId = planPriorityRule.body.rule.id;
    const priorityDashboard = await req(base, '/api/goals/daypilot-dashboard', { cookie });
    assert(priorityDashboard.res.status === 200, `priority dashboard failed: ${priorityDashboard.res.status} ${JSON.stringify(priorityDashboard.body)}`);
    assert(
      priorityDashboard.body.dashboard.activeGoals[0]?.id === goalId,
      'plan_priority rule should make its scoped plan the first active dashboard goal despite another goal having higher numeric priority',
    );
    const sharedDashboardDue = new Date('2030-01-08T18:00:00+08:00').toISOString();
    const competingDashboardTask = await req(base, `/api/goals/${competingGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Same urgency task in competing plan', priority: 1, estimatedMinutes: 30 }),
    });
    assert(
      competingDashboardTask.res.status === 201,
      `competing dashboard task create failed: ${competingDashboardTask.res.status} ${JSON.stringify(competingDashboardTask.body)}`,
    );
    await req(base, `/api/tasks/${competingDashboardTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ dueDate: sharedDashboardDue, isAllDay: true, autoScheduleEnabled: false }),
    });
    const priorityDashboardTask = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Same urgency task in priority plan', priority: 1, estimatedMinutes: 30 }),
    });
    assert(
      priorityDashboardTask.res.status === 201,
      `priority dashboard task create failed: ${priorityDashboardTask.res.status} ${JSON.stringify(priorityDashboardTask.body)}`,
    );
    await req(base, `/api/tasks/${priorityDashboardTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ dueDate: sharedDashboardDue, isAllDay: true, autoScheduleEnabled: false }),
    });
    const taskPriorityDashboard = await req(base, `/api/goals/daypilot-dashboard?date=${encodeURIComponent(sharedDashboardDue)}`, { cookie });
    assert(taskPriorityDashboard.res.status === 200, `task priority dashboard failed: ${taskPriorityDashboard.res.status} ${JSON.stringify(taskPriorityDashboard.body)}`);
    const topTaskIds = taskPriorityDashboard.body.dashboard.topTasks.map((task: any) => task.id);
    assert(topTaskIds.includes(priorityDashboardTask.body.task.id), 'top tasks should include the task from the plan-priority goal');
    assert(topTaskIds.includes(competingDashboardTask.body.task.id), 'top tasks should include the competing task with the same urgency');
    assert(
      topTaskIds.indexOf(priorityDashboardTask.body.task.id) < topTaskIds.indexOf(competingDashboardTask.body.task.id),
      'plan_priority rule should break same-urgency top-task ties in favor of the scoped plan',
    );

    const reminderRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Start reminders 10 minutes before',
        type: 'reminder',
        status: 'enabled',
        priority: 'normal',
        condition: {},
        action: { effect: 'remind', minutesBefore: 10 },
        scope: {},
      }),
    });
    assert(reminderRule.res.status === 201, `create reminder rule failed: ${reminderRule.res.status} ${JSON.stringify(reminderRule.body)}`);
    const reminderRuleId = reminderRule.body.rule.id;
    const unmatchedEnergyRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Low energy admin window',
        type: 'energy_preference',
        status: 'enabled',
        priority: 'preference',
        condition: { energyType: 'low', startTime: '20:00', endTime: '22:00' },
        action: { effect: 'prefer', period: 'evening' },
        scope: { goalIds: [goalId] },
      }),
    });
    assert(unmatchedEnergyRule.res.status === 201, `create unmatched energy rule failed: ${unmatchedEnergyRule.res.status} ${JSON.stringify(unmatchedEnergyRule.body)}`);
    const unmatchedCategoryRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Meeting blocks at least two hours',
        type: 'task_category',
        status: 'enabled',
        priority: 'normal',
        condition: { taskType: 'meeting' },
        action: { effect: 'min_block', minScheduleMinutes: 120 },
        scope: { goalIds: [goalId] },
      }),
    });
    assert(
      unmatchedCategoryRule.res.status === 201,
      `create unmatched category rule failed: ${unmatchedCategoryRule.res.status} ${JSON.stringify(unmatchedCategoryRule.body)}`,
    );

    const subscription = await req(base, '/api/calendar/subscriptions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Client calendar', type: 'ics', color: '#4a8cf0' }),
    });
    assert(subscription.res.status === 201, `calendar subscription failed: ${subscription.res.status} ${JSON.stringify(subscription.body)}`);
    const sync = await req(base, `/api/calendar/subscriptions/${subscription.body.subscription.id}/sync`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ icsText: busyIcs }),
    });
    assert(sync.res.status === 200, `calendar sync failed: ${sync.res.status} ${JSON.stringify(sync.body)}`);
    assert(sync.body.events.length === 1 && sync.body.events[0].title === 'Client Sync', 'external busy event should sync before scheduling');

    const proposalRes = await req(base, `/api/goals/${goalId}/schedule-proposals`, { method: 'POST', cookie });
    assert(proposalRes.res.status === 201, `proposal failed: ${proposalRes.res.status} ${JSON.stringify(proposalRes.body)}`);
    const proposal = proposalRes.body.proposal;
    assert(proposal.status === 'draft', 'proposal should start as draft');
    assert(proposal.changes.length === 1, `expected one proposal change, got ${proposal.changes.length}`);
    assert(proposal.explanations.length === 1, `expected one explanation, got ${proposal.explanations.length}`);
    assert(proposal.changes[0].ruleIds.includes(ruleId), 'proposal change should reference the blocking rule');
    assert(proposal.changes[0].ruleIds.includes(planPriorityRuleId), 'proposal change should reference the scoped plan priority rule');
    assert(proposal.changes[0].ruleIds.includes(reminderRuleId), 'proposal change should reference the reminder rule');
    assert(
      !proposal.changes[0].ruleIds.includes(inactiveTimeRule.body.rule.id),
      'proposal change should not reference a time-boundary rule that produced no blocks in this proposal range',
    );
    assert(
      !proposal.changes[0].ruleIds.includes(unmatchedEnergyRule.body.rule.id),
      'proposal change should not reference an energy rule whose energy type does not match the task',
    );
    assert(
      !proposal.changes[0].ruleIds.includes(unmatchedCategoryRule.body.rule.id),
      'proposal change should not reference a task-category rule whose task type does not match the task',
    );
    assert(
      proposal.changes[0].avoidedBlocks.some((block: any) => block.source === 'external' && block.title === 'Client Sync'),
      'proposal should explain the avoided external calendar event',
    );
    assert(proposal.explanations[0].message.includes('Client Sync'), 'proposal explanation should mention the external calendar event');
    assert(proposal.explanations[0].changeKey === proposal.changes[0].changeKey, 'proposal explanation should be tied to the concrete time-block change');
    assert(
      proposal.explanations[0].matchedRules.some((rule: any) => rule.id === ruleId && rule.name === 'No work after 21:30'),
      'proposal explanation should expose matched rule metadata',
    );
    assert(
      !proposal.explanations[0].matchedRules.some((rule: any) => rule.id === unmatchedEnergyRule.body.rule.id || rule.id === unmatchedCategoryRule.body.rule.id),
      'proposal explanation should omit unmatched task attribute rules',
    );
    assert(
      !proposal.explanations[0].matchedRules.some((rule: any) => rule.id === inactiveTimeRule.body.rule.id),
      'proposal explanation should omit time-boundary rules that produced no concrete blocks in the proposal range',
    );
    assert(
      proposal.explanations[0].avoidedBlocks.some((block: any) => block.source === 'external' && block.title === 'Client Sync'),
      'proposal explanation should expose avoided calendar blocks',
    );
    assert(Array.isArray(proposal.explanations[0].risks), 'proposal explanation should expose structured risk reasons');
    const plannedStart = new Date(proposal.changes[0].plannedStartAt);
    const plannedEnd = new Date(proposal.changes[0].plannedEndAt);
    assert(
      plannedStart.toISOString() === new Date('2030-01-09T20:00:00+08:00').toISOString(),
      `expected slot after the external event, got ${plannedStart.toISOString()}`,
    );
    assert(plannedEnd.getHours() === 21 && plannedEnd.getMinutes() === 30, `expected to end at 21:30, got ${plannedEnd}`);

    const dbBefore = new DatabaseSync(dbPath);
    try {
      const row = dbBefore.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(deepTask.body.task.id) as
        | { start_date: string | null; due_date: string | null }
        | undefined;
      assert(row && row.start_date === null && row.due_date === null, 'proposal generation should not write task dates');
    } finally {
      dbBefore.close();
    }

    const confirm = await req(base, `/api/schedule-proposals/${proposal.id}/confirm`, { method: 'POST', cookie });
    assert(confirm.res.status === 200, `confirm failed: ${confirm.res.status} ${JSON.stringify(confirm.body)}`);
    assert(confirm.body.proposal.status === 'confirmed', 'proposal should be confirmed');
    assert(confirm.body.tasks.length === 1, 'confirm should return the updated task');
    const expectedReminderAt = new Date(new Date(proposal.changes[0].plannedStartAt).getTime() - 10 * 60_000).toISOString();
    assert(
      confirm.body.tasks[0].reminders.some((reminder: any) => reminder.remindAt === expectedReminderAt && reminder.status === 'scheduled'),
      'confirmed proposal should return the reminder created by the reminder rule',
    );
    assert(
      confirm.body.proposal.changes[0].createdReminderIds.length === 1,
      'confirmed proposal change should retain the created reminder id for undo',
    );
    const latestConfirmed = await req(base, `/api/goals/${goalId}/schedule-proposals/recent-confirmed`, { cookie });
    assert(latestConfirmed.res.status === 200, `latest confirmed proposal failed: ${latestConfirmed.res.status} ${JSON.stringify(latestConfirmed.body)}`);
    assert(latestConfirmed.body.proposal?.id === proposal.id, 'latest confirmed proposal should expose the most recent undoable proposal');

    const dbAfterConfirm = new DatabaseSync(dbPath);
    try {
      const task = dbAfterConfirm
        .prepare('SELECT start_date, due_date, planned_start_at, planned_end_at FROM tasks WHERE id = ?')
        .get(deepTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
        planned_start_at: string | null;
        planned_end_at: string | null;
      };
      const proposalRow = dbAfterConfirm.prepare('SELECT status, confirmed_at FROM schedule_proposals WHERE id = ?').get(proposal.id) as {
        status: string;
        confirmed_at: string | null;
      };
      const reminderRow = dbAfterConfirm.prepare('SELECT task_id, remind_at, status FROM task_reminders WHERE task_id = ?').get(deepTask.body.task.id) as
        | { task_id: string; remind_at: string; status: string }
        | undefined;
      assert(task.start_date === proposal.changes[0].plannedStartAt, 'confirmed proposal should write task start_date');
      assert(task.due_date === proposal.changes[0].plannedEndAt, 'confirmed proposal should write task due_date');
      assert(task.planned_start_at === task.start_date && task.planned_end_at === task.due_date, 'planned and calendar fields should match');
      assert(proposalRow.status === 'confirmed' && proposalRow.confirmed_at, 'proposal row should be confirmed in DB');
      assert(reminderRow?.remind_at === expectedReminderAt && reminderRow.status === 'scheduled', 'reminder rule should persist a scheduled task reminder');
    } finally {
      dbAfterConfirm.close();
    }

    const previewRule = await req(base, '/api/schedule-rules/preview', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Preview no work at 20:00',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { startTime: '20:00', endTime: '21:00' },
        action: { effect: 'block' },
        scope: {},
        goalId,
        from: new Date('2030-01-09T00:00:00+08:00').toISOString(),
        to: new Date('2030-01-10T00:00:00+08:00').toISOString(),
      }),
    });
    assert(previewRule.res.status === 200, `preview rule failed: ${previewRule.res.status} ${JSON.stringify(previewRule.body)}`);
    assert(previewRule.body.preview.summary.blockedSlotCount === 1, 'rule preview should show one future block');
    assert(previewRule.body.preview.summary.affectedTaskCount === 1, 'rule preview should show one affected scheduled task');
    assert(previewRule.body.preview.affectedTasks[0].taskId === deepTask.body.task.id, 'rule preview affected task mismatch');
    const dbAfterPreview = new DatabaseSync(dbPath);
    try {
      const rules = dbAfterPreview.prepare('SELECT COUNT(*) c FROM personal_schedule_rules WHERE user_id IS NOT NULL').get() as { c: number };
      const templates = dbAfterPreview.prepare('SELECT COUNT(*) c FROM schedule_rule_templates').get() as { c: number };
      assert(templates.c >= 4, `seeded rule templates should be persisted in SQLite, got ${templates.c}`);
      assert(rules.c === 7, `rule preview should not persist a draft rule, got ${rules.c} rows`);
    } finally {
      dbAfterPreview.close();
    }

    const confirmAgain = await req(base, `/api/schedule-proposals/${proposal.id}/confirm`, { method: 'POST', cookie });
    assert(confirmAgain.res.status === 409, `second confirm should be 409, got ${confirmAgain.res.status}`);

    const undo = await req(base, `/api/schedule-proposals/${proposal.id}/undo`, { method: 'POST', cookie });
    assert(undo.res.status === 200, `undo failed: ${undo.res.status} ${JSON.stringify(undo.body)}`);
    assert(undo.body.proposal.status === 'undone', 'undo should mark the proposal as undone');
    assert(undo.body.tasks.length === 1, 'undo should return the restored task');
    assert(undo.body.tasks[0].reminders.length === 0, 'undo should remove reminders created by the confirmed proposal');
    const latestAfterUndo = await req(base, `/api/goals/${goalId}/schedule-proposals/recent-confirmed`, { cookie });
    assert(latestAfterUndo.res.status === 200, `latest after undo failed: ${latestAfterUndo.res.status} ${JSON.stringify(latestAfterUndo.body)}`);
    assert(latestAfterUndo.body.proposal === null, 'latest confirmed proposal should disappear after undo');

    const undoAgain = await req(base, `/api/schedule-proposals/${proposal.id}/undo`, { method: 'POST', cookie });
    assert(undoAgain.res.status === 409, `second undo should be 409, got ${undoAgain.res.status}`);

    const autoCompatGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Auto schedule proposal compatibility plan',
        startAt: new Date('2030-01-07T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-07T23:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(autoCompatGoal.res.status === 201, `auto compatibility goal create failed: ${autoCompatGoal.res.status} ${JSON.stringify(autoCompatGoal.body)}`);
    const autoCompatTask = await req(base, `/api/goals/${autoCompatGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Auto route respects rules', estimatedMinutes: 90, scheduleTaskType: 'writing' }),
    });
    assert(autoCompatTask.res.status === 201, `auto compatibility task create failed: ${autoCompatTask.res.status} ${JSON.stringify(autoCompatTask.body)}`);
    const autoCompat = await req(base, `/api/goals/${autoCompatGoal.body.goal.id}/auto-schedule`, { method: 'POST', cookie });
    assert(autoCompat.res.status === 200, `rule-aware auto schedule failed: ${autoCompat.res.status} ${JSON.stringify(autoCompat.body)}`);
    assert(autoCompat.body.scheduled.length === 1, `rule-aware auto schedule should update one task, got ${autoCompat.body.scheduled.length}`);
    assert(autoCompat.body.proposal.status === 'confirmed', 'auto schedule should create and confirm a real schedule proposal');
    assert(
      autoCompat.body.proposal.changes[0].ruleIds.includes(ruleId),
      'auto schedule proposal should carry the active personal rule id',
    );
    assert(
      autoCompat.body.scheduled[0].plannedStartAt === new Date('2030-01-07T20:00:00+08:00').toISOString() &&
        autoCompat.body.scheduled[0].plannedEndAt === new Date('2030-01-07T21:30:00+08:00').toISOString(),
      'auto schedule compatibility route should write the proposal time that respects the time-boundary rule',
    );
    const dbAfterAutoCompat = new DatabaseSync(dbPath);
    try {
      const storedAutoProposal = dbAfterAutoCompat.prepare('SELECT status, confirmed_at, changes_json FROM schedule_proposals WHERE id = ?').get(autoCompat.body.proposal.id) as {
        status: string;
        confirmed_at: string | null;
        changes_json: string;
      };
      const storedAutoTask = dbAfterAutoCompat.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(autoCompatTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(storedAutoProposal.status === 'confirmed' && storedAutoProposal.confirmed_at, 'auto schedule proposal should be confirmed in SQLite');
      assert(JSON.parse(storedAutoProposal.changes_json)[0].ruleIds.includes(ruleId), 'stored auto schedule proposal should keep the rule id');
      assert(storedAutoTask.start_date === autoCompat.body.scheduled[0].startDate, 'auto schedule route should persist task start_date');
      assert(storedAutoTask.due_date === autoCompat.body.scheduled[0].dueDate, 'auto schedule route should persist task due_date');
    } finally {
      dbAfterAutoCompat.close();
    }

    const staleTaskGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Stale task proposal plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T12:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 12 }),
      }),
    });
    assert(staleTaskGoal.res.status === 201, `stale task goal create failed: ${staleTaskGoal.res.status} ${JSON.stringify(staleTaskGoal.body)}`);
    const staleTask = await req(base, `/api/goals/${staleTaskGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Task changes after proposal', estimatedMinutes: 30 }),
    });
    assert(staleTask.res.status === 201, `stale task create failed: ${staleTask.res.status} ${JSON.stringify(staleTask.body)}`);
    const staleTaskProposalRes = await req(base, `/api/goals/${staleTaskGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(
      staleTaskProposalRes.res.status === 201,
      `stale task proposal failed: ${staleTaskProposalRes.res.status} ${JSON.stringify(staleTaskProposalRes.body)}`,
    );
    await nextClockTick();
    const staleTaskPatch = await req(base, `/api/tasks/${staleTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ estimatedMinutes: 45 }),
    });
    assert(staleTaskPatch.res.status === 200, `stale task patch failed: ${staleTaskPatch.res.status} ${JSON.stringify(staleTaskPatch.body)}`);
    const staleTaskConfirm = await req(base, `/api/schedule-proposals/${staleTaskProposalRes.body.proposal.id}/confirm`, { method: 'POST', cookie });
    assert(staleTaskConfirm.res.status === 409, `stale task confirm should be 409, got ${staleTaskConfirm.res.status}`);
    assert(staleTaskConfirm.body.error.code === 'proposal_stale', `stale task confirm should return proposal_stale, got ${staleTaskConfirm.body.error.code}`);
    const dbAfterStaleTask = new DatabaseSync(dbPath);
    try {
      const row = dbAfterStaleTask.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(staleTask.body.task.id) as
        | { start_date: string | null; due_date: string | null }
        | undefined;
      assert(row?.start_date === null && row.due_date === null, 'stale task proposal must not write task dates');
    } finally {
      dbAfterStaleTask.close();
    }

    const staleRuleGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Stale rule proposal plan',
        startAt: new Date('2030-01-10T13:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T16:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 13, endHour: 16 }),
      }),
    });
    assert(staleRuleGoal.res.status === 201, `stale rule goal create failed: ${staleRuleGoal.res.status} ${JSON.stringify(staleRuleGoal.body)}`);
    const staleRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Stale proposal buffer',
        type: 'buffer',
        status: 'enabled',
        priority: 'normal',
        condition: {},
        action: { effect: 'add_buffer', minutes: 15 },
        scope: { goalIds: [staleRuleGoal.body.goal.id] },
      }),
    });
    assert(staleRule.res.status === 201, `stale rule create failed: ${staleRule.res.status} ${JSON.stringify(staleRule.body)}`);
    const staleRuleTask = await req(base, `/api/goals/${staleRuleGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Rule changes after proposal', estimatedMinutes: 30 }),
    });
    assert(staleRuleTask.res.status === 201, `stale rule task create failed: ${staleRuleTask.res.status} ${JSON.stringify(staleRuleTask.body)}`);
    const staleRuleProposalRes = await req(base, `/api/goals/${staleRuleGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(
      staleRuleProposalRes.res.status === 201,
      `stale rule proposal failed: ${staleRuleProposalRes.res.status} ${JSON.stringify(staleRuleProposalRes.body)}`,
    );
    await nextClockTick();
    const staleRulePatch = await req(base, `/api/schedule-rules/${staleRule.body.rule.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ action: { effect: 'add_buffer', minutes: 30 } }),
    });
    assert(staleRulePatch.res.status === 200, `stale rule patch failed: ${staleRulePatch.res.status} ${JSON.stringify(staleRulePatch.body)}`);
    const staleRuleConfirm = await req(base, `/api/schedule-proposals/${staleRuleProposalRes.body.proposal.id}/confirm`, { method: 'POST', cookie });
    assert(staleRuleConfirm.res.status === 409, `stale rule confirm should be 409, got ${staleRuleConfirm.res.status}`);
    assert(staleRuleConfirm.body.error.code === 'proposal_stale', `stale rule confirm should return proposal_stale, got ${staleRuleConfirm.body.error.code}`);
    const dbAfterStaleRule = new DatabaseSync(dbPath);
    try {
      const row = dbAfterStaleRule.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(staleRuleTask.body.task.id) as
        | { start_date: string | null; due_date: string | null }
        | undefined;
      assert(row?.start_date === null && row.due_date === null, 'stale rule proposal must not write task dates');
    } finally {
      dbAfterStaleRule.close();
    }

    const bufferGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Buffer capacity plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T11:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 11 }),
      }),
    });
    assert(bufferGoal.res.status === 201, `buffer goal create failed: ${bufferGoal.res.status} ${JSON.stringify(bufferGoal.body)}`);
    const bufferRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Leave transition buffer',
        type: 'buffer',
        status: 'enabled',
        priority: 'normal',
        condition: {},
        action: { effect: 'add_buffer', minutes: 15 },
        scope: { goalIds: [bufferGoal.body.goal.id] },
      }),
    });
    assert(bufferRule.res.status === 201, `buffer rule create failed: ${bufferRule.res.status} ${JSON.stringify(bufferRule.body)}`);
    const bufferFirst = await req(base, `/api/goals/${bufferGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'First focus block', estimatedMinutes: 60, scheduleEnergyType: 'low' }),
    });
    const bufferSecond = await req(base, `/api/goals/${bufferGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Second focus block', estimatedMinutes: 60, scheduleEnergyType: 'low' }),
    });
    assert(bufferFirst.res.status === 201 && bufferSecond.res.status === 201, 'buffer test tasks should be created');
    const bufferProposalRes = await req(base, `/api/goals/${bufferGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(bufferProposalRes.res.status === 201, `buffer proposal failed: ${bufferProposalRes.res.status} ${JSON.stringify(bufferProposalRes.body)}`);
    const bufferProposal = bufferProposalRes.body.proposal;
    assert(bufferProposal.changes.length === 1, `expected one schedulable buffer change, got ${bufferProposal.changes.length}`);
    assert(bufferProposal.changes[0].taskId === bufferFirst.body.task.id, 'buffer proposal should schedule the first task only');
    assert(bufferProposal.changes[0].ruleIds.includes(bufferRule.body.rule.id), 'buffer proposal change should reference the buffer rule');
    assert(bufferProposal.changes[0].reason.includes('15-minute buffer'), 'buffer proposal reason should mention the active buffer duration');
    assert(bufferProposal.explanations[0].message.includes('15-minute buffer'), 'buffer proposal explanation should mention the active buffer duration');
    const bufferOverflow = bufferProposal.conflicts.find((conflict: any) => conflict.type === 'schedule_overflow' && conflict.taskId === bufferSecond.body.task.id);
    assert(bufferOverflow, 'buffer proposal should record overflow for the second task');
    assert(bufferOverflow.ruleIds.includes(bufferRule.body.rule.id), 'buffer overflow conflict should reference the buffer rule');
    assert(bufferOverflow.message.includes('15 minutes'), 'buffer overflow conflict should explain the buffer capacity impact');
    const dbAfterBufferProposal = new DatabaseSync(dbPath);
    try {
      const bufferProposalRow = dbAfterBufferProposal.prepare('SELECT changes_json, conflicts_json FROM schedule_proposals WHERE id = ?').get(bufferProposal.id) as {
        changes_json: string;
        conflicts_json: string;
      };
      assert(JSON.parse(bufferProposalRow.changes_json)[0].reason.includes('15-minute buffer'), 'stored buffer proposal change should keep buffer reason');
      assert(
        JSON.parse(bufferProposalRow.conflicts_json).some(
          (conflict: any) => conflict.type === 'schedule_overflow' && conflict.message.includes('15 minutes') && conflict.ruleIds.includes(bufferRule.body.rule.id),
        ),
        'stored buffer proposal conflict should keep buffer impact details',
      );
    } finally {
      dbAfterBufferProposal.close();
    }

    const bufferManualGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Manual buffer validation plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T11:30:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 12 }),
      }),
    });
    assert(bufferManualGoal.res.status === 201, `manual buffer goal create failed: ${bufferManualGoal.res.status} ${JSON.stringify(bufferManualGoal.body)}`);
    const bufferManualRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Manual edit transition buffer',
        type: 'buffer',
        status: 'enabled',
        priority: 'normal',
        condition: {},
        action: { effect: 'add_buffer', minutes: 15 },
        scope: { goalIds: [bufferManualGoal.body.goal.id] },
      }),
    });
    assert(bufferManualRule.res.status === 201, `manual buffer rule create failed: ${bufferManualRule.res.status} ${JSON.stringify(bufferManualRule.body)}`);
    const bufferManualFirst = await req(base, `/api/goals/${bufferManualGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Manual buffer first block', estimatedMinutes: 60 }),
    });
    const bufferManualSecond = await req(base, `/api/goals/${bufferManualGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Manual buffer second block', estimatedMinutes: 60 }),
    });
    assert(bufferManualFirst.res.status === 201 && bufferManualSecond.res.status === 201, 'manual buffer tasks should be created');
    const bufferManualProposalRes = await req(base, `/api/goals/${bufferManualGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(
      bufferManualProposalRes.res.status === 201,
      `manual buffer proposal failed: ${bufferManualProposalRes.res.status} ${JSON.stringify(bufferManualProposalRes.body)}`,
    );
    const bufferManualProposal = bufferManualProposalRes.body.proposal;
    assert(bufferManualProposal.changes.length === 2, `expected two manual buffer proposal changes, got ${bufferManualProposal.changes.length}`);
    const bufferManualSecondChange = bufferManualProposal.changes.find((change: any) => change.taskId === bufferManualSecond.body.task.id);
    assert(bufferManualSecondChange, 'manual buffer proposal should include the second task change');
    const bufferTailStart = new Date('2030-01-10T10:00:00+08:00').toISOString();
    const bufferTailEnd = new Date('2030-01-10T11:00:00+08:00').toISOString();
    const bufferManualEdit = await req(base, `/api/schedule-proposals/${bufferManualProposal.id}/changes/${encodeURIComponent(bufferManualSecondChange.changeKey)}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ plannedStartAt: bufferTailStart, plannedEndAt: bufferTailEnd }),
    });
    assert(bufferManualEdit.res.status === 200, `manual buffer edit failed: ${bufferManualEdit.res.status} ${JSON.stringify(bufferManualEdit.body)}`);
    const bufferTailChange = bufferManualEdit.body.proposal.changes.find((change: any) => change.taskId === bufferManualSecond.body.task.id);
    assert(bufferTailChange.conflict === true, 'manual edit inside a buffer tail should mark the change as conflicting');
    assert(bufferTailChange.reason.includes('15-minute buffer'), 'manual edit reason should explain the buffer-tail conflict');
    assert(
      bufferManualEdit.body.proposal.conflicts.some(
        (conflict: any) =>
          conflict.type === 'manual_adjustment_conflict' &&
          conflict.taskId === bufferManualSecond.body.task.id &&
          conflict.message.includes('15-minute buffer'),
      ),
      'manual buffer edit should add a manual_adjustment_conflict that explains the buffer tail',
    );
    const dbAfterBufferManualEdit = new DatabaseSync(dbPath);
    try {
      const row = dbAfterBufferManualEdit.prepare('SELECT changes_json, conflicts_json FROM schedule_proposals WHERE id = ?').get(bufferManualProposal.id) as {
        changes_json: string;
        conflicts_json: string;
      };
      assert(JSON.parse(row.changes_json).some((change: any) => change.reason.includes('15-minute buffer')), 'stored manual buffer change should keep buffer reason');
      assert(JSON.parse(row.conflicts_json).some((conflict: any) => conflict.message.includes('15-minute buffer')), 'stored manual buffer conflict should keep buffer reason');
    } finally {
      dbAfterBufferManualEdit.close();
    }

    const partialGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Partial confirm plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T12:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 12 }),
      }),
    });
    assert(partialGoal.res.status === 201, `partial goal create failed: ${partialGoal.res.status} ${JSON.stringify(partialGoal.body)}`);
    const partialFirst = await req(base, `/api/goals/${partialGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Confirm this slot', estimatedMinutes: 60 }),
    });
    const partialSecond = await req(base, `/api/goals/${partialGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Leave unscheduled', estimatedMinutes: 60 }),
    });
    assert(partialFirst.res.status === 201 && partialSecond.res.status === 201, 'partial confirm tasks should be created');
    const partialProposalRes = await req(base, `/api/goals/${partialGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(partialProposalRes.res.status === 201, `partial proposal failed: ${partialProposalRes.res.status} ${JSON.stringify(partialProposalRes.body)}`);
    const partialProposal = partialProposalRes.body.proposal;
    assert(partialProposal.changes.length === 2, `expected two partial proposal changes, got ${partialProposal.changes.length}`);
    assert(partialProposal.changes.every((change: any) => typeof change.changeKey === 'string' && change.confirmed === false), 'draft changes should expose keys and start unconfirmed');
    let selectedChange = partialProposal.changes.find((change: any) => change.taskId === partialFirst.body.task.id);
    const secondChange = partialProposal.changes.find((change: any) => change.taskId === partialSecond.body.task.id);
    assert(selectedChange, 'partial proposal should contain first task change');
    assert(secondChange, 'partial proposal should contain second task change');
    const overlapEdit = await req(base, `/api/schedule-proposals/${partialProposal.id}/changes/${encodeURIComponent(selectedChange.changeKey)}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        plannedStartAt: secondChange.plannedStartAt,
        plannedEndAt: secondChange.plannedEndAt,
      }),
    });
    assert(overlapEdit.res.status === 200, `manual overlap edit failed: ${overlapEdit.res.status} ${JSON.stringify(overlapEdit.body)}`);
    const conflictedChange = overlapEdit.body.proposal.changes.find((change: any) => change.taskId === partialFirst.body.task.id);
    assert(conflictedChange.conflict === true, 'manual overlap should mark the proposal change as conflicting');
    assert(
      conflictedChange.avoidedBlocks.some((block: any) => block.source === 'scheduled' && block.title === secondChange.title),
      'manual overlap should expose the affected proposal time block',
    );
    const editedExplanation = overlapEdit.body.proposal.explanations.find((explanation: any) => explanation.changeKey === selectedChange.changeKey);
    assert(editedExplanation, 'manual overlap should keep a time-block explanation for the edited change');
    assert(
      editedExplanation.avoidedBlocks.some((block: any) => block.source === 'scheduled' && block.title === secondChange.title),
      'manual overlap explanation should expose the affected proposal time block',
    );
    assert(
      overlapEdit.body.proposal.conflicts.some(
        (conflict: any) =>
          conflict.type === 'manual_adjustment_conflict' &&
          conflict.taskId === partialFirst.body.task.id &&
          conflict.message.includes(secondChange.title) &&
          conflict.suggestions.length > 0,
      ),
      'manual overlap should add a manual_adjustment_conflict with affected task detail and suggestions',
    );
    const dbAfterManualDraft = new DatabaseSync(dbPath);
    try {
      const first = dbAfterManualDraft.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialFirst.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const second = dbAfterManualDraft.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialSecond.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(first.start_date === null && first.due_date === null, 'manual proposal edit should not write first task dates');
      assert(second.start_date === null && second.due_date === null, 'manual proposal edit should not write second task dates');
    } finally {
      dbAfterManualDraft.close();
    }
    const manualStart = new Date('2030-01-10T11:00:00+08:00').toISOString();
    const manualEnd = new Date('2030-01-10T12:00:00+08:00').toISOString();
    const freeEdit = await req(base, `/api/schedule-proposals/${partialProposal.id}/changes/${encodeURIComponent(selectedChange.changeKey)}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        plannedStartAt: manualStart,
        plannedEndAt: manualEnd,
      }),
    });
    assert(freeEdit.res.status === 200, `manual free edit failed: ${freeEdit.res.status} ${JSON.stringify(freeEdit.body)}`);
    selectedChange = freeEdit.body.proposal.changes.find((change: any) => change.taskId === partialFirst.body.task.id);
    assert(selectedChange, 'manual free edit response should keep first task change');
    assert(selectedChange.plannedStartAt === manualStart && selectedChange.plannedEndAt === manualEnd, 'manual edit should persist adjusted proposal dates');
    assert(selectedChange.conflict === false, 'manual free edit should clear the proposal change conflict');
    assert(
      !freeEdit.body.proposal.conflicts.some(
        (conflict: any) => conflict.type === 'manual_adjustment_conflict' && conflict.taskId === partialFirst.body.task.id,
      ),
      'manual free edit should clear prior manual_adjustment_conflict for that task',
    );
    const partialConfirm = await req(base, `/api/schedule-proposals/${partialProposal.id}/confirm`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ changeKeys: [selectedChange.changeKey] }),
    });
    assert(partialConfirm.res.status === 200, `partial confirm failed: ${partialConfirm.res.status} ${JSON.stringify(partialConfirm.body)}`);
    assert(partialConfirm.body.proposal.status === 'confirmed', 'partial proposal should be confirmed');
    assert(
      partialConfirm.body.proposal.changes.filter((change: any) => change.confirmed).length === 1,
      'partial confirm should mark only selected changes confirmed',
    );
    const dbAfterPartialConfirm = new DatabaseSync(dbPath);
    try {
      const first = dbAfterPartialConfirm.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialFirst.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const second = dbAfterPartialConfirm.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialSecond.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const proposalRow = dbAfterPartialConfirm.prepare('SELECT changes_json FROM schedule_proposals WHERE id = ?').get(partialProposal.id) as {
        changes_json: string;
      };
      assert(first.start_date === selectedChange.plannedStartAt && first.due_date === selectedChange.plannedEndAt, 'selected change should write task dates');
      assert(second.start_date === null && second.due_date === null, 'unselected change should not write task dates');
      const storedChanges = JSON.parse(proposalRow.changes_json);
      assert(storedChanges.filter((change: any) => change.confirmed).length === 1, 'stored proposal should keep per-change confirmation state');
    } finally {
      dbAfterPartialConfirm.close();
    }
    const editAfterConfirm = await req(base, `/api/schedule-proposals/${partialProposal.id}/changes/${encodeURIComponent(selectedChange.changeKey)}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        plannedStartAt: selectedChange.plannedStartAt,
        plannedEndAt: selectedChange.plannedEndAt,
      }),
    });
    assert(editAfterConfirm.res.status === 409, 'confirmed proposals should reject manual edits');
    const partialUndo = await req(base, `/api/schedule-proposals/${partialProposal.id}/undo`, { method: 'POST', cookie });
    assert(partialUndo.res.status === 200, `partial undo failed: ${partialUndo.res.status} ${JSON.stringify(partialUndo.body)}`);
    const dbAfterPartialUndo = new DatabaseSync(dbPath);
    try {
      const first = dbAfterPartialUndo.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialFirst.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const second = dbAfterPartialUndo.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(partialSecond.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(first.start_date === null && first.due_date === null, 'partial undo should restore selected task dates');
      assert(second.start_date === null && second.due_date === null, 'partial undo should leave unselected task unchanged');
    } finally {
      dbAfterPartialUndo.close();
    }

    const splitGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Split study plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T12:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 12 }),
      }),
    });
    assert(splitGoal.res.status === 201, `split goal create failed: ${splitGoal.res.status} ${JSON.stringify(splitGoal.body)}`);
    const splitTask = await req(base, `/api/goals/${splitGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Long research task',
        estimatedMinutes: 180,
        isSplittable: true,
        minScheduleMinutes: 60,
        scheduleEnergyType: 'medium',
        scheduleTaskType: 'research',
      }),
    });
    assert(splitTask.res.status === 201, `split task create failed: ${splitTask.res.status} ${JSON.stringify(splitTask.body)}`);
    const splitProposalRes = await req(base, `/api/goals/${splitGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(splitProposalRes.res.status === 201, `split proposal failed: ${splitProposalRes.res.status} ${JSON.stringify(splitProposalRes.body)}`);
    const splitProposal = splitProposalRes.body.proposal;
    assert(splitProposal.changes.length === 3, `expected three split segments, got ${splitProposal.changes.length}`);
    assert(
      splitProposal.changes.every((change: any, index: number) =>
        change.operation === 'create_split_segment' &&
        change.taskId === splitTask.body.task.id &&
        change.segmentIndex === index + 1 &&
        change.segmentTotal === 3 &&
        change.durationMinutes === 60,
      ),
      'split proposal should create three ordered one-hour segment changes',
    );

    const splitConfirm = await req(base, `/api/schedule-proposals/${splitProposal.id}/confirm`, { method: 'POST', cookie });
    assert(splitConfirm.res.status === 200, `split confirm failed: ${splitConfirm.res.status} ${JSON.stringify(splitConfirm.body)}`);
    assert(splitConfirm.body.proposal.status === 'confirmed', 'split proposal should be confirmed');
    assert(
      splitConfirm.body.proposal.changes.every((change: any) => typeof change.createdTaskId === 'string' && change.createdTaskId),
      'confirmed split proposal should store generated child task ids',
    );

    const dbAfterSplitConfirm = new DatabaseSync(dbPath);
    try {
      const parent = dbAfterSplitConfirm
        .prepare('SELECT start_date, due_date, planned_start_at, planned_end_at FROM tasks WHERE id = ?')
        .get(splitTask.body.task.id) as { start_date: string | null; due_date: string | null; planned_start_at: string | null; planned_end_at: string | null };
      const children = dbAfterSplitConfirm
        .prepare(
          `SELECT parent_id, source, estimated_minutes, start_date, due_date, planned_start_at, planned_end_at, deleted_at
           FROM tasks
           WHERE parent_id = ?
           ORDER BY planned_start_at ASC`,
        )
        .all(splitTask.body.task.id) as Array<{
        parent_id: string;
        source: string;
        estimated_minutes: number | null;
        start_date: string | null;
        due_date: string | null;
        planned_start_at: string | null;
        planned_end_at: string | null;
        deleted_at: string | null;
      }>;
      assert(parent.start_date === null && parent.due_date === null, 'split parent should become an unscheduled container');
      assert(parent.planned_start_at === null && parent.planned_end_at === null, 'split parent planned fields should be empty');
      assert(children.length === 3, `expected three generated split child rows, got ${children.length}`);
      assert(children.every((child) => child.source === 'schedule_split' && child.estimated_minutes === 60 && child.deleted_at === null), 'split child rows should be active auto-generated one-hour tasks');
      assert(children.every((child) => child.start_date === child.planned_start_at && child.due_date === child.planned_end_at), 'split child planned and calendar fields should match');
    } finally {
      dbAfterSplitConfirm.close();
    }

    const splitUndo = await req(base, `/api/schedule-proposals/${splitProposal.id}/undo`, { method: 'POST', cookie });
    assert(splitUndo.res.status === 200, `split undo failed: ${splitUndo.res.status} ${JSON.stringify(splitUndo.body)}`);
    assert(splitUndo.body.proposal.status === 'undone', 'split undo should mark proposal undone');

    const dbAfterSplitUndo = new DatabaseSync(dbPath);
    try {
      const activeChildren = dbAfterSplitUndo
        .prepare("SELECT COUNT(*) c FROM tasks WHERE parent_id = ? AND source = 'schedule_split' AND deleted_at IS NULL")
        .get(splitTask.body.task.id) as { c: number };
      const deletedChildren = dbAfterSplitUndo
        .prepare("SELECT COUNT(*) c FROM tasks WHERE parent_id = ? AND source = 'schedule_split' AND deleted_at IS NOT NULL")
        .get(splitTask.body.task.id) as { c: number };
      assert(activeChildren.c === 0, 'split undo should remove active generated segment tasks');
      assert(deletedChildren.c === 3, `split undo should soft-delete three generated segment tasks, got ${deletedChildren.c}`);
    } finally {
      dbAfterSplitUndo.close();
    }

    const invalidCategoryRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Invalid tiny writing block',
        type: 'task_category',
        priority: 'normal',
        condition: { taskType: 'writing' },
        action: { effect: 'min_block', minScheduleMinutes: 10 },
        scope: {},
      }),
    });
    assert(invalidCategoryRule.res.status === 400, `invalid category rule should be 400, got ${invalidCategoryRule.res.status}`);
    assert(
      invalidCategoryRule.body.error.code === 'invalid_schedule_rule',
      `invalid category rule should return invalid_schedule_rule, got ${invalidCategoryRule.body.error.code}`,
    );

    const categoryGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Writing category plan',
        startAt: new Date('2030-01-10T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-10T12:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 12 }),
      }),
    });
    assert(categoryGoal.res.status === 201, `category goal create failed: ${categoryGoal.res.status} ${JSON.stringify(categoryGoal.body)}`);
    const categoryRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Writing blocks at least 90 minutes',
        type: 'task_category',
        priority: 'normal',
        condition: { taskType: 'writing' },
        action: { effect: 'min_block', minScheduleMinutes: 90 },
        scope: { goalIds: [categoryGoal.body.goal.id] },
      }),
    });
    assert(categoryRule.res.status === 201, `category rule create failed: ${categoryRule.res.status} ${JSON.stringify(categoryRule.body)}`);
    const categoryTask = await req(base, `/api/goals/${categoryGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Draft long essay',
        estimatedMinutes: 180,
        isSplittable: true,
        minScheduleMinutes: 30,
        scheduleTaskType: 'writing',
      }),
    });
    assert(categoryTask.res.status === 201, `category task create failed: ${categoryTask.res.status} ${JSON.stringify(categoryTask.body)}`);
    const categoryProposalRes = await req(base, `/api/goals/${categoryGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(
      categoryProposalRes.res.status === 201,
      `category proposal failed: ${categoryProposalRes.res.status} ${JSON.stringify(categoryProposalRes.body)}`,
    );
    const categoryProposal = categoryProposalRes.body.proposal;
    assert(categoryProposal.changes.length === 2, `expected two category-enforced segments, got ${categoryProposal.changes.length}`);
    assert(
      categoryProposal.changes.every(
        (change: any, index: number) =>
          change.operation === 'create_split_segment' &&
          change.segmentIndex === index + 1 &&
          change.segmentTotal === 2 &&
          change.durationMinutes === 90 &&
          change.ruleIds.includes(categoryRule.body.rule.id),
      ),
      'task category rule should force two 90-minute segment changes and mark the matched rule',
    );
    assert(
      categoryProposal.explanations.every(
        (explanation: any) =>
          explanation.matchedRules.some((rule: any) => rule.id === categoryRule.body.rule.id) && explanation.message.includes('90 minutes'),
      ),
      'category proposal explanations should expose the matched rule and the 90-minute block requirement',
    );
    const categoryConfirm = await req(base, `/api/schedule-proposals/${categoryProposal.id}/confirm`, { method: 'POST', cookie });
    assert(categoryConfirm.res.status === 200, `category confirm failed: ${categoryConfirm.res.status} ${JSON.stringify(categoryConfirm.body)}`);
    const dbAfterCategoryConfirm = new DatabaseSync(dbPath);
    try {
      const categoryRuleRow = dbAfterCategoryConfirm.prepare('SELECT action_json FROM personal_schedule_rules WHERE id = ?').get(categoryRule.body.rule.id) as {
        action_json: string;
      };
      const categoryProposalRow = dbAfterCategoryConfirm.prepare('SELECT changes_json, explanations_json FROM schedule_proposals WHERE id = ?').get(categoryProposal.id) as {
        changes_json: string;
        explanations_json: string;
      };
      const categoryChildren = dbAfterCategoryConfirm
        .prepare(
          `SELECT estimated_minutes, source, start_date, due_date
           FROM tasks
           WHERE parent_id = ? AND deleted_at IS NULL
           ORDER BY start_date ASC`,
        )
        .all(categoryTask.body.task.id) as Array<{ estimated_minutes: number | null; source: string; start_date: string | null; due_date: string | null }>;
      const storedCategoryChanges = JSON.parse(categoryProposalRow.changes_json);
      const storedCategoryExplanations = JSON.parse(categoryProposalRow.explanations_json);
      assert(JSON.parse(categoryRuleRow.action_json).minScheduleMinutes === 90, 'category rule min block action should persist in SQLite');
      assert(storedCategoryChanges.every((change: any) => change.durationMinutes === 90), 'stored category proposal changes should keep 90-minute durations');
      assert(
        storedCategoryExplanations.every((explanation: any) => explanation.ruleIds.includes(categoryRule.body.rule.id)),
        'stored category proposal explanations should reference the category rule',
      );
      assert(categoryChildren.length === 2, `expected two category split children, got ${categoryChildren.length}`);
      assert(
        categoryChildren.every((child) => child.source === 'schedule_split' && child.estimated_minutes === 90 && child.start_date && child.due_date),
        'confirmed category split children should be real 90-minute scheduled rows',
      );
    } finally {
      dbAfterCategoryConfirm.close();
    }

    const energyGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Energy preference plan',
        startAt: new Date('2030-01-14T09:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-14T18:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
      }),
    });
    assert(energyGoal.res.status === 201, `energy goal create failed: ${energyGoal.res.status} ${JSON.stringify(energyGoal.body)}`);
    const mediumEnergyRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Medium energy starts after planning',
        type: 'energy_preference',
        priority: 'preference',
        condition: { energyType: 'medium', startTime: '10:00', endTime: '12:00' },
        action: { effect: 'prefer', period: 'morning' },
        scope: { goalIds: [energyGoal.body.goal.id] },
      }),
    });
    assert(mediumEnergyRule.res.status === 201, `medium energy rule create failed: ${mediumEnergyRule.res.status} ${JSON.stringify(mediumEnergyRule.body)}`);
    const laterMediumEnergyRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Medium energy after lunch',
        type: 'energy_preference',
        priority: 'preference',
        condition: { energyType: 'medium', startTime: '14:00', endTime: '16:00' },
        action: { effect: 'prefer', period: 'afternoon' },
        scope: { goalIds: [energyGoal.body.goal.id] },
      }),
    });
    assert(
      laterMediumEnergyRule.res.status === 201,
      `later medium energy rule create failed: ${laterMediumEnergyRule.res.status} ${JSON.stringify(laterMediumEnergyRule.body)}`,
    );
    const invalidEnergyRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Invalid energy window',
        type: 'energy_preference',
        priority: 'preference',
        condition: { energyType: 'medium', startTime: '10:00' },
        action: { effect: 'prefer' },
        scope: { goalIds: [energyGoal.body.goal.id] },
      }),
    });
    assert(invalidEnergyRule.res.status === 400, `invalid energy rule should be 400, got ${invalidEnergyRule.res.status}`);
    assert(
      invalidEnergyRule.body.error.code === 'invalid_schedule_rule',
      `invalid energy rule should return invalid_schedule_rule, got ${invalidEnergyRule.body.error.code}`,
    );
    const energyTask = await req(base, `/api/goals/${energyGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Analyze research notes',
        estimatedMinutes: 60,
        scheduleEnergyType: 'medium',
      }),
    });
    assert(energyTask.res.status === 201, `energy task create failed: ${energyTask.res.status} ${JSON.stringify(energyTask.body)}`);
    const energyProposalRes = await req(base, `/api/goals/${energyGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(energyProposalRes.res.status === 201, `energy proposal failed: ${energyProposalRes.res.status} ${JSON.stringify(energyProposalRes.body)}`);
    const energyProposal = energyProposalRes.body.proposal;
    assert(energyProposal.changes.length === 1, `expected one energy proposal change, got ${energyProposal.changes.length}`);
    assert(
      energyProposal.changes[0].plannedStartAt === new Date('2030-01-14T10:00:00+08:00').toISOString(),
      `energy preference should start inside preferred window, got ${energyProposal.changes[0].plannedStartAt}`,
    );
    assert(
      energyProposal.changes[0].ruleIds.includes(mediumEnergyRule.body.rule.id),
      'energy preference proposal change should reference the matched energy rule',
    );
    assert(
      !energyProposal.changes[0].ruleIds.includes(laterMediumEnergyRule.body.rule.id),
      'energy preference proposal change should not reference a later matching rule when an earlier preferred window was used',
    );
    assert(
      energyProposal.changes[0].reason.includes('preferred energy window') &&
        energyProposal.explanations[0].message.includes('preferred time window') &&
        energyProposal.explanations[0].matchedRules.some((rule: any) => rule.id === mediumEnergyRule.body.rule.id) &&
        !energyProposal.explanations[0].matchedRules.some((rule: any) => rule.id === laterMediumEnergyRule.body.rule.id),
      'energy preference proposal should explain the preferred time-window placement with only the applied rule',
    );
    const energyConfirm = await req(base, `/api/schedule-proposals/${energyProposal.id}/confirm`, { method: 'POST', cookie });
    assert(energyConfirm.res.status === 200, `energy confirm failed: ${energyConfirm.res.status} ${JSON.stringify(energyConfirm.body)}`);
    const dbAfterEnergyConfirm = new DatabaseSync(dbPath);
    try {
      const energyRow = dbAfterEnergyConfirm.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(energyTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const energyProposalRow = dbAfterEnergyConfirm.prepare('SELECT changes_json, explanations_json FROM schedule_proposals WHERE id = ?').get(energyProposal.id) as {
        changes_json: string;
        explanations_json: string;
      };
      assert(energyRow.start_date === energyProposal.changes[0].plannedStartAt, 'energy confirm should write the preferred start time');
      assert(energyRow.due_date === energyProposal.changes[0].plannedEndAt, 'energy confirm should write the preferred end time');
      assert(
        JSON.parse(energyProposalRow.changes_json)[0].ruleIds.includes(mediumEnergyRule.body.rule.id),
        'stored energy proposal change should keep the energy rule id',
      );
      assert(
        !JSON.parse(energyProposalRow.changes_json)[0].ruleIds.includes(laterMediumEnergyRule.body.rule.id),
        'stored energy proposal change should omit matching-but-unused energy rule ids',
      );
      assert(
        JSON.parse(energyProposalRow.explanations_json)[0].message.includes('preferred time window'),
        'stored energy proposal explanation should keep the preference explanation',
      );
    } finally {
      dbAfterEnergyConfirm.close();
    }

    const replanGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Replan launch plan',
        startAt: new Date('2030-01-11T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-11T23:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(replanGoal.res.status === 201, `replan goal create failed: ${replanGoal.res.status} ${JSON.stringify(replanGoal.body)}`);
    const replanFirst = await req(base, `/api/goals/${replanGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Draft investor update', estimatedMinutes: 60, scheduleTaskType: 'writing' }),
    });
    const replanSecond = await req(base, `/api/goals/${replanGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Review launch checklist', estimatedMinutes: 60, scheduleTaskType: 'review' }),
    });
    assert(replanFirst.res.status === 201 && replanSecond.res.status === 201, 'replan tasks should be created');
    const initialReplanProposalRes = await req(base, `/api/goals/${replanGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(initialReplanProposalRes.res.status === 201, `initial replan proposal failed: ${initialReplanProposalRes.res.status}`);
    const initialReplanProposal = initialReplanProposalRes.body.proposal;
    assert(initialReplanProposal.changes.length === 2, `expected two initial replan changes, got ${initialReplanProposal.changes.length}`);
    const initialReplanConfirm = await req(base, `/api/schedule-proposals/${initialReplanProposal.id}/confirm`, { method: 'POST', cookie });
    assert(initialReplanConfirm.res.status === 200, `initial replan confirm failed: ${initialReplanConfirm.res.status} ${JSON.stringify(initialReplanConfirm.body)}`);

    const replanSync = await req(base, `/api/calendar/subscriptions/${subscription.body.subscription.id}/sync`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ icsText: replanIcs }),
    });
    assert(replanSync.res.status === 200, `replan calendar sync failed: ${replanSync.res.status} ${JSON.stringify(replanSync.body)}`);
    assert(replanSync.body.events.some((event: any) => event.title === 'Investor Call'), 'replan external event should sync');

    const replanProposalRes = await req(base, `/api/goals/${replanGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        mode: 'reschedule',
        trigger: 'calendar_sync',
        from: replanGoal.body.goal.startAt,
        to: replanGoal.body.goal.deadlineAt,
      }),
    });
    assert(replanProposalRes.res.status === 201, `replan proposal failed: ${replanProposalRes.res.status} ${JSON.stringify(replanProposalRes.body)}`);
    const replanProposal = replanProposalRes.body.proposal;
    assert(replanProposal.changes.length === 1, `expected one impacted reschedule change, got ${replanProposal.changes.length}`);
    assert(replanProposal.changes[0].taskId === replanFirst.body.task.id, 'reschedule should only move the task impacted by the new external event');
    assert(
      replanProposal.conflicts.some(
        (conflict: any) => conflict.type === 'reschedule_impact' && conflict.taskId === replanFirst.body.task.id && conflict.message.includes('Investor Call'),
      ),
      'reschedule proposal should explain the impacted task and external event',
    );
    assert(
      replanProposal.changes[0].plannedStartAt === new Date('2030-01-11T22:00:00+08:00').toISOString(),
      `impacted task should move after the external event and preserved second task, got ${replanProposal.changes[0].plannedStartAt}`,
    );
    assert(
      replanProposal.changes[0].oldPlannedStartAt === new Date('2030-01-11T20:00:00+08:00').toISOString(),
      `reschedule proposal should expose the original start time, got ${replanProposal.changes[0].oldPlannedStartAt}`,
    );
    assert(
      replanProposal.changes[0].oldPlannedEndAt === new Date('2030-01-11T21:00:00+08:00').toISOString(),
      `reschedule proposal should expose the original end time, got ${replanProposal.changes[0].oldPlannedEndAt}`,
    );

    const replanConfirm = await req(base, `/api/schedule-proposals/${replanProposal.id}/confirm`, { method: 'POST', cookie });
    assert(replanConfirm.res.status === 200, `replan confirm failed: ${replanConfirm.res.status} ${JSON.stringify(replanConfirm.body)}`);
    const dbAfterReplan = new DatabaseSync(dbPath);
    try {
      const first = dbAfterReplan.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(replanFirst.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const second = dbAfterReplan.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(replanSecond.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(first.start_date === new Date('2030-01-11T22:00:00+08:00').toISOString(), 'replan confirm should move impacted task to 22:00');
      assert(second.start_date === new Date('2030-01-11T21:00:00+08:00').toISOString(), 'replan should preserve unaffected same-goal task at 21:00');
    } finally {
      dbAfterReplan.close();
    }

    const replanUndo = await req(base, `/api/schedule-proposals/${replanProposal.id}/undo`, { method: 'POST', cookie });
    assert(replanUndo.res.status === 200, `replan undo failed: ${replanUndo.res.status} ${JSON.stringify(replanUndo.body)}`);
    const dbAfterReplanUndo = new DatabaseSync(dbPath);
    try {
      const first = dbAfterReplanUndo.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(replanFirst.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(first.start_date === new Date('2030-01-11T20:00:00+08:00').toISOString(), 'replan undo should restore impacted task to original time');
    } finally {
      dbAfterReplanUndo.close();
    }

    const dependencyGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Dependency aware plan',
        startAt: new Date('2030-01-13T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-13T23:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(dependencyGoal.res.status === 201, `dependency goal create failed: ${dependencyGoal.res.status} ${JSON.stringify(dependencyGoal.body)}`);
    const prerequisiteTask = await req(base, `/api/goals/${dependencyGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Write launch copy', estimatedMinutes: 45, scheduleTaskType: 'writing' }),
    });
    const dependentTask = await req(base, `/api/goals/${dependencyGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Design launch cover', estimatedMinutes: 45, scheduleTaskType: 'design' }),
    });
    assert(prerequisiteTask.res.status === 201 && dependentTask.res.status === 201, 'dependency tasks should be created');
    const dependencyLink = await req(base, `/api/tasks/${dependentTask.body.task.id}/dependencies`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ dependencyId: prerequisiteTask.body.task.id }),
    });
    assert(dependencyLink.res.status === 200, `dependency link failed: ${dependencyLink.res.status} ${JSON.stringify(dependencyLink.body)}`);

    const dependencyBlockedProposalRes = await req(base, `/api/goals/${dependencyGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        taskIds: [dependentTask.body.task.id],
        from: dependencyGoal.body.goal.startAt,
        to: dependencyGoal.body.goal.deadlineAt,
      }),
    });
    assert(
      dependencyBlockedProposalRes.res.status === 201,
      `dependency blocked proposal failed: ${dependencyBlockedProposalRes.res.status} ${JSON.stringify(dependencyBlockedProposalRes.body)}`,
    );
    assert(
      !dependencyBlockedProposalRes.body.proposal.changes.some((change: any) => change.taskId === dependentTask.body.task.id),
      'dependent task should not be scheduled when its prerequisite is not included or completed',
    );
    assert(
      dependencyBlockedProposalRes.body.proposal.conflicts.some(
        (conflict: any) =>
          conflict.type === 'dependency_blocked' &&
          conflict.severity === 'blocking' &&
          conflict.taskId === dependentTask.body.task.id &&
          conflict.message.includes('Write launch copy'),
      ),
      'proposal should explain the unfinished prerequisite that blocked scheduling',
    );
    const dbAfterDependencyBlocked = new DatabaseSync(dbPath);
    try {
      const dependentRow = dbAfterDependencyBlocked.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(dependentTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      assert(dependentRow.start_date === null && dependentRow.due_date === null, 'blocked dependency proposal must not schedule the dependent task');
    } finally {
      dbAfterDependencyBlocked.close();
    }

    const dependencyOrderedProposalRes = await req(base, `/api/goals/${dependencyGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        taskIds: [dependentTask.body.task.id, prerequisiteTask.body.task.id],
        from: dependencyGoal.body.goal.startAt,
        to: dependencyGoal.body.goal.deadlineAt,
      }),
    });
    assert(
      dependencyOrderedProposalRes.res.status === 201,
      `dependency ordered proposal failed: ${dependencyOrderedProposalRes.res.status} ${JSON.stringify(dependencyOrderedProposalRes.body)}`,
    );
    const dependencyChanges = dependencyOrderedProposalRes.body.proposal.changes;
    const prerequisiteIndex = dependencyChanges.findIndex((change: any) => change.taskId === prerequisiteTask.body.task.id);
    const dependentIndex = dependencyChanges.findIndex((change: any) => change.taskId === dependentTask.body.task.id);
    assert(prerequisiteIndex >= 0 && dependentIndex >= 0, 'proposal should schedule both prerequisite and dependent tasks when both are selected');
    assert(prerequisiteIndex < dependentIndex, 'proposal should schedule the prerequisite before the dependent task');
    assert(
      new Date(dependencyChanges[prerequisiteIndex].plannedEndAt) <= new Date(dependencyChanges[dependentIndex].plannedStartAt),
      'dependent task should start only after the prerequisite time block ends',
    );
    assert(
      !dependencyOrderedProposalRes.body.proposal.conflicts.some((conflict: any) => conflict.type === 'dependency_blocked' && conflict.taskId === dependentTask.body.task.id),
      'proposal should not report dependency_blocked when the prerequisite is scheduled first',
    );

    const overflowGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Overflow plan',
        startAt: new Date('2030-01-07T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-07T23:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 23 }),
      }),
    });
    assert(overflowGoal.res.status === 201, `overflow goal create failed: ${overflowGoal.res.status} ${JSON.stringify(overflowGoal.body)}`);
    const overflowTask = await req(base, `/api/goals/${overflowGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Impossible long task', estimatedMinutes: 120 }),
    });
    assert(overflowTask.res.status === 201, `overflow task create failed: ${overflowTask.res.status} ${JSON.stringify(overflowTask.body)}`);
    const overflowProposalRes = await req(base, `/api/goals/${overflowGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(overflowProposalRes.res.status === 201, `overflow proposal failed: ${overflowProposalRes.res.status} ${JSON.stringify(overflowProposalRes.body)}`);
    assert(
      overflowProposalRes.body.proposal.conflicts.some((conflict: any) => conflict.type === 'schedule_overflow' && conflict.ruleIds.includes(ruleId)),
      'overflow proposal should record a rule-linked schedule_overflow conflict',
    );

    const ruleConflicts = await req(base, '/api/schedule-rules/conflicts', { cookie });
    assert(ruleConflicts.res.status === 200, `rule conflicts failed: ${ruleConflicts.res.status} ${JSON.stringify(ruleConflicts.body)}`);
    assert(ruleConflicts.body.summary.total >= 1, 'rule conflicts should include at least one real proposal conflict');
    assert(ruleConflicts.body.summary.blocking >= 1, 'rule conflicts should count blocking conflicts');
    const overflowConflict = ruleConflicts.body.conflicts.find((conflict: any) => conflict.type === 'schedule_overflow');
    assert(overflowConflict, 'rule conflict list should include the overflow conflict');
    assert(overflowConflict.taskTitle === 'Impossible long task', 'rule conflict list should include the affected task title');
    assert(overflowConflict.ruleIds.includes(ruleId), 'rule conflict list should include the referenced rule id');
    assert(
      overflowConflict.rules.some((rule: any) => rule.id === ruleId && rule.name === 'No work after 21:30'),
      'rule conflict list should include referenced rule metadata',
    );
    assert(
      overflowConflict.suggestions.some((suggestion: string) => suggestion.includes('deadline')),
      'rule conflict list should expose proposal suggestions',
    );
    const conflictReplan = await req(base, `/api/goals/${overflowConflict.goalId}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        mode: 'reschedule',
        trigger: `rule_conflict:${overflowConflict.id}`,
        taskIds: overflowConflict.taskId ? [overflowConflict.taskId] : undefined,
      }),
    });
    assert(conflictReplan.res.status === 201, `conflict action replan failed: ${conflictReplan.res.status} ${JSON.stringify(conflictReplan.body)}`);
    assert(conflictReplan.body.proposal.goalId === overflowGoal.body.goal.id, 'conflict action should create a proposal for the conflict goal');
    const hardOverride = await req(base, `/api/goals/${overflowGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ignoredRuleIds: [ruleId] }),
    });
    assert(hardOverride.res.status === 400, `hard rule override should fail: ${hardOverride.res.status} ${JSON.stringify(hardOverride.body)}`);
    assert(hardOverride.body.error.code === 'hard_rule_cannot_be_ignored', `hard override should return hard_rule_cannot_be_ignored, got ${hardOverride.body.error.code}`);

    const overrideGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'One time override plan',
        startAt: new Date('2030-01-13T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-13T21:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 21 }),
      }),
    });
    assert(overrideGoal.res.status === 201, `override goal create failed: ${overrideGoal.res.status} ${JSON.stringify(overrideGoal.body)}`);
    const overrideTask = await req(base, `/api/goals/${overrideGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Ship with a one-time exception', estimatedMinutes: 30 }),
    });
    assert(overrideTask.res.status === 201, `override task create failed: ${overrideTask.res.status} ${JSON.stringify(overrideTask.body)}`);
    const normalBlockRule = await req(base, '/api/schedule-rules', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        name: 'Protect this hour normally',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'normal',
        condition: { startTime: '20:00', endTime: '21:00' },
        action: { effect: 'block' },
        scope: { goalIds: [overrideGoal.body.goal.id] },
      }),
    });
    assert(normalBlockRule.res.status === 201, `normal block rule create failed: ${normalBlockRule.res.status} ${JSON.stringify(normalBlockRule.body)}`);
    const blockedByNormalRule = await req(base, `/api/goals/${overrideGoal.body.goal.id}/schedule-proposals`, { method: 'POST', cookie });
    assert(blockedByNormalRule.res.status === 201, `normal block proposal failed: ${blockedByNormalRule.res.status} ${JSON.stringify(blockedByNormalRule.body)}`);
    assert(
      blockedByNormalRule.body.proposal.conflicts.some(
        (conflict: any) => conflict.type === 'schedule_overflow' && conflict.ruleIds.includes(normalBlockRule.body.rule.id),
      ),
      'normal rule should block the task before one-time override',
    );
    const normalOverrideProposal = await req(base, `/api/goals/${overrideGoal.body.goal.id}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ ignoredRuleIds: [normalBlockRule.body.rule.id], trigger: 'rule_override:test' }),
    });
    assert(normalOverrideProposal.res.status === 201, `normal rule override proposal failed: ${normalOverrideProposal.res.status} ${JSON.stringify(normalOverrideProposal.body)}`);
    assert(normalOverrideProposal.body.proposal.changes.length === 1, 'normal rule override should allow the task to be scheduled');
    assert(
      normalOverrideProposal.body.proposal.conflicts.some(
        (conflict: any) => conflict.type === 'rule_override' && conflict.ruleIds.includes(normalBlockRule.body.rule.id) && conflict.severity === 'info',
      ),
      'normal rule override should persist an informational override record',
    );
    assert(
      !normalOverrideProposal.body.proposal.changes[0].ruleIds.includes(normalBlockRule.body.rule.id),
      'ignored normal rule should not be treated as a matched scheduling rule',
    );
    const normalOverrideConfirm = await req(base, `/api/schedule-proposals/${normalOverrideProposal.body.proposal.id}/confirm`, { method: 'POST', cookie });
    assert(normalOverrideConfirm.res.status === 200, `normal rule override confirm failed: ${normalOverrideConfirm.res.status} ${JSON.stringify(normalOverrideConfirm.body)}`);
    const dbAfterOverride = new DatabaseSync(dbPath);
    try {
      const row = dbAfterOverride.prepare('SELECT start_date, due_date FROM tasks WHERE id = ?').get(overrideTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
      };
      const storedProposal = dbAfterOverride.prepare('SELECT conflicts_json FROM schedule_proposals WHERE id = ?').get(normalOverrideProposal.body.proposal.id) as {
        conflicts_json: string;
      };
      assert(row.start_date === normalOverrideProposal.body.proposal.changes[0].plannedStartAt, 'override confirm should write the proposed start time');
      assert(row.due_date === normalOverrideProposal.body.proposal.changes[0].plannedEndAt, 'override confirm should write the proposed end time');
      assert(JSON.parse(storedProposal.conflicts_json).some((conflict: any) => conflict.type === 'rule_override'), 'override conflict should be stored in SQLite');
    } finally {
      dbAfterOverride.close();
    }

    const conflictDisableRule = await req(base, `/api/schedule-rules/${ruleId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ status: 'disabled' }),
    });
    assert(conflictDisableRule.res.status === 200, `conflict action disable rule failed: ${conflictDisableRule.res.status} ${JSON.stringify(conflictDisableRule.body)}`);
    assert(conflictDisableRule.body.rule.status === 'disabled', 'conflict action should disable the referenced rule');

    const ruleDetails = await req(base, `/api/schedule-rules/${ruleId}/details`, { cookie });
    assert(ruleDetails.res.status === 200, `rule details failed: ${ruleDetails.res.status} ${JSON.stringify(ruleDetails.body)}`);
    assert(ruleDetails.body.details.rule.id === ruleId, 'rule details should return the requested rule');
    assert(ruleDetails.body.details.hitCount >= 1, 'rule details should count historical proposal changes that referenced the rule');
    assert(ruleDetails.body.details.recentImpacts.length >= 1, 'rule details should include recent impacted tasks');
    assert(
      ruleDetails.body.details.recentImpacts.every((impact: any) => typeof impact.title === 'string' && typeof impact.reason === 'string'),
      'rule details should expose impacted task titles and scheduling reasons',
    );
    assert(ruleDetails.body.details.conflictCount >= 1, 'rule details should count conflicts that referenced the rule');
    assert(
      ruleDetails.body.details.recentConflicts.some((conflict: any) => conflict.type === 'schedule_overflow'),
      'rule details should include the recent overflow conflict',
    );
    const impactAnalysis = await req(base, '/api/schedule-rules/impact-analysis', { cookie });
    assert(impactAnalysis.res.status === 200, `rule impact analysis failed: ${impactAnalysis.res.status} ${JSON.stringify(impactAnalysis.body)}`);
    assert(impactAnalysis.body.analysis.summary.ruleCount >= 4, 'impact analysis should count persisted rules');
    assert(impactAnalysis.body.analysis.summary.totalHits >= 1, 'impact analysis should count rule hits from real proposals');
    assert(impactAnalysis.body.analysis.summary.totalConflicts >= 1, 'impact analysis should count rule conflicts from real proposals');
    const analyzedBlockingRule = impactAnalysis.body.analysis.rules.find((item: any) => item.rule.id === ruleId);
    assert(analyzedBlockingRule, 'impact analysis should include the blocking rule');
    assert(analyzedBlockingRule.delayRiskCount >= 1, 'impact analysis should mark the blocking rule as a delay risk');
    assert(analyzedBlockingRule.affectedTaskCount >= 1, 'impact analysis should count affected tasks for the rule');
    assert(analyzedBlockingRule.recommendation === 'loosen_rule', 'delay-risk rules should recommend loosening the rule');

    const deletionImpactTask = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Late affected work', estimatedMinutes: 30, scheduleTaskType: 'writing' }),
    });
    assert(deletionImpactTask.res.status === 201, `delete impact task create failed: ${deletionImpactTask.res.status} ${JSON.stringify(deletionImpactTask.body)}`);
    const scheduledDeletionImpactTask = await req(base, `/api/tasks/${deletionImpactTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        startDate: new Date('2030-01-08T21:45:00+08:00').toISOString(),
        dueDate: new Date('2030-01-08T22:15:00+08:00').toISOString(),
        plannedStartAt: new Date('2030-01-08T21:45:00+08:00').toISOString(),
        plannedEndAt: new Date('2030-01-08T22:15:00+08:00').toISOString(),
        isAllDay: false,
      }),
    });
    assert(
      scheduledDeletionImpactTask.res.status === 200,
      `delete impact task schedule failed: ${scheduledDeletionImpactTask.res.status} ${JSON.stringify(scheduledDeletionImpactTask.body)}`,
    );
    const deletePreview = await req(base, '/api/schedule-rules/preview', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        id: ruleId,
        name: 'No work after 21:30',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { daysOfWeek: [1, 2, 3], startTime: '21:30', endTime: '23:59' },
        action: { effect: 'block' },
        scope: {},
        from: new Date('2030-01-08T00:00:00+08:00').toISOString(),
        to: new Date('2030-01-09T00:00:00+08:00').toISOString(),
      }),
    });
    assert(deletePreview.res.status === 200, `delete preview failed: ${deletePreview.res.status} ${JSON.stringify(deletePreview.body)}`);
    assert(
      deletePreview.body.preview.affectedTasks.some((item: any) => item.taskId === deletionImpactTask.body.task.id && item.title === 'Late affected work'),
      'delete preview should expose future scheduled tasks affected by the rule',
    );

    const deleteRule = await req(base, `/api/schedule-rules/${ruleId}`, { method: 'DELETE', cookie });
    assert(deleteRule.res.status === 204, `delete rule failed: ${deleteRule.res.status}`);
    const listRulesAfterDelete = await req(base, '/api/schedule-rules', { cookie });
    assert(!listRulesAfterDelete.body.rules.some((rule: any) => rule.id === ruleId), 'deleted rule should be hidden from default list');
    const listRulesWithDeleted = await req(base, '/api/schedule-rules?includeDeleted=1', { cookie });
    const deletedRule = listRulesWithDeleted.body.rules.find((rule: any) => rule.id === ruleId);
    assert(deletedRule?.deletedAt, 'includeDeleted list should expose the soft-deleted rule');
    assert(deletedRule.status === 'disabled', 'deleted rule should be disabled while soft-deleted');
    const restoreRule = await req(base, `/api/schedule-rules/${ruleId}/restore`, { method: 'POST', cookie });
    assert(restoreRule.res.status === 200, `restore rule failed: ${restoreRule.res.status}`);
    assert(restoreRule.body.rule.deletedAt === null, 'restored rule should clear deletedAt');

    const ruleEditImpactTask = await req(base, `/api/goals/${goalId}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Rule edit affected work', estimatedMinutes: 45, scheduleTaskType: 'writing' }),
    });
    assert(ruleEditImpactTask.res.status === 201, `rule edit impact task create failed: ${ruleEditImpactTask.res.status} ${JSON.stringify(ruleEditImpactTask.body)}`);
    const ruleEditScheduledTask = await req(base, `/api/tasks/${ruleEditImpactTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        startDate: new Date('2030-01-08T15:15:00+08:00').toISOString(),
        dueDate: new Date('2030-01-08T16:00:00+08:00').toISOString(),
        plannedStartAt: new Date('2030-01-08T15:15:00+08:00').toISOString(),
        plannedEndAt: new Date('2030-01-08T16:00:00+08:00').toISOString(),
        isAllDay: false,
      }),
    });
    assert(ruleEditScheduledTask.res.status === 200, `rule edit task schedule failed: ${ruleEditScheduledTask.res.status} ${JSON.stringify(ruleEditScheduledTask.body)}`);
    const editedRule = await req(base, `/api/schedule-rules/${ruleId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        name: 'Afternoon writing guard',
        type: 'time_boundary',
        status: 'enabled',
        priority: 'hard',
        condition: { startTime: '15:00', endTime: '16:30' },
        action: { effect: 'block' },
        scope: {},
      }),
    });
    assert(editedRule.res.status === 200, `rule edit update failed: ${editedRule.res.status} ${JSON.stringify(editedRule.body)}`);
    const ruleEditReplan = await req(base, `/api/goals/${goalId}/schedule-proposals`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        from: new Date('2030-01-08T00:00:00+08:00').toISOString(),
        to: new Date('2030-01-15T00:00:00+08:00').toISOString(),
        mode: 'reschedule',
        trigger: `rule_update:${ruleId}`,
      }),
    });
    assert(ruleEditReplan.res.status === 201, `rule edit replan failed: ${ruleEditReplan.res.status} ${JSON.stringify(ruleEditReplan.body)}`);
    assert(
      ruleEditReplan.body.proposal.conflicts.some(
        (conflict: any) => conflict.type === 'reschedule_impact' && conflict.taskId === ruleEditImpactTask.body.task.id && conflict.ruleIds.includes(ruleId),
      ),
      'rule edit replan should include a rule-linked reschedule impact for the affected task',
    );
    assert(
      ruleEditReplan.body.proposal.changes.some(
        (change: any) => change.taskId === ruleEditImpactTask.body.task.id && change.oldPlannedStartAt === ruleEditScheduledTask.body.task.plannedStartAt,
      ),
      'rule edit replan should propose moving the affected scheduled task',
    );

    const parseNatural = await req(base, '/api/schedule-rules/parse-natural-language', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ text: '晚上九点半以后不要安排任务' }),
    });
    assert(parseNatural.res.status === 409, `disabled natural-language parser should be 409, got ${parseNatural.res.status}`);
    assert(parseNatural.body.error.code === 'ai_disabled', `disabled natural-language parser should return ai_disabled, got ${parseNatural.body.error.code}`);
    const listRulesAfterDisabledParse = await req(base, '/api/schedule-rules', { cookie });
    assert(
      !listRulesAfterDisabledParse.body.rules.some((rule: any) => rule.name === '晚上九点半以后不要安排任务'),
      'disabled natural-language parser should not persist a rule',
    );

    const db = new DatabaseSync(dbPath);
    try {
      const task = db
        .prepare(
          `SELECT start_date, due_date, planned_start_at, planned_end_at, schedule_energy_type, schedule_task_type
           FROM tasks WHERE id = ?`,
        )
        .get(deepTask.body.task.id) as {
        start_date: string | null;
        due_date: string | null;
        planned_start_at: string | null;
        planned_end_at: string | null;
        schedule_energy_type: string | null;
        schedule_task_type: string | null;
      };
      const proposalRow = db.prepare('SELECT status, confirmed_at FROM schedule_proposals WHERE id = ?').get(proposal.id) as {
        status: string;
        confirmed_at: string | null;
      };
      const reminderCount = db.prepare('SELECT COUNT(*) c FROM task_reminders WHERE task_id = ?').get(deepTask.body.task.id) as { c: number };
      const planPriorityScope = db.prepare('SELECT scope_json FROM personal_schedule_rules WHERE id = ?').get(planPriorityRuleId) as
        | { scope_json: string }
        | undefined;
      const ruleEditProposalRow = db.prepare('SELECT status, range_start, range_end FROM schedule_proposals WHERE id = ?').get(ruleEditReplan.body.proposal.id) as
        | { status: string; range_start: string; range_end: string }
        | undefined;
      assert(task.start_date === null && task.due_date === null, 'undo should restore empty calendar task dates');
      assert(task.planned_start_at === null && task.planned_end_at === null, 'undo should restore empty planned task dates');
      assert(task.schedule_energy_type === 'high' && task.schedule_task_type === 'writing', 'task scheduling metadata should persist');
      assert(proposalRow.status === 'undone' && proposalRow.confirmed_at, 'proposal row should be undone in DB while retaining confirmation audit time');
      assert(reminderCount.c === 0, 'undo should delete reminders created by the confirmed proposal');
      assert(JSON.parse(planPriorityScope?.scope_json ?? '{}').goalIds?.[0] === goalId, 'plan priority rule scope should persist the target goal');
      assert(ruleEditProposalRow?.status === 'draft', 'rule edit replan proposal should be persisted as a draft');
      assert(ruleEditProposalRow.range_start === new Date('2030-01-08T00:00:00+08:00').toISOString(), 'rule edit replan range start should persist');
      assert(ruleEditProposalRow.range_end === new Date('2030-01-15T00:00:00+08:00').toISOString(), 'rule edit replan range end should persist');
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

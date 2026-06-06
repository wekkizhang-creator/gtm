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
    const rulePatch = await req(base, `/api/schedule-rules/${ruleId}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'No work after 21:30', priority: 'hard' }),
    });
    assert(rulePatch.res.status === 200, `patch rule failed: ${rulePatch.res.status} ${JSON.stringify(rulePatch.body)}`);
    assert(rulePatch.body.rule.name === 'No work after 21:30', 'patched rule name should be returned');

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
    assert(
      proposal.changes[0].avoidedBlocks.some((block: any) => block.source === 'external' && block.title === 'Client Sync'),
      'proposal should explain the avoided external calendar event',
    );
    assert(proposal.explanations[0].message.includes('Client Sync'), 'proposal explanation should mention the external calendar event');
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
      assert(task.start_date === proposal.changes[0].plannedStartAt, 'confirmed proposal should write task start_date');
      assert(task.due_date === proposal.changes[0].plannedEndAt, 'confirmed proposal should write task due_date');
      assert(task.planned_start_at === task.start_date && task.planned_end_at === task.due_date, 'planned and calendar fields should match');
      assert(proposalRow.status === 'confirmed' && proposalRow.confirmed_at, 'proposal row should be confirmed in DB');
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
      assert(rules.c === 2, `rule preview should not persist a draft rule, got ${rules.c} rows`);
    } finally {
      dbAfterPreview.close();
    }

    const confirmAgain = await req(base, `/api/schedule-proposals/${proposal.id}/confirm`, { method: 'POST', cookie });
    assert(confirmAgain.res.status === 409, `second confirm should be 409, got ${confirmAgain.res.status}`);

    const undo = await req(base, `/api/schedule-proposals/${proposal.id}/undo`, { method: 'POST', cookie });
    assert(undo.res.status === 200, `undo failed: ${undo.res.status} ${JSON.stringify(undo.body)}`);
    assert(undo.body.proposal.status === 'undone', 'undo should mark the proposal as undone');
    assert(undo.body.tasks.length === 1, 'undo should return the restored task');

    const undoAgain = await req(base, `/api/schedule-proposals/${proposal.id}/undo`, { method: 'POST', cookie });
    assert(undoAgain.res.status === 409, `second undo should be 409, got ${undoAgain.res.status}`);

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
      overlapEdit.body.proposal.conflicts.some(
        (conflict: any) => conflict.type === 'manual_adjustment_conflict' && conflict.taskId === partialFirst.body.task.id,
      ),
      'manual overlap should add a manual_adjustment_conflict',
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

    const overflowGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Overflow plan',
        startAt: new Date('2030-01-12T20:00:00+08:00').toISOString(),
        deadlineAt: new Date('2030-01-12T21:00:00+08:00').toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 20, endHour: 21 }),
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

    const ruleDetails = await req(base, `/api/schedule-rules/${ruleId}/details`, { cookie });
    assert(ruleDetails.res.status === 200, `rule details failed: ${ruleDetails.res.status} ${JSON.stringify(ruleDetails.body)}`);
    assert(ruleDetails.body.details.rule.id === ruleId, 'rule details should return the requested rule');
    assert(ruleDetails.body.details.hitCount >= 1, 'rule details should count historical proposal changes that referenced the rule');
    assert(
      ruleDetails.body.details.recentImpacts.some((impact: any) => impact.title.includes('Deep work block')),
      'rule details should include the recent impacted task',
    );
    assert(ruleDetails.body.details.conflictCount >= 1, 'rule details should count conflicts that referenced the rule');
    assert(
      ruleDetails.body.details.recentConflicts.some((conflict: any) => conflict.type === 'schedule_overflow'),
      'rule details should include the recent overflow conflict',
    );

    const deleteRule = await req(base, `/api/schedule-rules/${ruleId}`, { method: 'DELETE', cookie });
    assert(deleteRule.res.status === 204, `delete rule failed: ${deleteRule.res.status}`);
    const listRulesAfterDelete = await req(base, '/api/schedule-rules', { cookie });
    assert(!listRulesAfterDelete.body.rules.some((rule: any) => rule.id === ruleId), 'deleted rule should be hidden from default list');
    const restoreRule = await req(base, `/api/schedule-rules/${ruleId}/restore`, { method: 'POST', cookie });
    assert(restoreRule.res.status === 200, `restore rule failed: ${restoreRule.res.status}`);

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
      assert(task.start_date === null && task.due_date === null, 'undo should restore empty calendar task dates');
      assert(task.planned_start_at === null && task.planned_end_at === null, 'undo should restore empty planned task dates');
      assert(task.schedule_energy_type === 'high' && task.schedule_task_type === 'writing', 'task scheduling metadata should persist');
      assert(proposalRow.status === 'undone' && proposalRow.confirmed_at, 'proposal row should be undone in DB while retaining confirmation audit time');
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

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
        deadlineAt: deadline.toISOString(),
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
        tasksText: 'Research audience\n\n- Draft outline\n[ ] Publish recap',
      }),
    });
    assert(bulkGoal.res.status === 201, `bulk goal create failed: ${bulkGoal.res.status} ${JSON.stringify(bulkGoal.body)}`);
    assert(bulkGoal.body.goal.title === 'Content launch checklist', 'bulk goal should return the created goal');
    assert(bulkGoal.body.tasks.length === 3, `expected three initial tasks, got ${bulkGoal.body.tasks.length}`);
    assert(
      bulkGoal.body.tasks.map((task: any) => task.title).join('|') === 'Research audience|Draft outline|Publish recap',
      'bulk goal should trim empty lines and common task bullets',
    );
    const bulkTree = await req(base, `/api/goals/${bulkGoal.body.goal.id}/tree`, { cookie });
    assert(bulkTree.body.tasks.length === 3, `bulk goal tree should expose three created tasks, got ${bulkTree.body.tasks.length}`);
    const dbAfterBulkGoal = new DatabaseSync(dbPath);
    try {
      const linkedTasks = dbAfterBulkGoal
        .prepare('SELECT COUNT(*) c FROM tasks WHERE goal_id = ? AND deleted_at IS NULL')
        .get(bulkGoal.body.goal.id) as { c: number };
      assert(linkedTasks.c === 3, `expected three DB tasks linked to bulk goal, got ${linkedTasks.c}`);
    } finally {
      dbAfterBulkGoal.close();
    }
    const deleteBulkGoal = await req(base, `/api/goals/${bulkGoal.body.goal.id}`, { method: 'DELETE', cookie });
    assert(deleteBulkGoal.res.status === 204, `delete bulk goal failed: ${deleteBulkGoal.res.status}`);

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

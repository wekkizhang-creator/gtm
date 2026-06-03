import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
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
  const codeStart = smtpMessages.length;
  const challenge = await req(base, '/api/auth/verification-codes', {
    method: 'POST',
    body: JSON.stringify({ type: 'email', identifier: email, purpose: 'login' }),
  });
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status} ${JSON.stringify(challenge.body)}`);
  for (let i = 0; i < 20 && smtpMessages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const message = smtpMessages.at(-1) ?? '';
  const code = message.match(/\b\d{6}\b/)?.[0];
  assert(code, `SMTP message did not include a code: ${message}`);
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device: { deviceId: `metadata-${email}`, deviceName: 'Metadata integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  const body = await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status} ${JSON.stringify(body)}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `metadata-test-${Date.now()}.db`);
  const attachmentsDir = resolve(root, 'server', 'data', `attachments-test-${Date.now()}`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'metadata-token-secret',
    AUTH_IDENTIFIER_SECRET: 'metadata-identifier-secret',
    ATTACHMENTS_DIR: attachmentsDir,
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);

    const userACookie = await login(base, 'metadata-alice@example.com', smtp.messages);
    const recurrenceStartAt = '2026-06-01T09:00:00.000Z';
    const recurrenceDueAt = '2026-06-01T10:00:00.000Z';
    const nextRecurrenceStartAt = '2026-06-08T09:00:00.000Z';
    const nextRecurrenceDueAt = '2026-06-08T10:00:00.000Z';
    const created = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({
        title: 'Tagged recurring task',
        priority: 3,
        startDate: recurrenceStartAt,
        dueDate: recurrenceDueAt,
        isAllDay: false,
        status: 'doing',
        recurrenceRule: 'FREQ=WEEKLY',
        manualProgress: 40,
        pinned: true,
      }),
    });
    assert(created.res.status === 201, `create task failed: ${created.res.status} ${JSON.stringify(created.body)}`);
    const taskId = created.body.task.id;
    assert(created.body.task.status === 'doing', 'task status did not round-trip');
    assert(created.body.task.recurrenceRule === 'FREQ=WEEKLY', 'task recurrence did not round-trip');
    assert(created.body.task.manualProgress === 40, 'manual progress did not round-trip');
    assert(created.body.task.pinned === true, 'pinned did not round-trip');

    const tagRes = await req(base, '/api/tags', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ name: 'Deep Work', color: '#4f8f7f' }),
    });
    assert(tagRes.res.status === 201, `create tag failed: ${tagRes.res.status} ${JSON.stringify(tagRes.body)}`);
    const tagId = tagRes.body.tag.id;

    const attach = await req(base, `/api/tasks/${taskId}/tags/${tagId}`, { method: 'POST', cookie: userACookie });
    assert(attach.res.status === 200, `attach tag failed: ${attach.res.status} ${JSON.stringify(attach.body)}`);
    assert(attach.body.task.tags.length === 1 && attach.body.task.tags[0].name === 'Deep Work', 'attached tag missing from task');

    const childTag = await req(base, '/api/tags', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ name: 'Client Work', color: '#88aaff', parentId: tagId }),
    });
    assert(childTag.res.status === 201, `create child tag failed: ${childTag.res.status} ${JSON.stringify(childTag.body)}`);
    assert(childTag.body.tag.parentId === tagId, 'child tag parentId did not persist');

    const aliasTag = await req(base, '/api/tags', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ name: 'Work Alias', color: '#ffcc88' }),
    });
    const aliasTaggedTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ title: 'Alias tagged task', tagIds: [aliasTag.body.tag.id] }),
    });
    const mergedTag = await req(base, `/api/tags/${aliasTag.body.tag.id}/merge`, {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ targetId: tagId }),
    });
    assert(mergedTag.body.merge.movedTaskTags === 1, 'tag merge should move one task-tag relation');
    const tagsAfterMerge = await req(base, '/api/tags', { cookie: userACookie });
    assert(tagsAfterMerge.body.tags.length === 2, `expected two tags after merge, got ${tagsAfterMerge.body.tags.length}`);
    assert(tagsAfterMerge.body.tags.some((tag: any) => tag.id === childTag.body.tag.id && tag.parentId === tagId), 'child tag should remain under target tag');
    assert(!tagsAfterMerge.body.tags.some((tag: any) => tag.id === aliasTag.body.tag.id), 'source tag should be deleted after merge');
    const mergedTaskRead = await req(base, `/api/tasks/${aliasTaggedTask.body.task.id}`, { cookie: userACookie });
    assert(mergedTaskRead.body.task.tags.some((tag: any) => tag.id === tagId), 'merged task should now use target tag');
    assert(!mergedTaskRead.body.task.tags.some((tag: any) => tag.id === aliasTag.body.tag.id), 'merged task should not keep source tag');

    const remindAt = '2026-06-01T09:30:00.000Z';
    const reminder = await req(base, `/api/tasks/${taskId}/reminders`, {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ remindAt, channel: 'email' }),
    });
    assert(reminder.res.status === 201, `create reminder failed: ${reminder.res.status} ${JSON.stringify(reminder.body)}`);
    assert(reminder.body.reminder.remindAt === remindAt, 'reminder remindAt did not round-trip');

    const attachmentBody = 'hello attachment';
    const attachment = await req(base, `/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({
        fileName: 'note.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.from(attachmentBody, 'utf8').toString('base64'),
      }),
    });
    assert(attachment.res.status === 201, `create attachment failed: ${attachment.res.status} ${JSON.stringify(attachment.body)}`);
    assert(attachment.body.attachment.fileName === 'note.txt', 'attachment fileName did not round-trip');
    const attachmentId = attachment.body.attachment.id;

    const filtered = await req(base, `/api/tasks?view=active&tagId=${tagId}&status=doing`, { cookie: userACookie });
    assert(filtered.res.status === 200, `filtered task query failed: ${filtered.res.status} ${JSON.stringify(filtered.body)}`);
    assert(filtered.body.tasks.length === 1 && filtered.body.tasks[0].id === taskId, 'tag/status filter did not return the task');
    assert(filtered.body.tasks[0].reminders.length === 1, 'filtered task did not include reminders');
    assert(filtered.body.tasks[0].attachments.length === 1, 'filtered task did not include attachments');

    const download = await fetch(`${base}/api/attachments/${attachmentId}/download`, { headers: { Cookie: userACookie } });
    assert(download.status === 200, `download attachment failed: ${download.status}`);
    assert((await download.text()) === attachmentBody, 'downloaded attachment content mismatch');

    const done = await req(base, `/api/tasks/${taskId}`, {
      method: 'PATCH',
      cookie: userACookie,
      body: JSON.stringify({ status: 'done' }),
    });
    assert(done.body.task.completed === true, 'status=done did not mark task completed');

    const activeAfterDone = await req(base, '/api/tasks?view=active', { cookie: userACookie });
    const nextRecurringTask = activeAfterDone.body.tasks.find((task: any) => task.id !== taskId && task.source === 'recurrence');
    assert(nextRecurringTask, 'completing a recurring task should create the next task instance');
    assert(nextRecurringTask.completed === false, 'next recurring task should be open');
    assert(nextRecurringTask.startDate === nextRecurrenceStartAt, `next recurring startDate mismatch: ${nextRecurringTask.startDate}`);
    assert(nextRecurringTask.dueDate === nextRecurrenceDueAt, `next recurring dueDate mismatch: ${nextRecurringTask.dueDate}`);
    assert(nextRecurringTask.recurrenceRule === 'FREQ=WEEKLY', 'next recurring task should preserve recurrence rule');
    assert(nextRecurringTask.tags.length === 1 && nextRecurringTask.tags[0].id === tagId, 'next recurring task should copy tags');
    assert(nextRecurringTask.reminders.length === 1, 'next recurring task should copy reminders');
    assert(nextRecurringTask.reminders[0].remindAt === '2026-06-08T09:30:00.000Z', 'next recurring reminder should shift one week');

    const deferTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({
        title: 'Daily defer recurring task',
        startDate: '2026-06-02T08:00:00.000Z',
        dueDate: '2026-06-02T09:00:00.000Z',
        isAllDay: false,
        recurrenceRule: 'FREQ=DAILY',
      }),
    });
    const deferTaskId = deferTask.body.task.id;
    const deferReminder = await req(base, `/api/tasks/${deferTaskId}/reminders`, {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ remindAt: '2026-06-02T07:45:00.000Z', channel: 'email' }),
    });
    assert(deferReminder.res.status === 201, `create defer reminder failed: ${deferReminder.res.status}`);
    const deferred = await req(base, `/api/tasks/${deferTaskId}/recurrence/defer`, { method: 'POST', cookie: userACookie });
    assert(deferred.body.task.startDate === '2026-06-03T08:00:00.000Z', `deferred startDate mismatch: ${deferred.body.task.startDate}`);
    assert(deferred.body.task.dueDate === '2026-06-03T09:00:00.000Z', `deferred dueDate mismatch: ${deferred.body.task.dueDate}`);
    assert(deferred.body.task.completed === false, 'deferred recurring task should remain open');
    assert(deferred.body.task.reminders[0].remindAt === '2026-06-03T07:45:00.000Z', 'deferred reminder should shift one day');

    const skipTask = await req(base, '/api/tasks', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({
        title: 'Daily skip recurring task',
        startDate: '2026-06-04T08:00:00.000Z',
        dueDate: '2026-06-04T09:00:00.000Z',
        isAllDay: false,
        recurrenceRule: 'FREQ=DAILY',
      }),
    });
    const skipTaskId = skipTask.body.task.id;
    const skipReminder = await req(base, `/api/tasks/${skipTaskId}/reminders`, {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ remindAt: '2026-06-04T07:45:00.000Z', channel: 'email' }),
    });
    assert(skipReminder.res.status === 201, `create skip reminder failed: ${skipReminder.res.status}`);
    const skipped = await req(base, `/api/tasks/${skipTaskId}/recurrence/skip`, { method: 'POST', cookie: userACookie });
    assert(skipped.body.task.status === 'skipped', `skipped task status mismatch: ${skipped.body.task.status}`);
    assert(skipped.body.task.completed === false, 'skipped task should not count as completed');
    assert(skipped.body.task.reminders[0].status === 'cancelled', 'skipped task reminder should be cancelled');
    assert(skipped.body.nextTask, 'skipping a recurring task should create the next task instance');
    assert(skipped.body.nextTask.startDate === '2026-06-05T08:00:00.000Z', `skip next startDate mismatch: ${skipped.body.nextTask.startDate}`);
    assert(skipped.body.nextTask.dueDate === '2026-06-05T09:00:00.000Z', `skip next dueDate mismatch: ${skipped.body.nextTask.dueDate}`);
    assert(skipped.body.nextTask.reminders[0].remindAt === '2026-06-05T07:45:00.000Z', 'skip next reminder should shift one day');
    const skipAgain = await req(base, `/api/tasks/${skipTaskId}/recurrence/skip`, { method: 'POST', cookie: userACookie });
    assert(skipAgain.body.nextTask === null, 'repeating skip should not create duplicate next instances');
    const activeAfterSkip = await req(base, '/api/tasks?view=active', { cookie: userACookie });
    assert(!activeAfterSkip.body.tasks.some((item: any) => item.id === skipTaskId), 'skipped task should be hidden from active view');
    assert(activeAfterSkip.body.tasks.some((item: any) => item.id === skipped.body.nextTask.id), 'skip-created next task should remain active');

    const userBCookie = await login(base, 'metadata-bob@example.com', smtp.messages);
    const bobTags = await req(base, '/api/tags', { cookie: userBCookie });
    assert(bobTags.body.tags.length === 0, `expected Bob to see zero Alice tags, got ${bobTags.body.tags.length}`);
    const bobReminderRead = await req(base, `/api/tasks/${taskId}/reminders`, { cookie: userBCookie });
    assert(bobReminderRead.res.status === 404, `expected Bob task reminder read to be 404, got ${bobReminderRead.res.status}`);
    const bobAttach = await req(base, `/api/tasks/${taskId}/tags/${tagId}`, { method: 'POST', cookie: userBCookie });
    assert(bobAttach.res.status === 404, `expected Bob tag attach to be 404, got ${bobAttach.res.status}`);
    const bobDownload = await fetch(`${base}/api/attachments/${attachmentId}/download`, { headers: { Cookie: userBCookie } });
    assert(bobDownload.status === 404, `expected Bob attachment download to be 404, got ${bobDownload.status}`);

    const quickParse = await req(base, '/api/tasks/quick-parse', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({
        text: '明天 10:30 write report #Work !高 45m 每周',
        options: { removeDateText: true, removeTagText: true },
      }),
    });
    assert(quickParse.res.status === 200, `quick-parse failed: ${quickParse.res.status} ${JSON.stringify(quickParse.body)}`);
    assert(quickParse.body.draft.title === 'write report', `quick-parse title mismatch: ${quickParse.body.draft.title}`);
    assert(quickParse.body.draft.priority === 3, 'quick-parse priority mismatch');
    assert(quickParse.body.draft.estimatedMinutes === 45, 'quick-parse estimate mismatch');
    assert(quickParse.body.draft.recurrenceRule === 'FREQ=WEEKLY', 'quick-parse recurrence mismatch');
    assert(quickParse.body.draft.tags.includes('Work'), 'quick-parse tag mismatch');
    assert(quickParse.body.draft.dueDate && quickParse.body.draft.isAllDay === false, 'quick-parse timed due date missing');
    const savedFilter = await req(base, '/api/filters', {
      method: 'POST',
      cookie: userACookie,
      body: JSON.stringify({ name: 'High priority', query: { priority: 3 } }),
    });
    assert(savedFilter.res.status === 201, `save filter failed: ${savedFilter.res.status} ${JSON.stringify(savedFilter.body)}`);
    const filters = await req(base, '/api/filters', { cookie: userACookie });
    assert(filters.body.filters.length === 1 && filters.body.filters[0].query.priority === 3, 'saved filter did not persist');

    const exportA = await req(base, '/api/settings/export', { cookie: userACookie });
    const exportB = await req(base, '/api/settings/export', { cookie: userBCookie });
    assert(exportA.body.tags.length === 2, 'Alice export should include parent and child tags after merge');
    assert(exportA.body.taskTags.length === 3, 'Alice export should include original, recurring, and merged task-tag relations');
    assert(exportA.body.taskReminders.length === 5, 'Alice export should include original, recurring, deferred, and skipped reminders');
    assert(exportA.body.attachments.length === 1, 'Alice export should include one attachment');
    assert(exportA.body.savedFilters.length === 1, 'Alice export should include one saved filter');
    assert(exportB.body.tags.length === 0, 'Bob export should include zero tags');
    assert(exportB.body.taskReminders.length === 0, 'Bob export should include zero reminders');
    assert(exportB.body.attachments.length === 0, 'Bob export should include zero attachments');

    const db = new DatabaseSync(dbPath);
    try {
      const taskRow = db.prepare('SELECT recurrence_rule, manual_progress, pinned, status, completed FROM tasks WHERE id = ?').get(taskId) as {
        recurrence_rule: string;
        manual_progress: number;
        pinned: number;
        status: string;
        completed: number;
      };
      const tagCount = db.prepare('SELECT COUNT(*) c FROM tags').get() as { c: number };
      const taskTagCount = db.prepare('SELECT COUNT(*) c FROM task_tags').get() as { c: number };
      const reminderCount = db.prepare('SELECT COUNT(*) c FROM task_reminders').get() as { c: number };
      const filterCount = db.prepare('SELECT COUNT(*) c FROM saved_filters').get() as { c: number };
      const attachmentRow = db.prepare('SELECT COUNT(*) c, storage_path FROM attachments').get() as { c: number; storage_path: string };
      const nextTaskRow = db
        .prepare("SELECT id, source, start_date, due_date, recurrence_rule, status, completed FROM tasks WHERE id = ?")
        .get(nextRecurringTask.id) as {
        id: string;
        source: string;
        start_date: string;
        due_date: string;
        recurrence_rule: string;
        status: string;
        completed: number;
      };
      const nextReminderRow = db.prepare('SELECT remind_at FROM task_reminders WHERE task_id = ?').get(nextTaskRow.id) as { remind_at: string };
      const deferredTaskRow = db
        .prepare("SELECT start_date, due_date, completed FROM tasks WHERE id = ?")
        .get(deferTaskId) as { start_date: string; due_date: string; completed: number };
      const deferredReminderRow = db.prepare('SELECT remind_at, status FROM task_reminders WHERE task_id = ?').get(deferTaskId) as {
        remind_at: string;
        status: string;
      };
      const skippedTaskRow = db
        .prepare('SELECT status, completed FROM tasks WHERE id = ?')
        .get(skipTaskId) as { status: string; completed: number };
      const skipNextTaskRow = db
        .prepare('SELECT source, start_date, due_date, status, completed FROM tasks WHERE id = ?')
        .get(skipped.body.nextTask.id) as { source: string; start_date: string; due_date: string; status: string; completed: number };
      const skipReminderRows = db.prepare('SELECT task_id, remind_at, status FROM task_reminders WHERE task_id IN (?, ?) ORDER BY task_id, remind_at').all(
        skipTaskId,
        skipped.body.nextTask.id,
      ) as Array<{ task_id: string; remind_at: string; status: string }>;
      const childTagRow = db.prepare('SELECT parent_id FROM tags WHERE id = ?').get(childTag.body.tag.id) as { parent_id: string | null };
      assert(taskRow.recurrence_rule === 'FREQ=WEEKLY', 'DB recurrence_rule mismatch');
      assert(taskRow.manual_progress === 40, 'DB manual_progress mismatch');
      assert(taskRow.pinned === 1, 'DB pinned mismatch');
      assert(taskRow.status === 'done' && taskRow.completed === 1, 'DB status/completed mismatch');
      assert(nextTaskRow.source === 'recurrence', 'DB next recurring task source mismatch');
      assert(nextTaskRow.start_date === nextRecurrenceStartAt, 'DB next recurring start_date mismatch');
      assert(nextTaskRow.due_date === nextRecurrenceDueAt, 'DB next recurring due_date mismatch');
      assert(nextTaskRow.recurrence_rule === 'FREQ=WEEKLY', 'DB next recurring recurrence_rule mismatch');
      assert(nextTaskRow.status === 'todo' && nextTaskRow.completed === 0, 'DB next recurring task should be open');
      assert(nextReminderRow.remind_at === '2026-06-08T09:30:00.000Z', 'DB next recurring reminder mismatch');
      assert(deferredTaskRow.start_date === '2026-06-03T08:00:00.000Z', 'DB deferred task start_date mismatch');
      assert(deferredTaskRow.due_date === '2026-06-03T09:00:00.000Z', 'DB deferred task due_date mismatch');
      assert(deferredTaskRow.completed === 0, 'DB deferred task should remain open');
      assert(deferredReminderRow.remind_at === '2026-06-03T07:45:00.000Z', 'DB deferred reminder mismatch');
      assert(deferredReminderRow.status === 'scheduled', 'DB deferred reminder should be scheduled');
      assert(skippedTaskRow.status === 'skipped' && skippedTaskRow.completed === 0, 'DB skipped task status mismatch');
      assert(skipNextTaskRow.source === 'recurrence', 'DB skip next task source mismatch');
      assert(skipNextTaskRow.start_date === '2026-06-05T08:00:00.000Z', 'DB skip next task start_date mismatch');
      assert(skipNextTaskRow.due_date === '2026-06-05T09:00:00.000Z', 'DB skip next task due_date mismatch');
      assert(skipNextTaskRow.status === 'todo' && skipNextTaskRow.completed === 0, 'DB skip next task should be open');
      assert(skipReminderRows.some((row) => row.task_id === skipTaskId && row.status === 'cancelled'), 'DB skipped reminder should be cancelled');
      assert(
        skipReminderRows.some((row) => row.task_id === skipped.body.nextTask.id && row.status === 'scheduled' && row.remind_at === '2026-06-05T07:45:00.000Z'),
        'DB skip next reminder mismatch',
      );
      assert(childTagRow.parent_id === tagId, 'DB child tag parent_id mismatch');
      assert(tagCount.c === 2, `expected 2 tags in DB, got ${tagCount.c}`);
      assert(taskTagCount.c === 3, `expected 3 task_tags rows in DB, got ${taskTagCount.c}`);
      assert(reminderCount.c === 5, `expected 5 reminders in DB, got ${reminderCount.c}`);
      assert(filterCount.c === 1, `expected 1 saved filter in DB, got ${filterCount.c}`);
      assert(attachmentRow.c === 1, `expected 1 attachment in DB, got ${attachmentRow.c}`);
      assert(existsSync(attachmentRow.storage_path), 'attachment file was not written');
      assert(readFileSync(attachmentRow.storage_path, 'utf8') === attachmentBody, 'attachment file content mismatch on disk');
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
    const dataRoot = resolve(root, 'server', 'data');
    if (attachmentsDir.startsWith(dataRoot) && existsSync(attachmentsDir)) {
      rmSync(attachmentsDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

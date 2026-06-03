import { DatabaseSync } from 'node:sqlite';
import net from 'node:net';
import http from 'node:http';
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
  return { port, messages, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
}

async function startAiProvider(): Promise<{
  port: number;
  requests: Array<{ url: string; auth: string | undefined; body: any }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ url: string; auth: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const userContent = String(body?.messages?.find((m: any) => m.role === 'user')?.content ?? '');
        let content: string;
        if (userContent.includes('scheduleRange')) {
          const parsed = JSON.parse(userContent);
          const firstTask = parsed.schedulableTasks[0];
          content = JSON.stringify({
            suggestions: [
              {
                taskId: firstTask.id,
                title: firstTask.title,
                plannedStartAt: '2030-01-03T10:00:00.000Z',
                plannedEndAt: '2030-01-03T11:00:00.000Z',
                reason: 'Schedule after the external planning block and before the goal deadline.',
              },
            ],
          });
        } else if (userContent.includes('reviewMetrics')) {
          content = JSON.stringify({
            summary: '本周完成了演示准备的关键推进，专注投入稳定，但仍有逾期风险需要收口。',
            wins: ['完成了核心任务拆解', '专注记录形成了可观察节奏'],
            risks: ['仍有逾期任务没有处理'],
            suggestions: ['下周先处理逾期项，再安排高优先级任务'],
            nextActions: [
              { title: '收口逾期任务', reason: '减少计划噪音' },
              { title: '安排一次复盘专注块', reason: '保持节奏' },
            ],
          });
        } else if (userContent.includes('isImportant')) {
          content = JSON.stringify({
            suggestion: {
              isImportant: true,
              isUrgent: false,
              confidence: 0.82,
              reason: 'Investor demo is strategically important, but no immediate deadline was provided.',
            },
          });
        } else {
          content = JSON.stringify({
            subtasks: [
              { title: 'Draft outline', note: 'Define the sections first', estimatedMinutes: 30, priority: 2 },
              { title: 'Review risks', note: null, estimatedMinutes: 20, priority: 1 },
            ],
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [
              {
                message: {
                  content,
                },
              },
            ],
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return { port, requests, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
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
  return body ? JSON.parse(body) : null;
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
  assert(challenge.res.status === 201, `verification code failed: ${challenge.res.status}`);
  for (let i = 0; i < 20 && smtpMessages.length === codeStart; i++) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const code = (smtpMessages.at(-1) ?? '').match(/\b\d{6}\b/)?.[0];
  assert(code, 'SMTP message did not include a code');
  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId: challenge.body.challengeId,
      code,
      agreedToTerms: true,
      device: { deviceId: `ai-${email}`, deviceName: 'AI integration test', platform: 'Web', appVersion: 'test' },
    }),
  });
  await json(loginRes);
  assert(loginRes.status === 201 || loginRes.status === 200, `login failed: ${loginRes.status}`);
  return cookiesFrom(loginRes);
}

async function main() {
  const smtp = await startSmtp();
  const ai = await startAiProvider();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `ai-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'ai-token-secret',
    AUTH_IDENTIFIER_SECRET: 'ai-identifier-secret',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const cookie = await login(base, 'ai-alice@example.com', smtp.messages);
    const task = await req(base, '/api/tasks', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Prepare investor demo', note: 'Need a clear story and risk review' }),
    });
    assert(task.res.status === 201, `task create failed: ${task.res.status}`);

    const notConfigured = await req(base, '/api/ai/task-breakdown', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ taskId: task.body.task.id }),
    });
    assert(notConfigured.res.status === 409, `unconfigured AI should be 409, got ${notConfigured.res.status}`);
    assert(notConfigured.body.error.code === 'ai_disabled', `unconfigured AI should return ai_disabled, got ${notConfigured.body.error.code}`);
    assert(ai.requests.length === 0, 'unconfigured AI must not call the provider');

    const missingKeyPatch = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        ai: {
          enabled: true,
          provider: 'test-provider',
          baseUrl: `http://127.0.0.1:${ai.port}/v1`,
          model: 'test-model',
        },
      }),
    });
    assert(missingKeyPatch.body.settings.ai.hasApiKey === false, 'missing key setup should not report an API key');
    const missingKey = await req(base, '/api/ai/weekly-review', { method: 'POST', cookie });
    assert(missingKey.res.status === 409, `missing AI key should be 409, got ${missingKey.res.status}`);
    assert(missingKey.body.error.code === 'ai_not_configured', `missing AI key should return ai_not_configured, got ${missingKey.body.error.code}`);
    assert(ai.requests.length === 0, 'AI missing API key must not call the provider');

    const patch = await req(base, '/api/settings', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        ai: {
          enabled: true,
          provider: 'test-provider',
          baseUrl: `http://127.0.0.1:${ai.port}/v1`,
          model: 'test-model',
          apiKey: 'test-secret-key',
        },
      }),
    });
    assert(patch.body.settings.ai.hasApiKey === true, 'AI key did not persist as masked setting');

    const connection = await req(base, '/api/settings/ai/test', { method: 'POST', cookie });
    assert(connection.body.ok === true, `AI connection test failed: ${JSON.stringify(connection.body)}`);

    const result = await req(base, '/api/ai/task-breakdown', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ taskId: task.body.task.id, maxItems: 4 }),
    });
    assert(result.res.status === 200, `AI breakdown failed: ${result.res.status} ${JSON.stringify(result.body)}`);
    assert(result.body.suggestions.length === 2, `expected 2 suggestions, got ${result.body.suggestions.length}`);
    assert(result.body.suggestions[0].title === 'Draft outline', 'AI suggestion title did not parse');
    assert(ai.requests.some((r) => r.url === '/v1/chat/completions' && r.auth === 'Bearer test-secret-key'), 'AI provider was not called with bearer key');

    for (const suggestion of result.body.suggestions) {
      await req(base, '/api/tasks', {
        method: 'POST',
        cookie,
        body: JSON.stringify({
          title: suggestion.title,
          note: suggestion.note,
          parentId: task.body.task.id,
          estimatedMinutes: suggestion.estimatedMinutes,
          priority: suggestion.priority,
          source: 'ai',
        }),
      });
    }

    const subtasks = await req(base, `/api/tasks?parentId=${task.body.task.id}`, { cookie });
    assert(subtasks.body.tasks.length === 2, `expected 2 AI-created subtasks, got ${subtasks.body.tasks.length}`);
    assert(subtasks.body.tasks.every((t: any) => t.source === 'ai'), 'AI-created subtasks should carry source=ai');

    const quadrant = await req(base, '/api/ai/quadrant-suggestion', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ taskId: task.body.task.id }),
    });
    assert(quadrant.res.status === 200, `AI quadrant suggestion failed: ${quadrant.res.status} ${JSON.stringify(quadrant.body)}`);
    assert(quadrant.body.suggestion.isImportant === true, 'quadrant suggestion should mark task important');
    assert(quadrant.body.suggestion.isUrgent === false, 'quadrant suggestion should mark task not urgent');

    const acceptedQuadrant = await req(base, `/api/tasks/${task.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        isImportant: quadrant.body.suggestion.isImportant,
        isUrgent: quadrant.body.suggestion.isUrgent,
      }),
    });
    assert(acceptedQuadrant.body.task.isImportant === true && acceptedQuadrant.body.task.isUrgent === false, 'accepted quadrant should update task');

    const endedAt = new Date().toISOString();
    const startedAt = new Date(Date.now() - 25 * 60_000).toISOString();
    await req(base, '/api/focus/sessions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        taskId: task.body.task.id,
        mode: 'pomodoro',
        startedAt,
        endedAt,
        durationSec: 25 * 60,
        isPomodoro: true,
      }),
    });

    const review = await req(base, '/api/ai/weekly-review', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ from: new Date(Date.now() - 7 * 86400_000).toISOString(), to: new Date().toISOString() }),
    });
    assert(review.res.status === 200, `AI weekly review failed: ${review.res.status} ${JSON.stringify(review.body)}`);
    assert(review.body.summary.includes('本周完成'), 'weekly review summary did not parse');
    assert(review.body.metrics.focusMinutes === 25, `expected 25 focus minutes, got ${review.body.metrics.focusMinutes}`);
    assert(review.body.nextActions.length === 2, 'weekly review next actions did not parse');

    const scheduleGoal = await req(base, '/api/goals', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        title: 'Launch investor demo',
        startAt: '2030-01-03T00:00:00.000Z',
        deadlineAt: '2030-01-05T18:00:00.000Z',
        availableTimeRule: JSON.stringify({ startHour: 9, endHour: 18 }),
      }),
    });
    assert(scheduleGoal.res.status === 201, `goal create failed: ${scheduleGoal.res.status}`);
    const scheduleTask = await req(base, `/api/goals/${scheduleGoal.body.goal.id}/tasks`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ title: 'Polish pitch deck', estimatedMinutes: 60, priority: 3 }),
    });
    assert(scheduleTask.res.status === 201, `goal task create failed: ${scheduleTask.res.status}`);

    const sub = await req(base, '/api/calendar/subscriptions', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'AI planning calendar', type: 'ics' }),
    });
    assert(sub.res.status === 201, `calendar subscription create failed: ${sub.res.status}`);
    const icsText = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:ai-planning@example.com
SUMMARY:Design Review
DTSTART:20300103T090000Z
DTEND:20300103T100000Z
END:VEVENT
END:VCALENDAR`;
    const sync = await req(base, `/api/calendar/subscriptions/${sub.body.subscription.id}/sync`, {
      method: 'POST',
      cookie,
      body: JSON.stringify({ icsText }),
    });
    assert(sync.body.events.length === 1, 'calendar sync should create one external event');

    const schedule = await req(base, '/api/ai/schedule-suggestion', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        goalId: scheduleGoal.body.goal.id,
        from: '2030-01-03T00:00:00.000Z',
        to: '2030-01-04T00:00:00.000Z',
      }),
    });
    assert(schedule.res.status === 200, `AI schedule suggestion failed: ${schedule.res.status} ${JSON.stringify(schedule.body)}`);
    assert(schedule.body.goalId === scheduleGoal.body.goal.id, 'schedule result should echo goalId');
    assert(schedule.body.suggestions.length === 1, `expected one schedule suggestion, got ${schedule.body.suggestions.length}`);
    assert(schedule.body.suggestions[0].taskId === scheduleTask.body.task.id, 'schedule suggestion task mismatch');
    assert(
      ai.requests.some((r) => String(r.body?.messages?.find((m: any) => m.role === 'user')?.content ?? '').includes('Design Review')),
      'AI schedule request should include external calendar context',
    );

    const taskBeforeSchedule = await req(base, `/api/tasks/${scheduleTask.body.task.id}`, { cookie });
    assert(!taskBeforeSchedule.body.task.plannedStartAt, 'AI schedule suggestion should not mutate the task before acceptance');
    const acceptedSchedule = await req(base, `/api/tasks/${scheduleTask.body.task.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        plannedStartAt: schedule.body.suggestions[0].plannedStartAt,
        plannedEndAt: schedule.body.suggestions[0].plannedEndAt,
        startDate: schedule.body.suggestions[0].plannedStartAt,
        dueDate: schedule.body.suggestions[0].plannedEndAt,
        isAllDay: false,
      }),
    });
    assert(acceptedSchedule.body.task.plannedStartAt === '2030-01-03T10:00:00.000Z', 'accepted schedule start did not persist');
    assert(acceptedSchedule.body.task.plannedEndAt === '2030-01-03T11:00:00.000Z', 'accepted schedule end did not persist');

    const db = new DatabaseSync(dbPath);
    try {
      const log = db.prepare("SELECT request_json, response_json, status FROM ai_generation_logs WHERE scenario = 'task_breakdown'").get() as
        | { request_json: string; response_json: string; status: string }
        | undefined;
      assert(log?.status === 'success', 'AI generation log was not written');
      assert(!log.request_json.includes('test-secret-key'), 'AI log must not store raw API key');
      assert(JSON.parse(log.response_json).suggestions.length === 2, 'AI log response did not store parsed suggestions');
      const quadrantLog = db.prepare("SELECT response_json, status FROM ai_generation_logs WHERE scenario = 'quadrant_suggestion'").get() as
        | { response_json: string; status: string }
        | undefined;
      assert(quadrantLog?.status === 'success', 'AI quadrant generation log was not written');
      assert(JSON.parse(quadrantLog.response_json).suggestion.isImportant === true, 'quadrant log response mismatch');
      const reviewLog = db.prepare("SELECT request_json, response_json, status FROM ai_generation_logs WHERE scenario = 'weekly_review'").get() as
        | { request_json: string; response_json: string; status: string }
        | undefined;
      assert(reviewLog?.status === 'success', 'AI weekly review log was not written');
      assert(!reviewLog.request_json.includes('test-secret-key'), 'weekly review log must not store raw API key');
      assert(JSON.parse(reviewLog.response_json).summary.includes('本周完成'), 'weekly review log response mismatch');
      const scheduleLog = db.prepare("SELECT request_json, response_json, status FROM ai_generation_logs WHERE scenario = 'schedule_suggestion'").get() as
        | { request_json: string; response_json: string; status: string }
        | undefined;
      assert(scheduleLog?.status === 'success', 'AI schedule generation log was not written');
      assert(JSON.parse(scheduleLog.request_json).externalEvents.length === 1, 'schedule log should include external calendar context');
      assert(JSON.parse(scheduleLog.response_json).suggestions[0].taskId === scheduleTask.body.task.id, 'schedule log response mismatch');
      const scheduledRow = db.prepare('SELECT planned_start_at, planned_end_at FROM tasks WHERE id = ?').get(scheduleTask.body.task.id) as
        | { planned_start_at: string | null; planned_end_at: string | null }
        | undefined;
      assert(scheduledRow?.planned_start_at === '2030-01-03T10:00:00.000Z', 'accepted schedule was not written to SQLite');
      assert(scheduledRow?.planned_end_at === '2030-01-03T11:00:00.000Z', 'accepted schedule end was not written to SQLite');
      const count = db.prepare("SELECT COUNT(*) c FROM tasks WHERE source = 'ai'").get() as { c: number };
      assert(count.c === 2, `expected 2 persisted AI subtasks, got ${count.c}`);
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await smtp.close();
    await ai.close();
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

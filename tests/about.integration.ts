import { loginCookie } from './auth-test-helper';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import http, { type Server as HttpServer } from 'node:http';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
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

async function json(res: Response): Promise<any> {
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

async function startManifest(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: HttpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ latestVersion: '9.9.9', downloadUrl: 'https://example.com/app', releaseNotes: 'test release' }));
  });
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolvePromise(typeof addr === 'object' && addr ? addr.port : 0);
    });
    server.on('error', reject);
  });
  return { url: `http://127.0.0.1:${port}/manifest.json`, close: () => new Promise((resolvePromise) => server.close(() => resolvePromise())) };
}

async function startSmtp(): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let mode: 'line' | 'data' = 'line';
    let data = '';
    socket.write('220 about.smtp.local ESMTP\r\n');
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

function cookiesFrom(res: Response): string {
  const h: any = res.headers as any;
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  const joined = all.join(', ');
  const found = joined.match(/el_(?:access|refresh)=[^;,\s]+/g) ?? [];
  assert(found.length >= 2, `expected auth cookies, got ${joined}`);
  return found.join('; ');
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
  const manifest = await startManifest();
  const smtp = await startSmtp();
  const port = await freePort();
  const dbPath = resolve(root, 'server', 'data', `about-test-${Date.now()}.db`);
  const base = `http://127.0.0.1:${port}`;
  let diagnosticLogPath: string | null = null;
  Object.assign(process.env, {
    PORT: String(port),
    DB_PATH: dbPath,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_FROM: 'no-reply@test.local',
    AUTH_TOKEN_SECRET: 'about-token-secret',
    AUTH_IDENTIFIER_SECRET: 'about-identifier-secret',
    APP_UPDATE_MANIFEST_URL: manifest.url,
    APP_CONTACT_EMAIL: 'help@example.com',
    APP_FEEDBACK_URL: 'https://example.com/feedback',
    APP_SUPPORT_TEXT: '工作日 10:00-18:00 回复',
    EFFICIENCY_LIST_NO_LISTEN: '1',
  });
  const mod = await import(pathToFileURL(resolve(root, 'server', 'src', 'index.ts')).href);
  const server: Server = await new Promise((resolvePromise) => {
    const s = mod.app.listen(port, '127.0.0.1', () => resolvePromise(s));
  });
  try {
    await waitForHealth(base);
    const terms = await fetch(`${base}/api/about/legal/terms`);
    assert(terms.status === 200, `terms should be 200, got ${terms.status}`);
    assert((await terms.text()).includes('效率清单用户协议'), 'terms body should include title');

    const privacy = await fetch(`${base}/api/about/legal/privacy`);
    assert(privacy.status === 200, `privacy should be 200, got ${privacy.status}`);
    assert((await privacy.text()).includes('效率清单隐私政策'), 'privacy body should include title');

    const update = await fetch(`${base}/api/about/update-check?currentVersion=0.1.0`);
    const body = await json(update);
    assert(update.status === 200, `update check should be 200, got ${update.status}`);
    assert(body.updateAvailable === true, 'update should be available for 9.9.9 manifest');
    assert(body.latestVersion === '9.9.9', 'latestVersion should come from manifest');

    const contact = await fetch(`${base}/api/about/contact`);
    const contactBody = await json(contact);
    assert(contact.status === 200, `contact should be 200, got ${contact.status}`);
    assert(contactBody.contactEmail === 'help@example.com', 'contact email should come from configured env');
    assert(contactBody.feedbackUrl === 'https://example.com/feedback', 'feedback URL should come from configured env');
    assert(contactBody.supportText === '工作日 10:00-18:00 回复', 'support text should come from configured env');

    const savedContact = {
      APP_CONTACT_EMAIL: process.env.APP_CONTACT_EMAIL,
      APP_FEEDBACK_URL: process.env.APP_FEEDBACK_URL,
      APP_SUPPORT_TEXT: process.env.APP_SUPPORT_TEXT,
      AUTH_RISK_SUPPORT_CONTACT: process.env.AUTH_RISK_SUPPORT_CONTACT,
    };
    delete process.env.APP_CONTACT_EMAIL;
    delete process.env.APP_FEEDBACK_URL;
    delete process.env.APP_SUPPORT_TEXT;
    delete process.env.AUTH_RISK_SUPPORT_CONTACT;
    const missingContact = await fetch(`${base}/api/about/contact`);
    const missingBody = await json(missingContact);
    assert(missingContact.status === 501, `missing contact config should be 501, got ${missingContact.status}`);
    assert(missingBody.error.code === 'about_contact_not_configured', 'missing contact config should return about_contact_not_configured');
    for (const [key, value] of Object.entries(savedContact)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }

    const licenses = await fetch(`${base}/api/about/licenses`);
    const licensesBody = await json(licenses);
    assert(licenses.status === 200, `licenses should be 200, got ${licenses.status}`);
    assert(licensesBody.source === 'package-lock.json', 'licenses should come from package-lock.json');
    assert(licensesBody.packageCount === licensesBody.packages.length, 'license packageCount should match package array length');
    assert(licensesBody.packages.length > 0, 'licenses should include installed packages');
    assert(
      licensesBody.packages.some((pkg: any) => pkg.name === 'express' && typeof pkg.version === 'string' && pkg.license === 'MIT'),
      'licenses should include the real Express license from package-lock',
    );
    assert(
      licensesBody.packages.some((pkg: any) => pkg.name === 'react' && typeof pkg.version === 'string' && pkg.license === 'MIT'),
      'licenses should include the real React license from package-lock',
    );

    const unauthDiagnostic = await req(base, '/api/about/diagnostic-logs', {
      method: 'POST',
      body: JSON.stringify({ consent: true, entries: [{ message: 'should require login' }] }),
    });
    assert(unauthDiagnostic.res.status === 401, `unauthenticated diagnostic upload should be 401, got ${unauthDiagnostic.res.status}`);

    const cookie = await login(base, 'about-diagnostics@example.com', smtp.messages);
    const missingConsent = await req(base, '/api/about/diagnostic-logs', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ consent: false, entries: [{ message: 'missing consent' }] }),
    });
    assert(missingConsent.res.status === 400, `diagnostic upload without consent should be 400, got ${missingConsent.res.status}`);
    assert(missingConsent.body.error.code === 'diagnostic_consent_required', 'diagnostic upload should require explicit consent');

    const diagnostic = await req(base, '/api/about/diagnostic-logs', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        consent: true,
        clientContext: {
          userAgent: 'test-agent token=secret-token',
          email: 'about-diagnostics@example.com',
          phone: '+15550001111',
        },
        entries: [
          {
            level: 'error',
            message: 'login failed for about-diagnostics@example.com code 123456 token=secret-token phone +15550001111',
            occurredAt: new Date().toISOString(),
            context: { accessToken: 'secret-token', nested: { safe: 'kept' } },
          },
        ],
      }),
    });
    assert(diagnostic.res.status === 201, `diagnostic upload should be 201, got ${diagnostic.res.status}`);
    assert(diagnostic.body.upload.entryCount === 1, 'diagnostic upload should report one entry');

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT * FROM diagnostic_log_uploads WHERE id = ?').get(diagnostic.body.upload.id) as
        | { user_id: string; log_path: string; summary_json: string; size_bytes: number }
        | undefined;
      assert(row, 'diagnostic upload row should exist in SQLite');
      diagnosticLogPath = row.log_path;
      assert(row.size_bytes > 0, 'diagnostic upload should record size bytes');
      const summary = JSON.parse(row.summary_json);
      assert(summary.entryCount === 1, 'diagnostic upload summary should record entry count');
      const stored = readFileSync(row.log_path, 'utf8');
      assert(stored.includes('[redacted_email]'), 'diagnostic file should redact email');
      assert(stored.includes('[redacted_phone]'), 'diagnostic file should redact phone');
      assert(stored.includes('[redacted_code]'), 'diagnostic file should redact verification code');
      assert(stored.includes('[redacted_secret]'), 'diagnostic file should redact secrets');
      assert(!stored.includes('about-diagnostics@example.com'), 'raw email leaked into diagnostic file');
      assert(!stored.includes('+15550001111'), 'raw phone leaked into diagnostic file');
      assert(!stored.includes('123456'), 'raw verification code leaked into diagnostic file');
      assert(!stored.includes('secret-token'), 'raw token leaked into diagnostic file');
      assert(stored.includes('"safe": "kept"'), 'safe diagnostic context should be preserved');
    } finally {
      db.close();
    }
  } finally {
    await new Promise((resolvePromise) => server.close(() => resolvePromise(null)));
    const dbModule = await import(pathToFileURL(resolve(root, 'server', 'src', 'db.ts')).href);
    dbModule.db.close();
    await manifest.close();
    await smtp.close();
    if (diagnosticLogPath && existsSync(diagnosticLogPath)) unlinkSync(diagnosticLogPath);
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

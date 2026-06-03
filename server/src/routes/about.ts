import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { AppError } from '../types';
import { requireAuth } from '../authMiddleware';
import { db, nowISO } from '../db';

const router = Router();
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const legalDir = process.env.LEGAL_DOCS_DIR ?? resolve(root, 'docs/legal');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version?: string };
const MAX_DIAGNOSTIC_ENTRIES = 100;
const MAX_DIAGNOSTIC_BYTES = 96 * 1024;

const DOCS: Record<string, { file: string; title: string }> = {
  terms: { file: 'terms.md', title: '用户协议' },
  privacy: { file: 'privacy.md', title: '隐私政策' },
};

interface LockPackage {
  version?: string;
  license?: string | { type?: string };
  dev?: boolean;
  optional?: boolean;
  resolved?: string;
}

function packageNameFromPath(path: string): string | null {
  const marker = 'node_modules/';
  const idx = path.lastIndexOf(marker);
  if (idx < 0) return null;
  const rest = path.slice(idx + marker.length);
  const parts = rest.split('/');
  return rest.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? null;
}

function licenseValue(pkg: LockPackage): string | null {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') return pkg.license.type;
  return null;
}

function licenseList(): {
  source: 'package-lock.json';
  generatedAt: string;
  packageCount: number;
  packages: Array<{ name: string; version: string; license: string | null; dev: boolean; optional: boolean; resolved: string | null }>;
} {
  let lock: { packages?: Record<string, LockPackage> };
  try {
    lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as { packages?: Record<string, LockPackage> };
  } catch {
    throw new AppError(502, 'about_licenses_unavailable', 'package lock could not be read');
  }
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new AppError(502, 'about_licenses_unavailable', 'package lock does not include packages');
  }
  const byPackage = new Map<string, { name: string; version: string; license: string | null; dev: boolean; optional: boolean; resolved: string | null }>();
  for (const [path, pkg] of Object.entries(lock.packages)) {
    const name = packageNameFromPath(path);
    if (!name || typeof pkg.version !== 'string') continue;
    const key = `${name}@${pkg.version}`;
    if (!byPackage.has(key)) {
      byPackage.set(key, {
        name,
        version: pkg.version,
        license: licenseValue(pkg),
        dev: !!pkg.dev,
        optional: !!pkg.optional,
        resolved: typeof pkg.resolved === 'string' ? pkg.resolved : null,
      });
    }
  }
  const packages = [...byPackage.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return { source: 'package-lock.json', generatedAt: new Date().toISOString(), packageCount: packages.length, packages };
}

function diagnosticDir(): string {
  return process.env.DIAGNOSTIC_LOG_DIR?.trim() || resolve(root, 'server/data/diagnostic-logs');
}

function scrubString(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted_email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted_phone]')
    .replace(/\b\d{6}\b/g, '[redacted_code]')
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization|refresh[_-]?token|access[_-]?token)(\s*[:=]\s*|\s+)(["']?)[^"',\s}]+/gi,
      '$1$2$3[redacted_secret]',
    );
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value).slice(0, 4000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map(scrubValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (/token|secret|password|api[_-]?key|authorization|credential/i.test(key)) out[key] = '[redacted_secret]';
      else out[key.slice(0, 80)] = scrubValue(raw);
    }
    return out;
  }
  return String(value);
}

function diagnosticEntries(raw: unknown): Array<{ level: string; message: string; occurredAt: string | null; context: unknown }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, 'invalid_diagnostic_log', 'at least one diagnostic log entry is required');
  }
  return raw.slice(0, MAX_DIAGNOSTIC_ENTRIES).map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new AppError(400, 'invalid_diagnostic_log', `entry ${index} must be an object`);
    const record = entry as Record<string, unknown>;
    const message = typeof record.message === 'string' ? scrubString(record.message.trim()).slice(0, 2000) : '';
    if (!message) throw new AppError(400, 'invalid_diagnostic_log', `entry ${index} message is required`);
    const level = typeof record.level === 'string' && record.level.trim() ? record.level.trim().slice(0, 24) : 'info';
    const occurredAt = typeof record.occurredAt === 'string' && !Number.isNaN(Date.parse(record.occurredAt)) ? record.occurredAt : null;
    return { level, message, occurredAt, context: scrubValue(record.context ?? {}) };
  });
}

function createDiagnosticLogUpload(userId: string, body: unknown): { id: string; filename: string; sizeBytes: number; uploadedAt: string; entryCount: number } {
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (input.consent !== true) throw new AppError(400, 'diagnostic_consent_required', 'diagnostic log upload requires explicit consent');
  const entries = diagnosticEntries(input.entries);
  const clientContext = scrubValue(input.clientContext ?? {});
  const id = randomUUID();
  const uploadedAt = nowISO();
  const payload = {
    id,
    uploadedAt,
    clientContext,
    entries,
  };
  const serialized = JSON.stringify(payload, null, 2);
  const sizeBytes = Buffer.byteLength(serialized, 'utf8');
  if (sizeBytes > MAX_DIAGNOSTIC_BYTES) throw new AppError(413, 'diagnostic_log_too_large', 'diagnostic log payload is too large');
  const dir = diagnosticDir();
  mkdirSync(dir, { recursive: true });
  const filename = `${uploadedAt.replace(/[:.]/g, '-')}-${id}.json`;
  const logPath = resolve(dir, filename);
  writeFileSync(logPath, serialized, 'utf8');
  const summary = {
    entryCount: entries.length,
    firstMessage: entries[0]?.message ?? null,
    clientContextKeys: clientContext && typeof clientContext === 'object' && !Array.isArray(clientContext) ? Object.keys(clientContext as Record<string, unknown>) : [],
  };
  db.prepare(
    `INSERT INTO diagnostic_log_uploads (id, user_id, filename, log_path, summary_json, size_bytes, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, filename, logPath, JSON.stringify(summary), sizeBytes, uploadedAt);
  return { id, filename, sizeBytes, uploadedAt, entryCount: entries.length };
}

function contactConfig(): { contactEmail: string | null; feedbackUrl: string | null; supportText: string | null } {
  const contactEmail = process.env.APP_CONTACT_EMAIL?.trim() || process.env.AUTH_RISK_SUPPORT_CONTACT?.trim() || null;
  const feedbackUrl = process.env.APP_FEEDBACK_URL?.trim() || null;
  const supportText = process.env.APP_SUPPORT_TEXT?.trim() || null;
  if (!contactEmail && !feedbackUrl && !supportText) {
    throw new AppError(501, 'about_contact_not_configured', 'contact and feedback channels are not configured');
  }
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new AppError(502, 'invalid_about_contact', 'contact email is invalid');
  }
  if (feedbackUrl) {
    try {
      const parsed = new URL(feedbackUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') throw new Error('invalid protocol');
    } catch {
      throw new AppError(502, 'invalid_about_contact', 'feedback URL is invalid');
    }
  }
  return { contactEmail, feedbackUrl, supportText };
}

function compareVersion(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

router.get('/legal/:doc', (req, res) => {
  const spec = DOCS[req.params.doc];
  if (!spec) throw new AppError(404, 'not_found', 'legal document not found');
  const body = readFileSync(resolve(legalDir, spec.file), 'utf8');
  res.type('text/markdown').send(body);
});

router.get('/update-check', async (req, res) => {
  const manifestUrl = process.env.APP_UPDATE_MANIFEST_URL;
  if (!manifestUrl) throw new AppError(501, 'update_manifest_not_configured', 'update manifest URL is not configured');
  const currentVersion = typeof req.query.currentVersion === 'string' ? req.query.currentVersion : packageJson.version ?? '0.0.0';
  let manifest: any;
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    manifest = await response.json();
  } catch (err) {
    throw new AppError(502, 'update_manifest_unreachable', err instanceof Error ? err.message : 'update manifest is unreachable');
  }
  if (!manifest || typeof manifest.latestVersion !== 'string') {
    throw new AppError(502, 'invalid_update_manifest', 'update manifest must include latestVersion');
  }
  res.json({
    currentVersion,
    latestVersion: manifest.latestVersion,
    updateAvailable: compareVersion(manifest.latestVersion, currentVersion) > 0,
    downloadUrl: typeof manifest.downloadUrl === 'string' ? manifest.downloadUrl : null,
    releaseNotes: typeof manifest.releaseNotes === 'string' ? manifest.releaseNotes : null,
    checkedAt: new Date().toISOString(),
  });
});

router.get('/contact', (_req, res) => {
  res.json(contactConfig());
});

router.get('/licenses', (_req, res) => {
  res.json(licenseList());
});

router.post('/diagnostic-logs', requireAuth, (req, res) => {
  const upload = createDiagnosticLogUpload(req.auth!.userId, req.body ?? {});
  res.status(201).json({ upload });
});

export default router;

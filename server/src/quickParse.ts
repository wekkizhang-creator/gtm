import { AppError, type Priority, type QuickParseResultDTO, type QuickParseTokenDTO } from './types';

export interface QuickParseOptions {
  dateRecognition?: boolean;
  removeDateText?: boolean;
  tagRecognition?: boolean;
  removeTagText?: boolean;
  urlParsing?: boolean;
}

const DEFAULT_OPTIONS: Required<QuickParseOptions> = {
  dateRecognition: true,
  removeDateText: false,
  tagRecognition: true,
  removeTagText: true,
  urlParsing: true,
};

const TITLE_FETCH_TIMEOUT_MS = 5000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function dateAtOffset(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function applyTime(base: Date, hh: number, mm: number): Date {
  const d = new Date(base);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function isoDate(y: number, m: number, d: number): Date {
  const out = new Date(y, m - 1, d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function standaloneHttpUrl(text: string): URL | null {
  const trimmed = text.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function decodeTitle(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPageTitle(url: URL): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'EfficiencyList/0.1 URL title resolver',
      },
    });
  } catch (err) {
    throw new AppError(502, 'url_title_fetch_failed', err instanceof Error ? err.message : 'failed to fetch URL title');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new AppError(502, 'url_title_fetch_failed', `URL returned HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !/(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    throw new AppError(415, 'url_title_unsupported_content', 'URL did not return an HTML document');
  }
  const html = await response.text();
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? decodeTitle(match[1].replace(/<[^>]*>/g, ' ')) : '';
  if (!title) throw new AppError(422, 'url_title_missing', 'URL page title was not found');
  return title.slice(0, 240);
}

function normalizeChineseTime(rawPeriod: string | undefined, rawHour: string, rawMinute: string | undefined, half: string | undefined): { hh: number; mm: number } | null {
  const period = rawPeriod ?? '';
  let hh = Number(rawHour);
  if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
  let mm = half ? 30 : rawMinute == null ? 0 : Number(rawMinute);
  if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
  if ((period === '下午' || period === '晚上') && hh < 12) hh += 12;
  if (period === '上午' && hh === 12) hh = 0;
  if (period === '中午' && hh < 11) hh += 12;
  return { hh, mm };
}

function cleanTitle(text: string, options: Required<QuickParseOptions>): string {
  let out = text
    .replace(/!(?:[0-3]|高|中|低)/g, ' ')
    .replace(/\b(?:p[0-3]|priority:[0-3])\b/gi, ' ')
    .replace(/\b\d+(?:m|min|分钟|h|小时)\b/gi, ' ')
    .replace(/每天|每日|每周|每月|每年|daily|weekly|monthly|yearly/gi, ' ');
  if (options.tagRecognition && options.removeTagText) out = out.replace(/#[\p{L}\p{N}_-]+/gu, ' ');
  if (options.dateRecognition && options.removeDateText) {
    out = out
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, ' ')
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(/(?:上午|下午|晚上|中午|早上)?\s*\d{1,2}点(?:半|[0-5]?\d分?)?/g, ' ')
      .replace(/今天|明天|后天/gi, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function quickParseTask(text: string, rawOptions: QuickParseOptions = {}): QuickParseResultDTO {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const raw = text.trim();
  const tokens: QuickParseTokenDTO[] = [];
  let dueBase: Date | null = null;
  let time: { hh: number; mm: number } | null = null;
  let priority: Priority = 0;
  let estimatedMinutes: number | null = null;
  let recurrenceRule: string | null = null;
  const tags: string[] = [];

  const add = (type: QuickParseTokenDTO['type'], tokenRaw: string, value: string | number) => tokens.push({ type, raw: tokenRaw, value });

  if (options.tagRecognition) {
    for (const match of raw.matchAll(/#[\p{L}\p{N}_-]+/gu)) {
      const tag = match[0].slice(1);
      tags.push(tag);
      add('tag', match[0], tag);
    }
  }

  if (options.dateRecognition) {
    const dateWords: Array<[RegExp, number, string]> = [
      [/今天/, 0, 'today'],
      [/明天/, 1, 'tomorrow'],
      [/后天/, 2, 'day_after_tomorrow'],
    ];
    for (const [re, offset, value] of dateWords) {
      const m = raw.match(re);
      if (m) {
        dueBase = dateAtOffset(offset);
        add('date', m[0], value);
        break;
      }
    }
    const dateMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (dateMatch) {
      dueBase = isoDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
      add('date', dateMatch[0], `${dateMatch[1]}-${pad(Number(dateMatch[2]))}-${pad(Number(dateMatch[3]))}`);
    }

    const timeMatch = raw.match(/\b(\d{1,2}):(\d{2})\b/);
    if (timeMatch) {
      const parsed = { hh: Number(timeMatch[1]), mm: Number(timeMatch[2]) };
      if (parsed.hh >= 0 && parsed.hh <= 23 && parsed.mm >= 0 && parsed.mm <= 59) {
        time = parsed;
        add('time', timeMatch[0], `${pad(time.hh)}:${pad(time.mm)}`);
      }
    } else {
      const chineseTimeMatch = raw.match(/(上午|下午|晚上|中午|早上)?\s*(\d{1,2})点(?:(半)|([0-5]?\d)分?)?/);
      if (chineseTimeMatch) {
        const parsed = normalizeChineseTime(chineseTimeMatch[1], chineseTimeMatch[2], chineseTimeMatch[4], chineseTimeMatch[3]);
        if (parsed) {
          time = parsed;
          add('time', chineseTimeMatch[0], `${pad(time.hh)}:${pad(time.mm)}`);
        }
      }
    }
  }

  const priMatch = raw.match(/!(0|1|2|3|高|中|低)|\b(?:p|priority:)([0-3])\b/i);
  if (priMatch) {
    const value = priMatch[1] ?? priMatch[2];
    priority = value === '高' ? 3 : value === '中' ? 2 : value === '低' ? 1 : (Number(value) as Priority);
    add('priority', priMatch[0], priority);
  }

  const estMatch = raw.match(/\b(\d+)(m|min|分钟|h|小时)\b/i);
  if (estMatch) {
    const value = Number(estMatch[1]);
    estimatedMinutes = /^(h|小时)$/i.test(estMatch[2]) ? value * 60 : value;
    add('estimate', estMatch[0], estimatedMinutes);
  }

  const recurrence: Array<[RegExp, string]> = [
    [/(每天|每日|daily)/i, 'FREQ=DAILY'],
    [/(每周|weekly)/i, 'FREQ=WEEKLY'],
    [/(每月|monthly)/i, 'FREQ=MONTHLY'],
    [/(每年|yearly)/i, 'FREQ=YEARLY'],
  ];
  for (const [re, rule] of recurrence) {
    const m = raw.match(re);
    if (m) {
      recurrenceRule = rule;
      add('recurrence', m[0], rule);
      break;
    }
  }

  const base = dueBase ?? null;
  const due = base && time ? applyTime(base, time.hh, time.mm) : base;
  const title = cleanTitle(raw, options) || raw;
  add('text', title, title);

  return {
    tokens,
    draft: {
      title,
      dueDate: due ? due.toISOString() : null,
      startDate: due && time ? due.toISOString() : null,
      isAllDay: !time,
      priority,
      estimatedMinutes,
      recurrenceRule,
      note: null,
      tags,
    },
  };
}

export async function quickParseTaskWithUrlTitle(text: string, rawOptions: QuickParseOptions = {}): Promise<QuickParseResultDTO> {
  const options = { ...DEFAULT_OPTIONS, ...rawOptions };
  const result = quickParseTask(text, options);
  const url = options.urlParsing ? standaloneHttpUrl(text) : null;
  if (!url) return result;
  const title = await fetchPageTitle(url);
  result.tokens.unshift({ type: 'url', raw: text.trim(), value: url.href });
  const textToken = result.tokens.find((token) => token.type === 'text');
  if (textToken) {
    textToken.raw = title;
    textToken.value = title;
  }
  result.draft.title = title;
  result.draft.note = url.href;
  return result;
}

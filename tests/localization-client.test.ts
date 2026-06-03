import { hm, localDateLabel, setLocale, setTimeFormat, setTimeZone } from '../client/src/calendarUtil';
import { resolveLanguage } from '../client/src/settings';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(resolveLanguage('system', 'zh-Hans-CN') === 'zh-CN', 'system Chinese language should resolve to zh-CN');
  assert(resolveLanguage('system', 'en-GB') === 'en-US', 'non-Chinese system language should resolve to en-US');
  assert(resolveLanguage('zh-CN', 'en-US') === 'zh-CN', 'explicit zh-CN should win over runtime language');
  assert(resolveLanguage('en-US', 'zh-CN') === 'en-US', 'explicit en-US should win over runtime language');

  setLocale('en-US');
  setTimeFormat('12');
  setTimeZone('system', null);
  assert(hm('2026-06-02T15:05:00.000Z').includes('PM'), 'en-US 12-hour time should include PM');
  const englishDate = localDateLabel(new Date(2026, 5, 2), { month: 'short', day: 'numeric' });
  assert(/Jun|June/.test(englishDate), `English date label should use English month, got ${englishDate}`);

  setLocale('zh-CN');
  setTimeFormat('24');
  setTimeZone('manual', 'Asia/Shanghai');
  assert(hm('2026-06-02T15:05:00.000Z') === '23:05', `manual Asia/Shanghai time should render 23:05, got ${hm('2026-06-02T15:05:00.000Z')}`);
  setTimeZone('manual', 'America/New_York');
  assert(hm('2026-06-02T15:05:00.000Z') === '11:05', `manual America/New_York time should render 11:05, got ${hm('2026-06-02T15:05:00.000Z')}`);
  setTimeZone('system', null);
  assert(!hm('2026-06-02T15:05:00.000Z').includes('PM'), 'zh-CN 24-hour time should not include PM');
  const chineseDate = localDateLabel(new Date(2026, 5, 2), { month: 'short', day: 'numeric' });
  assert(chineseDate.includes('6') || chineseDate.includes('六月'), `Chinese date label should use Chinese-style month, got ${chineseDate}`);
}

main();

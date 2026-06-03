import { aiConfigurationIssue } from '../client/src/aiGuide';
import type { Settings } from '../client/src/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const configured: Settings['ai'] = {
  enabled: true,
  provider: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:9999/v1',
  model: 'test-model',
  hasApiKey: true,
  apiKeyMasked: '********1234',
};

function main() {
  const disabled = aiConfigurationIssue({ ...configured, enabled: false }, 'AI 拆解');
  assert(disabled?.includes('启用 AI 能力'), 'disabled AI should guide user to enable AI');
  assert(disabled?.includes('AI 拆解'), 'disabled guide should include action label');

  const missing = aiConfigurationIssue({ ...configured, baseUrl: '', model: '', hasApiKey: false }, 'AI 排期');
  assert(missing?.includes('接口地址'), 'missing base URL should be called out');
  assert(missing?.includes('模型'), 'missing model should be called out');
  assert(missing?.includes('API Key'), 'missing API key should be called out');
  assert(missing?.includes('AI 排期'), 'missing-config guide should include action label');

  const ok = aiConfigurationIssue(configured, 'AI 复盘');
  assert(ok === null, `fully configured AI should not block, got ${ok}`);
}

main();

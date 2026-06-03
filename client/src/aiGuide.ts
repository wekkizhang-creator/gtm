import type { Settings } from './types';

export function aiConfigurationIssue(ai: Settings['ai'], actionLabel = 'AI 能力'): string | null {
  if (!ai.enabled) {
    return `${actionLabel}需要先在设置 > AI 设置中启用 AI 能力并保存模型服务商与 API Key。`;
  }
  const missing: string[] = [];
  if (!ai.baseUrl.trim()) missing.push('接口地址');
  if (!ai.model.trim()) missing.push('模型');
  if (!ai.hasApiKey) missing.push('API Key');
  if (missing.length) {
    return `${actionLabel}需要先在设置 > AI 设置中补全${missing.join('、')}，保存后再试。`;
  }
  return null;
}

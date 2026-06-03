import { AppError } from './types';

interface SmsConfig {
  url: string;
  token: string | null;
  header: string;
  from: string | null;
}

function config(): SmsConfig | null {
  const url = process.env.SMS_PROVIDER_URL;
  if (!url) return null;
  return {
    url,
    token: process.env.SMS_PROVIDER_TOKEN ?? null,
    header: process.env.SMS_PROVIDER_AUTH_HEADER ?? 'Authorization',
    from: process.env.SMS_FROM ?? null,
  };
}

export async function sendVerificationSms(to: string, code: string, purpose = 'login'): Promise<void> {
  const c = config();
  if (!c) throw new AppError(501, 'auth_delivery_not_configured', 'SMS delivery is not configured');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.token) headers[c.header] = c.header.toLowerCase() === 'authorization' ? `Bearer ${c.token}` : c.token;
  const res = await fetch(c.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      to,
      from: c.from,
      purpose,
      code,
      message: `Your Efficiency List verification code is ${code}. It expires in 10 minutes.`,
    }),
  });
  if (!res.ok) throw new AppError(502, 'sms_delivery_failed', `SMS provider returned HTTP ${res.status}`);
}

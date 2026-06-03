import { api, type AnalyticsEventInput } from './api/client';

const DEVICE_KEY = 'efficiency-list.deviceId';
const ANON_KEY = 'efficiency-list.anonymousId';

function idFor(key: string, prefix: string): string {
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

export function getDeviceId(): string {
  return idFor(DEVICE_KEY, 'device');
}

function getAnonymousId(): string {
  return idFor(ANON_KEY, 'anon');
}

export function trackEvent(name: string, properties: Record<string, unknown> = {}): void {
  const event: AnalyticsEventInput = {
    name,
    properties,
    occurredAt: new Date().toISOString(),
    anonymousId: getAnonymousId(),
    deviceId: getDeviceId(),
    source: 'web',
  };
  void api.trackAnalyticsEvents([event]).catch(() => {
    // Analytics must never block the user's workflow.
  });
}

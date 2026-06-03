import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api/client';
import { setLocale, setTimeFormat, setTimeZone } from './calendarUtil';
import { DEFAULT_MODULE_ORDER } from './moduleOrder';
import type { Settings, SettingsPatch } from './types';

export const DEFAULT_SETTINGS: Settings = {
  account: {},
  notifications: {
    enabled: true,
    email: true,
    desktop: false,
    doNotDisturb: false,
    doNotDisturbStart: '22:00',
    doNotDisturbEnd: '08:00',
    reminderSound: 'default',
    reminderSoundId: null,
    detailVisibility: 'when_unlocked',
    completionSound: 'ding',
    completionSoundId: null,
    reminderVolume: 70,
    taskReminders: true,
    habitReminders: true,
    focusReminders: true,
    goalReminders: true,
  },
  focus: {
    defaultMinutes: 25,
    restMinutes: 5,
    longRestMinutes: 15,
    longRestInterval: 4,
    soundId: null,
    defaultVolume: 50,
    pauseSoundOnPause: true,
    playSoundDuringRest: false,
    backgroundAudioAllowed: true,
    autoCacheSounds: false,
    fadeOutStop: true,
  },
  quickAdd: {
    defaultListId: null,
    parseEnabled: true,
    dateRecognition: true,
    removeDateText: false,
    tagRecognition: true,
    removeTagText: true,
    urlParsing: true,
  },
  miniCalendar: { enabled: true, showLunar: 'follow', showWeekNumbers: false },
  imports: { lastSource: null },
  calendar: { view: '3day' },
  notes: {
    enabled: true,
    defaultColor: '#fff2a8',
    defaultOpacity: 95,
    defaultFontSize: 'normal',
    defaultPinned: false,
    defaultPosition: { x: 40, y: 40, width: 300, height: 220 },
  },
  widgets: { enabled: false },
  shortcuts: { enabled: false },
  desktop: { startup: false, tray: false, appLock: false },
  localization: { language: 'system' },
  appearance: {
    themeMode: 'system',
    accent: '#c96442',
    fontSize: 'normal',
    density: 'standard',
    animations: true,
    sidebarBackground: { type: 'default', color: '#f0eee6', imageUrl: null },
    appOpacity: 100,
  },
  datetime: { weekStart: 1, timeFormat: 'system', showLunar: true, showHolidayAdjustments: true, timeZoneMode: 'system', timeZone: null },
  modules: { hidden: [], defaultLaunch: 'tasks', order: DEFAULT_MODULE_ORDER },
  smartLists: { hidden: [] },
  taskDefaults: {
    priority: 0,
    listId: null,
    defaultDate: 'none',
    customDate: null,
    dateMode: 'date',
    defaultTimeBlockMinutes: 30,
    defaultTimeBlockStart: '09:00',
    timedReminder: '30m_before',
    timedReminderCustomMinutes: 30,
    allDayReminder: '1d_before',
    allDayReminderTime: '09:00',
    defaultTagIds: [],
    addPosition: 'top',
    overduePosition: 'top',
  },
  ai: { enabled: false, provider: '', baseUrl: '', model: '', hasApiKey: false, apiKeyMasked: '' },
};

interface Ctx {
  settings: Settings;
  loaded: boolean;
  update: (patch: SettingsPatch) => Promise<void>;
  reset: (group: string) => Promise<void>;
  reload: () => Promise<void>;
}

const SettingsCtx = createContext<Ctx>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  update: async () => {},
  reset: async () => {},
  reload: async () => {},
});

export const useSettings = () => useContext(SettingsCtx);

// ---- color helpers (derive accent-dark / accent-soft from a single accent) ----
function hexToRgb(h: string): [number, number, number] {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function shade(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = 1 + pct / 100;
  return rgbToHex(r * f, g * f, b * f);
}
function tint(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}
function mix(c1: string, c2: string, amt: number): string {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  return rgbToHex(r1 + (r2 - r1) * amt, g1 + (g2 - g1) * amt, b1 + (b2 - b1) * amt);
}

function cssUrl(value: string): string {
  return `url("${value.replace(/["\\\n\r\f]/g, '\\$&')}")`;
}

function applyAppearance(a: Settings['appearance']) {
  const root = document.documentElement;
  const mode = a.themeMode === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : a.themeMode;
  root.dataset.theme = mode;
  root.dataset.fontSize = a.fontSize;
  root.dataset.density = a.density;
  root.dataset.animations = a.animations ? 'on' : 'off';
  const sidebarBackground = { ...DEFAULT_SETTINGS.appearance.sidebarBackground, ...(a.sidebarBackground ?? {}) };
  const appOpacity = Number.isInteger(a.appOpacity) ? Math.max(0, Math.min(100, a.appOpacity)) : 100;
  root.dataset.sidebarBackground = sidebarBackground.type;
  root.style.setProperty('--app-opacity', String(appOpacity / 100));
  root.style.setProperty('--sidebar-background', sidebarBackground.type === 'color' ? sidebarBackground.color : 'var(--cream)');
  root.style.setProperty(
    '--sidebar-background-image',
    sidebarBackground.type === 'image' && sidebarBackground.imageUrl
      ? `linear-gradient(rgba(250, 249, 244, 0.72), rgba(250, 249, 244, 0.82)), ${cssUrl(sidebarBackground.imageUrl)}`
      : 'none',
  );
  root.style.setProperty('--accent', a.accent);
  root.style.setProperty('--accent-dark', shade(a.accent, -16));
  root.style.setProperty('--accent-soft', mode === 'dark' ? mix(a.accent, '#1f1e1c', 0.76) : tint(a.accent, 0.86));
  root.style.setProperty('--teal', a.accent);
  root.style.setProperty('--teal-dark', shade(a.accent, -16));
}

export function resolveLanguage(language: Settings['localization']['language'], runtimeLanguage = navigator.language): 'zh-CN' | 'en-US' {
  if (language === 'zh-CN' || language === 'en-US') return language;
  return runtimeLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function applyLocalization(l: Settings['localization']) {
  const resolved = resolveLanguage(l.language);
  document.documentElement.lang = resolved;
  document.documentElement.dataset.locale = resolved;
  setLocale(resolved);
}

function mergeLocal(prev: Settings, patch: SettingsPatch): Settings {
  const out: Settings = JSON.parse(JSON.stringify(prev));
  for (const g of Object.keys(patch) as (keyof SettingsPatch)[]) {
    const group = patch[g] as Record<string, unknown>;
    Object.assign((out as Record<string, any>)[g], group);
  }
  // never keep a raw key in client state
  delete (out.ai as Record<string, unknown>).apiKey;
  return out;
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  const apply = (s: Settings) => {
    applyAppearance(s.appearance);
    applyLocalization(s.localization);
    setTimeFormat(s.datetime.timeFormat);
    setTimeZone(s.datetime.timeZoneMode, s.datetime.timeZone);
  };

  const reload = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      apply(s);
    } catch {
      /* keep defaults */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // re-apply appearance whenever it changes; also react to OS theme when in "system"
  useEffect(() => {
    apply(settings);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => settings.appearance.themeMode === 'system' && applyAppearance(settings.appearance);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings]);

  const update = useCallback(
    async (patch: SettingsPatch) => {
      setSettings((prev) => mergeLocal(prev, patch)); // optimistic
      try {
        const s = await api.patchSettings(patch);
        setSettings(s);
        apply(s);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const reset = useCallback(async (group: string) => {
    try {
      const s = await api.resetSettings(group);
      setSettings(s);
      apply(s);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <SettingsCtx.Provider value={{ settings, loaded, update, reset, reload }}>{children}</SettingsCtx.Provider>
  );
}

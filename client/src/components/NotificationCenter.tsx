import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { notificationDisplayContent } from '../notificationPrivacy';
import { playNotificationSound } from '../notificationSound';
import { useSettings } from '../settings';
import type { Notification } from '../types';

export default function NotificationCenter({ locked = false }: { locked?: boolean }) {
  const { settings } = useSettings();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState<string | null>(null);
  const soundReadyRef = useRef(false);
  const previousUnreadRef = useRef(0);

  async function reload() {
    try {
      const [, list] = await Promise.all([api.runReminderTick(), api.listNotifications()]);
      setItems(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  async function mutate(fn: () => Promise<unknown>) {
    try {
      await fn();
      await reload();
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const unread = items.filter((n) => !n.readAt).length;

  useEffect(() => {
    if (!soundReadyRef.current) {
      soundReadyRef.current = true;
      previousUnreadRef.current = unread;
      return;
    }
    if (unread > previousUnreadRef.current) void playNotificationSound(settings.notifications);
    previousUnreadRef.current = unread;
  }, [
    unread,
    settings.notifications.completionSound,
    settings.notifications.completionSoundId,
    settings.notifications.reminderSound,
    settings.notifications.reminderSoundId,
    settings.notifications.reminderVolume,
  ]);

  return (
    <div className="notif">
      <button className="notif-button" onClick={() => setOpen((v) => !v)} title="通知">
        🔔
        {unread > 0 && <span>{unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>通知</strong>
            <button onClick={() => void reload()}>刷新</button>
          </div>
          {error && <div className="notif-error">{error}</div>}
          <ul>
            {items.map((item) => {
              const display = notificationDisplayContent(item, settings.notifications.detailVisibility ?? 'when_unlocked', locked);
              return (
              <li key={item.id} className={`${item.readAt ? 'is-read' : ''}${display.detailsHidden ? ' is-private' : ''}`}>
                <div>
                  <strong>{display.title}</strong>
                  {display.body && <p>{display.body}</p>}
                </div>
                <div className="notif-actions">
                  {!item.readAt && <button onClick={() => void mutate(() => api.markNotificationRead(item.id))}>已读</button>}
                  <button
                    onClick={() =>
                      void mutate(() => api.snoozeNotification(item.id, new Date(Date.now() + 10 * 60_000).toISOString()))
                    }
                  >
                    稍后
                  </button>
                </div>
              </li>
              );
            })}
            {items.length === 0 && <li className="notif-empty">暂无通知</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

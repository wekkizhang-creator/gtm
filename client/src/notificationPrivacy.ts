import type { Notification, Settings } from './types';

export type NotificationDetailVisibility = Settings['notifications']['detailVisibility'];

export function canShowNotificationDetail(visibility: NotificationDetailVisibility, locked: boolean): boolean {
  if (visibility === 'always') return true;
  if (visibility === 'hidden') return false;
  return !locked;
}

export function notificationDisplayContent(
  item: Pick<Notification, 'title' | 'body'>,
  visibility: NotificationDetailVisibility,
  locked: boolean,
): { title: string; body: string | null; detailsHidden: boolean } {
  if (canShowNotificationDetail(visibility, locked)) {
    return { title: item.title, body: item.body, detailsHidden: false };
  }
  return {
    title: '通知',
    body: visibility === 'hidden' ? '通知详情已隐藏' : '解锁后查看通知详情',
    detailsHidden: true,
  };
}

import { AUTH_OFFLINE_NOTICE, authOfflineNotice, browserOnlineStatus, resolveBrowserOnlineStatus } from '../client/src/authNetworkState';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main() {
  assert(authOfflineNotice(true) === null, 'online login screen should not show an offline notice');
  assert(authOfflineNotice(false) === AUTH_OFFLINE_NOTICE, 'offline login screen should show the retry/preserve-input notice');
  assert(authOfflineNotice(false).includes('已填写内容会保留'), 'offline notice should promise input retention');
  assert(resolveBrowserOnlineStatus(false, false) === true, 'non-browser environment should default to online');
  assert(resolveBrowserOnlineStatus(true, false) === false, 'browser offline value should be respected');
  assert(resolveBrowserOnlineStatus(true, true) === true, 'browser online value should be respected');
  assert(resolveBrowserOnlineStatus(true, undefined) === true, 'missing online value should default to online');
  assert(browserOnlineStatus() === true, 'Node test environment should default to online');

  console.log('auth-network-state-client: all assertions passed');
}

main();

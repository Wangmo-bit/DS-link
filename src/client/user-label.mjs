// Local presentation only. This label never supplies sender identity, account
// identity, permissions or relay attribution. An empty value uses a neutral label.
import { useSyncExternalStore } from 'react';
export const USER_LABEL_KEY = 'dsh-session-link:user-label:v1';
const listeners = new Set();
export function normalizeUserLabel(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, '').trim()).slice(0, 40).join('');
}
export function getUserLabel() {
  try { return normalizeUserLabel(globalThis.localStorage?.getItem(USER_LABEL_KEY)); }
  catch { return ''; }
}
function notify() {
  for (const listener of [...listeners]) {
    try { listener(); } catch { globalThis.console?.error('DS-link display-name subscriber failed'); }
  }
}
const storageChanged = event => { if (event.key === USER_LABEL_KEY || event.key === null) notify(); };
export function subscribeUserLabel(listener) {
  listeners.add(listener);
  if (listeners.size === 1) globalThis.addEventListener?.('storage', storageChanged);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) globalThis.removeEventListener?.('storage', storageChanged);
  };
}
export function useUserLabel() { return useSyncExternalStore(subscribeUserLabel, getUserLabel, () => ''); }
export function setUserLabel(value) {
  if (typeof value !== 'string' || Array.from(value.trim()).length > 40 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    if (!globalThis.localStorage) return false;
    globalThis.localStorage.setItem(USER_LABEL_KEY, normalizeUserLabel(value));
    notify();
    return true;
  } catch { return false; }
}

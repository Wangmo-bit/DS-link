// A presentation preference scoped to this browser and origin, never relay data.
import { useSyncExternalStore } from 'react';
export const DISPLAY_MODE_KEY = 'dsh-session-link:display-mode:v1';
const listeners = new Set();
let fallback = 'bubble';
function read() {
  try { return globalThis.localStorage?.getItem(DISPLAY_MODE_KEY) === 'card' ? 'card' : 'bubble'; }
  catch { return fallback; }
}
function notify() {
  // Notify a stable snapshot: a slot may unsubscribe/re-subscribe as its
  // presentation changes. One broken extension must not starve the rest.
  for (const listener of [...listeners]) {
    try { listener(); } catch (error) { globalThis.console?.error('session-link display-mode listener failed', error); }
  }
}
const onStorage = event => { if (event.key === DISPLAY_MODE_KEY || event.key === null) notify(); };
function subscribe(listener) {
  listeners.add(listener);
  if (listeners.size === 1) globalThis.addEventListener?.('storage', onStorage);
  return () => { listeners.delete(listener); if (!listeners.size) globalThis.removeEventListener?.('storage', onStorage); };
}
export function subscribeDisplayMode(listener) { return subscribe(listener); }
export function useDisplayMode() { return useSyncExternalStore(subscribe, read, () => 'bubble'); }
export function getDisplayMode() { return read(); }
export function setDisplayMode(value) {
  if (value !== 'bubble' && value !== 'card') return false;
  try { if (!globalThis.localStorage) return false; globalThis.localStorage.setItem(DISPLAY_MODE_KEY, value); fallback = value; notify(); return true; }
  catch { return false; }
}

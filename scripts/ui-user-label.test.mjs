import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_LABEL_KEY, getUserLabel, normalizeUserLabel, setUserLabel, subscribeUserLabel } from '../src/client/user-label.mjs';

test('user label is neutral by default, local, bounded and observable', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
  let calls = 0;
  const off = subscribeUserLabel(() => calls++);
  try {
    assert.equal(getUserLabel(), '');
    assert.equal(setUserLabel('  演示用户  '), true);
    assert.equal(getUserLabel(), '演示用户');
    assert.equal(values.get(USER_LABEL_KEY), '演示用户');
    assert.equal(calls, 1);
    assert.equal(setUserLabel('😀'.repeat(40)), true);
    assert.equal(setUserLabel('😀'.repeat(41)), false);
    assert.equal(setUserLabel('line\nbreak'), false);
    assert.equal(setUserLabel(null), false);
    assert.equal(setUserLabel(''), true);
    assert.equal(getUserLabel(), '');
    assert.equal(normalizeUserLabel('\u0000x\ny'), 'xy');
    assert.equal(Array.from(normalizeUserLabel('😀'.repeat(100))).length, 40);
  } finally { off(); if (old) Object.defineProperty(globalThis, 'localStorage', old); else delete globalThis.localStorage; }
});

test('blocked storage never reports a successful name save', () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked'); } });
  try { assert.equal(setUserLabel('Example'), false); assert.equal(getUserLabel(), ''); }
  finally { if (old) Object.defineProperty(globalThis, 'localStorage', old); else delete globalThis.localStorage; }
});

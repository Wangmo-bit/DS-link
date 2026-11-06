import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_MODE_KEY, getDisplayMode, setDisplayMode, subscribeDisplayMode } from '../src/client/display-mode.mjs';

test('mode is local, persisted, observable and respects cross-tab changes', () => {
  const values = new Map(), events = new Map();
  const originals = ['localStorage','addEventListener','removeEventListener'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis,k)]);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}});
  Object.defineProperty(globalThis,'addEventListener',{configurable:true,value:(name,fn)=>events.set(name,fn)});
  Object.defineProperty(globalThis,'removeEventListener',{configurable:true,value:(name,fn)=>{if(events.get(name)===fn)events.delete(name);}});
  try {
    assert.equal(getDisplayMode(),'bubble');
    let a=0,b=0;const stopA=subscribeDisplayMode(()=>a++), stopB=subscribeDisplayMode(()=>b++);
    assert.equal(setDisplayMode('card'),true);assert.equal(values.get(DISPLAY_MODE_KEY),'card');assert.equal(getDisplayMode(),'card');assert.deepEqual([a,b],[1,1]);
    assert.equal(setDisplayMode('invalid'),false);assert.equal(getDisplayMode(),'card');
    values.set(DISPLAY_MODE_KEY,'bubble');events.get('storage')({key:DISPLAY_MODE_KEY});assert.deepEqual([a,b],[2,2]);assert.equal(getDisplayMode(),'bubble');
    stopA();stopB();assert.equal(events.size,0);
  } finally { for(const [key,descriptor] of originals) if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]; }
});

test('blocked storage refuses a fake save', () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('storage denied');}});
  try { assert.equal(setDisplayMode('card'),false); }
  finally { if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage; }
});

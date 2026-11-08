// One-click quote: the bridge captures a Session's public input facade and the
// bubble button inserts the rendered text through the Host's own quote machinery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipQuote, installMessageQuote, quoteMessage, quoteReady } from '../src/client/message-quote.mjs';

test('a short message is quoted verbatim, a huge one as a marked excerpt',()=>{
  assert.equal(clipQuote('hello'),'hello');
  assert.equal(clipQuote('  a\r\nb  '),'a\nb');
  assert.equal(clipQuote(''),'');
  assert.equal(clipQuote(null),'');
  const huge='x'.repeat(3000);
  const clipped=clipQuote(huge);
  assert.equal(clipped.endsWith('…（引用节选）'),true);
  assert.equal(clipped.length <= 1200 + '\n…（引用节选）'.length,true);
});

test('the bridge exposes quote insertion per session and disposes cleanly',()=>{
  let Bridge;
  const register=(options,component)=>{assert.equal(options.name,'conversation.input.right');Bridge=component;return ()=>{};};
  const ctx={slots:{inject:(name,factory)=>{factory();return ()=>{};},register}};
  const dispose=installMessageQuote(ctx);
  assert.equal(quoteReady('S'),false);
  let inserted='';
  const inputActions={insertQuote:text=>{inserted=text;return true;}};
  Bridge({sessionId:'S',inputActions});
  assert.equal(quoteReady('S'),true);
  assert.equal(quoteMessage('S','  quoted text  '),true);
  assert.equal(inserted,'quoted text');
  // Unknown sessions and blank text never pretend a quote happened.
  assert.equal(quoteMessage('unknown','text'),false);
  assert.equal(quoteMessage('S','   '),false);
  // A refused insertion is reported honestly.
  inputActions.insertQuote=()=>false;
  assert.equal(quoteMessage('S','text'),false);
  dispose();
  assert.equal(quoteReady('S'),false);
});

// Generate an exact-version candidate for the rc.4 native ChatFlow bridge.
// Source-only maintenance tool: never writes an installed DSH tree or starts anything.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_SHA256 = 'eef53e82b8cd584d2f0e543a4a93395f9d90df3bba1218891bd99d07d788de5c';
export const HOST_VERSION = '0.2.2-rc.4';
function assertModuleSyntax(source) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().slice(0, 500);
    throw new Error(`Generated bridge candidate failed module syntax check: ${detail}`);
  }
}
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Host anchor missing or ambiguous: ${before.slice(0, 100)}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

/**
 * Add one optional adapter seam to the exact published rc.4 chat bundle.
 * Without an adapter the original ChatFlow remains the fallback.
 * @param {string} source
 * @returns {string}
 */
export function patchHostFlowRc4(source) {
  if (createHash('sha256').update(source).digest('hex') !== HOST_SHA256) {
    throw new Error(`Unsupported Web Chat artifact: expected exact DSH ${HOST_VERSION} baseline`);
  }
  let out = replaceOnce(
    source,
    'const ChatFlow=(0,react.memo)(function ChatFlow({',
    'const NativeChatFlow=(0,react.memo)(function NativeChatFlow({ slSuppressRunning=false,',
  );
  out = replaceOnce(out, 'key:group.key', 'key:group.key,slFlowTurn:this.turn');
  out = replaceOnce(out, '...running||holding?[', '...!slSuppressRunning&&(running||holding)?[');
  out = replaceOnce(
    out,
    'children:{"conversation.chat.node":{kind:`keyed`,scope:`session`,inject:CHAT_NODE_INJECT}}',
    'children:{"conversation.chat.node":{kind:`keyed`,scope:`session`,inject:CHAT_NODE_INJECT},"conversation.chat.flow.adapter":{kind:`single`,scope:`session`}}',
  );
  const wrapper = `const ChatFlowWrapper=(0,react.memo)(function ChatFlowWrapper(props){return props.renderSlot(\`conversation.chat.flow.adapter\`,{...props,NativeFlow:NativeChatFlow},{fallback:(0,react.createElement)(NativeChatFlow,props)})});`;
  out = replaceOnce(out, 'ChatFlow));ctx.slots.inject(`conversation.view`', 'ChatFlowWrapper));ctx.slots.inject(`conversation.view`');
  out = replaceOnce(out, 'function apply(ctx){', wrapper + 'function apply(ctx){');
  out = replaceOnce(
    out,
    'ctx.slots.inject(`conversation.chat.flow`,()=>ctx.slots.register({name:`conversation.chat.flow`',
    'ctx.slots.inject(`conversation.chat.flow.adapter`,()=>ctx.slots.register({name:`conversation.chat.flow.adapter`,priority:100},props=>(0,react.createElement)(props.NativeFlow,props)));ctx.slots.inject(`conversation.chat.flow`,()=>ctx.slots.register({name:`conversation.chat.flow`',
  );
  const oldRows = '(elements.column.querySelector(`:scope > [data-slot="conversation.chat.flow"]`)??elements.column).children';
  if (out.split(oldRows).length !== 4) throw new Error('Host row-root anchors missing or ambiguous');
  out = out.replaceAll(oldRows, 'slFlowRows(elements.column).children');
  out = replaceOnce(
    out,
    'var ChatViewport=class',
    'function slFlowRows(column){return column.querySelector(`:scope > [data-slot="conversation.chat.flow"] > [data-slot="conversation.chat.flow.adapter"]`)??column.querySelector(`:scope > [data-slot="conversation.chat.flow"]`)??column;}var ChatViewport=class',
  );
  const extraCss = '[data-slot="conversation.chat.flow.adapter"]>:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty)))~:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty))){margin-top:var(--dsh-chat-flow-gap,6px)}.EvIC1a_column:has(>.EvIC1a_older)>[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]>:first-child{margin-top:var(--dsh-chat-flow-gap,6px)}';
  out = replaceOnce(out, 'tag.textContent=css$16;', `tag.textContent=css$16+${JSON.stringify(extraCss)};`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/dsh-web-flow-bridge-rc4.mjs <read-only-host-client.js> <new-candidate.js>');
  const destination = resolve(output);
  const artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
  if ((!destination.startsWith(`${artifacts}${sep}`) && !destination.startsWith(`/dev/shm${sep}`)) || destination === resolve(input)) throw new Error('Output must be a new file in this project’s artifacts or /dev/shm');
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Refusing a symlinked output directory');
  const patched = patchHostFlowRc4(await readFile(resolve(input), 'utf8'));
  assertModuleSyntax(patched);
  await writeFile(destination, patched, { flag: 'wx', mode: 0o600 });
  console.log(`Created version-checked rc.4 Web Chat flow candidate: ${destination}`);
}

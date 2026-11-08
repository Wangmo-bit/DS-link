// Generate an exact-version candidate for the rc.1 native ChatFlow bridge.
// This script NEVER writes the installed DSH tree or installs/restarts anything.
// The caller must independently review the candidate and authorize deployment.
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_SHA256 = 'b7e645f2461231e8ece31381f026db2df72d058e425eaef19265f215c823d84e';
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Host anchor missing or ambiguous: ${before.slice(0, 90)}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

/**
 * Add the existing optional adapter seam to the exact published rc.1 chat bundle.
 * Without an adapter the original ChatFlow remains the fallback. The native
 * running marker may be suppressed only by the adapter's explicit prop; the
 * host-only path and card-mode NativeFlow retain their original behaviour.
 */
export function patchHostFlowRc1(source) {
  if (createHash('sha256').update(source).digest('hex') !== HOST_SHA256) throw new Error('Unsupported Web Chat artifact: expected exact DSH 0.2.2-rc.1 baseline');
  let out = replaceOnce(source, 'const ChatFlow = (0, react.memo)(function ChatFlow({', 'const NativeChatFlow = (0, react.memo)(function NativeChatFlow({ slSuppressRunning = false,');
  out = replaceOnce(out, '...running || holding ? [', '...!slSuppressRunning && (running || holding) ? [');
  // Group entries must carry the same Turn the Host already knows. Without it,
  // the adapter cannot group process entries reliably on a history reload.
  out = replaceOnce(out, 'key: group.key\n', 'key: group.key, slFlowTurn: this.turn\n');
  out = replaceOnce(out, 'children: { "conversation.chat.node": {\n\t\t\t\t\tkind: "keyed",\n\t\t\t\t\tscope: "session",\n\t\t\t\t\tinject: CHAT_NODE_INJECT\n\t\t\t\t} },', 'children: { "conversation.chat.node": {\n\t\t\t\t\tkind: "keyed",\n\t\t\t\t\tscope: "session",\n\t\t\t\t\tinject: CHAT_NODE_INJECT\n\t\t\t\t}, "conversation.chat.flow.adapter": { kind: "single", scope: "session" } },');
  const marker = '\t\t//#endregion\n\t\t//#region lib/types/client/locale.js';
  const bridge = `
\t\tconst NativeFlowFallback = (0, react.memo)(function NativeFlowFallback({ NativeFlow, ...props }) {
\t\t\treturn (0, react.createElement)(NativeFlow, props);
\t\t});
\t\t// Card mode must use the original DOM/scroll structure, not an extra outlet.
\t\t// The communication plugin owns this presentation attribute and toggles it
\t\t// on same-page preference changes; observation is local and cleaned up.
\t\tconst slCardSnapshot = () => typeof document !== 'undefined' && document.documentElement?.hasAttribute('data-sl-card-mode') === true;
\t\tconst slCardSubscribe = (notify) => {
\t\t\tif (typeof document === 'undefined' || !document.documentElement || typeof MutationObserver === 'undefined') return () => {};
\t\t\tconst observer = new MutationObserver(notify);
\t\t\tobserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sl-card-mode'] });
\t\t\treturn () => observer.disconnect();
\t\t};
\t\tconst ChatFlow = (0, react.memo)(function ChatFlow(props) {
\t\t\tconst card = (0, react.useSyncExternalStore)(slCardSubscribe, slCardSnapshot, () => false);
\t\t\tif (card) return (0, react.createElement)(NativeChatFlow, props);
\t\t\treturn props.renderSlot('conversation.chat.flow.adapter', { ...props, NativeFlow: NativeChatFlow }, {
\t\t\t\tfallback: (0, react.createElement)(NativeChatFlow, props)
\t\t\t});
\t\t});
`;
  out = replaceOnce(out, marker, bridge + marker);
  out = replaceOnce(out, '\t\t\t}, ChatFlow));\n\t\t\tctx.slots.inject("conversation.view",', '\t\t\t}, ChatFlow));\n\t\t\tctx.slots.inject("conversation.chat.flow.adapter", () => ctx.slots.register({ name: "conversation.chat.flow.adapter", priority: 100 }, NativeFlowFallback));\n\t\t\tctx.slots.inject("conversation.view",');
  out = replaceOnce(out, '\t\tvar ChatViewport = class {', '\t\tfunction slFlowRows(column) { return column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"] > [data-slot=\\\"conversation.chat.flow.adapter\\\"]") ?? column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"]") ?? column; }\n\t\tvar ChatViewport = class {');
  const oldRows = '(elements.column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"]") ?? elements.column).children';
  if (out.split(oldRows).length !== 4) throw new Error('Host row-root anchors missing or ambiguous');
  out = out.replaceAll(oldRows, 'slFlowRows(elements.column).children');
  // Scope the adapted selectors to the additional outlet. The native sheet is
  // left in place, and when card mode bypasses the outlet no extra rule can
  // affect its rows. Derive from the exact verified Host sheet so rc.1's turn,
  // steering, running-divider and reduced-motion rules travel together.
  const nativeFlowSelector = '[data-slot="conversation.chat.flow"]';
  const adaptedFlowSelector = ':scope';
  const scopeStart = '@scope ([data-slot="conversation.chat.flow.adapter"]) {';
  const scopeEnd = '@media (prefers-reduced-motion:no-preference){:where(:scope>.EvIC1a_flowItem[data-chat-flow-kind=steering])+.EvIC1a_running{animation:.14s cubic-bezier(.2,.8,.2,1) EvIC1a_running-enters-slot}}}';
  const outlet = '[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]';
  const ancestors = `.EvIC1a_column[data-chat-motion]>${outlet}>:not([data-chat-motion]){transition:margin-top .16s cubic-bezier(.4,0,.2,1)}.EvIC1a_column[data-input-fold]>${outlet}>:not([data-chat-motion]),.EvIC1a_column[data-chat-motion]>${outlet}>[data-chat-flow-kind=turn-process]{transition:none}@media (prefers-reduced-motion:reduce){.EvIC1a_column[data-chat-motion]>${outlet}>:not([data-chat-motion]){transition:none}}@media (prefers-reduced-motion:no-preference){.EvIC1a_column[data-input-fold] [data-slot="conversation.chat.flow.adapter"] .EvIC1a_running{animation-duration:0s}}`;
  out = replaceOnce(out, 'tag.textContent = css$16;', `tag.textContent = css$16 + ${JSON.stringify(scopeStart)} + css$16.replaceAll(${JSON.stringify(nativeFlowSelector)}, ${JSON.stringify(adaptedFlowSelector)}) + ${JSON.stringify(scopeEnd + ancestors)};`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/dsh-web-flow-bridge-rc1.mjs <read-only-host-client.js> <new-candidate.js>');
  const destination = resolve(output), artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
  if ((!destination.startsWith(`${artifacts}${sep}`) && !destination.startsWith(`/dev/shm${sep}`)) || destination === resolve(input)) throw new Error('Output must be a new file in this project’s artifacts or /dev/shm');
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Refusing a symlinked output directory');
  await writeFile(destination, patchHostFlowRc1(await readFile(resolve(input), 'utf8')), { flag: 'wx', mode: 0o600 });
  console.log(`Created version-checked rc.1 Web Chat flow candidate: ${destination}`);
}

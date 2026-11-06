// Builds a version-bound candidate only, never writes the live DSH installation.
// Adds one optional, fail-open React flow extension point; with no extension the
// Host renders the unmodified native ChatFlow, including its scroll patch.
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_SHA256 = '31e14da00f62671eff7500999798bd68e567588fa4a6a18b08c4227c19f713dd';
const marker = '\t\t//#endregion\n\t\t//#region lib/types/client/locale.js';
const bridge = `
		// Child slot belongs to the native flow registration. Slot lifecycle and
		// scope authorization apply; with no adapter, native flow is unchanged.
		const NativeFlowFallback = (0, react.memo)(function NativeFlowFallback({ NativeFlow, ...props }) {
			return (0, react.createElement)(NativeFlow, props);
		});
		const ChatFlow = (0, react.memo)(function ChatFlow(props) {
			return props.renderSlot('conversation.chat.flow.adapter', { ...props, NativeFlow: NativeChatFlow }, {
				fallback: (0, react.createElement)(NativeChatFlow, props)
			});
		});
`;
function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Host anchor missing or ambiguous: ${before.slice(0, 90)}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}
export function patchHostFlow(source) {
  if (createHash('sha256').update(source).digest('hex') !== HOST_SHA256) throw new Error('Unsupported Web Chat artifact: expected previously patched DSH 0.2.1-rc.5');
  let out = replaceOnce(source, 'const ChatFlow = (0, react.memo)(function ChatFlow({', 'const NativeChatFlow = (0, react.memo)(function NativeChatFlow({ slSuppressRunning = false,');
  out = replaceOnce(out, '\t\t\tconst nodeStore = useChat((snapshot) => snapshot.nodes);\n\t\t\tconst running = useSession((snapshot) => snapshot.running);\n\t\t\tconst runningStartTime = useChatNode(useChat((snapshot) => snapshot.navigation.items().at(-1)?.anchorKey) ?? "", (node) => {', '\t\t\tconst nodeStore = useChat((snapshot) => snapshot.nodes);\n\t\t\tconst running = useSession((snapshot) => slSuppressRunning ? false : snapshot.running);\n\t\t\tconst runningAnchor = useChat((snapshot) => slSuppressRunning ? undefined : snapshot.navigation.items().at(-1)?.anchorKey);\n\t\t\tconst runningStartTime = useChatNode(runningAnchor ?? "", (node) => {');
  // The group definition already knows its exact Turn; expose that stable
  // value on its render entry so the adapter never guesses from a label/key.
  out = replaceOnce(out, 'key: group.key\n', 'key: group.key, slFlowTurn: this.turn\n');
  out = replaceOnce(out, 'children: { "conversation.chat.node": {\n\t\t\t\t\tkind: "keyed",\n\t\t\t\t\tscope: "session",\n\t\t\t\t\tinject: CHAT_NODE_INJECT\n\t\t\t\t} },', 'children: { "conversation.chat.node": {\n\t\t\t\t\tkind: "keyed",\n\t\t\t\t\tscope: "session",\n\t\t\t\t\tinject: CHAT_NODE_INJECT\n\t\t\t\t}, "conversation.chat.flow.adapter": { kind: "single", scope: "session" } },');
  out = replaceOnce(out, marker, bridge + marker);
  out = replaceOnce(out, '\t\t\t}, ChatFlow));\n\t\t\tctx.slots.inject("conversation.view",', '\t\t\t}, ChatFlow));\n\t\t\tctx.slots.inject("conversation.chat.flow.adapter", () => ctx.slots.register({ name: "conversation.chat.flow.adapter", priority: 100 }, NativeFlowFallback));\n\t\t\tctx.slots.inject("conversation.view",');
  // Slot outlets are display:contents but remain DOM parents. Preserve the
  // viewport's direct-row search on both the native and adapter paths.
  out = replaceOnce(out, '\t\tvar ChatViewport = class {', '\t\tfunction slFlowRows(column) { return column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"] > [data-slot=\\\"conversation.chat.flow.adapter\\\"]") ?? column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"]") ?? column; }\n\t\tvar ChatViewport = class {');
  const oldRows='(elements.column.querySelector(":scope > [data-slot=\\\"conversation.chat.flow\\\"]") ?? elements.column).children';
  if(out.split(oldRows).length!==3)throw new Error('Host row-root anchors missing or ambiguous');
  out=out.replaceAll(oldRows,'slFlowRows(elements.column).children');
  const extraCss='[data-slot="conversation.chat.flow.adapter"]>:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty)))~:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty))){margin-top:var(--dsh-chat-flow-gap,6px)}.EvIC1a_column:has(>.EvIC1a_older)>[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]>:first-child{margin-top:var(--dsh-chat-flow-gap,6px)}.EvIC1a_column[data-chat-motion]>[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]>:not([data-chat-motion]){transition:margin-top .16s cubic-bezier(.4,0,.2,1)}.EvIC1a_column[data-input-fold]>[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]>:not([data-chat-motion]){transition:none}@media (prefers-reduced-motion:reduce){.EvIC1a_column[data-chat-motion]>[data-slot="conversation.chat.flow"]>[data-slot="conversation.chat.flow.adapter"]>:not([data-chat-motion]){transition:none}}';
  const extraGap='[data-slot="conversation.chat.flow.adapter"]>[data-chat-group-part=response]:not([hidden]):not(:empty)+:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty))):not(.EvIC1a_running){--dsh-chat-flow-gap:12px}[data-slot="conversation.chat.flow.adapter"]>[data-chat-flow-kind=turn-process]+:not([hidden]):not(.EvIC1a_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty))):not(.EvIC1a_running){--dsh-chat-flow-gap:16px}';
  out = replaceOnce(out, 'tag.textContent = css$16;', `tag.textContent = css$16 + ${JSON.stringify(extraCss+extraGap)};`);
  return out;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/dsh-web-flow-bridge.mjs <read-only-host-client.js> <new-candidate.js>');
  const destination = resolve(output), artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
  if ((!destination.startsWith(`${artifacts}${sep}`) && !destination.startsWith(`/dev/shm${sep}`)) || destination === resolve(input)) throw new Error('Output must be a new file in this project’s artifacts or /dev/shm');
  if (await realpath(dirname(destination)) !== dirname(destination)) throw new Error('Refusing a symlinked output directory');
  await writeFile(destination, patchHostFlow(await readFile(resolve(input), 'utf8')), {flag:'wx',mode:0o600});
  console.log(`Created version-checked Web Chat flow candidate: ${destination}`);
}

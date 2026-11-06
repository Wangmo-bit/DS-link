// Reproducible, version-bound patch for the rc.5 Web Chat artifact. This is a
// build step only: it never writes to the installed DSH tree. The Host already
// owns follow policy and a turn spacer; keep a transient amount of that room
// when a just-submitted composer collapses, consuming it as response content
// grows. No extra observer, animation, or competing scroll writer is added.
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_SHA256 = '181f766f2fe12ad27eed4f1c0cd4609e8d2211d397890355eb476b6a9ee311c2';

/** Retain enough temporary room to preserve the floor observed at submission. */
export function submissionRoom(initialFloor, physicalFloor, currentRoom) {
  if (![initialFloor, physicalFloor, currentRoom].every(Number.isFinite)) return 0;
  const naturalFloor = Math.max(0, physicalFloor - currentRoom);
  return Math.max(0, initialFloor - naturalFloor);
}

/** End guard on a failed/abandoned input or when the running turn settles. */
export function shouldEndSubmissionGuard(previous, current) {
  const abandoned = previous?.submissionId != null && current.submissionId === null && current.lastKey === previous.lastKey && !current.running;
  return Boolean(abandoned || previous?.running && !current.running);
}

function replaceOnce(text, before, after) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0) throw new Error(`Host anchor missing or ambiguous: ${before.slice(0, 90)}`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

export function patchHostChat(source) {
  if (createHash('sha256').update(source).digest('hex') !== HOST_SHA256) throw new Error('Unsupported Web Chat artifact: expected exact DSH 0.2.1-rc.5 baseline');
  let out = source;
  out = replaceOnce(out, '\t\tvar ChatViewport = class {', `\t\tconst submissionRoom = ${submissionRoom.toString()};\n\t\tconst shouldEndSubmissionGuard = ${shouldEndSubmissionGuard.toString()};\n\t\tvar ChatViewport = class {`);
  out = replaceOnce(out, '\t\t\tobserver = null;\n\t\t\tevents = null;', '\t\t\tobserver = null;\n\t\t\tsubmissionGuard = null;\n\t\t\tevents = null;');
  out = replaceOnce(out, '\t\t\t\t\t\tif (this.elements !== elements) return;\n\t\t\t\t\t\tthis.reclaimBelow();', '\t\t\t\t\t\tif (this.elements !== elements) return;\n\t\t\t\t\t\tthis.reconcileSubmissionGuard();\n\t\t\t\t\t\tthis.reclaimBelow();');
  out = replaceOnce(out, '\t\t\t\tthis.observer = null;\n\t\t\t\tthis.elements = null;', '\t\t\t\tthis.observer = null;\n\t\t\t\tthis.submissionGuard = null;\n\t\t\t\tthis.elements = null;');
  out = replaceOnce(out, '\t\t\t\tconst next = height <= 0 ? "" : `${Math.ceil(height)}px`;\n\t\t\t\tif (spacer.style.height !== next) spacer.style.height = next;\n\t\t\t}', `\t\t\t\tif (this.motion.foldActive()) this.submissionGuard = null;\n\t\t\t\tconst reserved = this.submissionGuard?.room ?? 0;\n\t\t\t\tconst next = Math.max(height, reserved) <= 0 ? "" : \`\${Math.ceil(Math.max(height, reserved))}px\`;\n\t\t\t\tif (spacer.style.height !== next) spacer.style.height = next;\n\t\t\t}\n\t\t\t/** Protect the just-submitted input from a collapsing composer. */\n\t\t\tbeginSubmissionGuard() {\n\t\t\t\tconst elements = this.elements;\n\t\t\t\tif (elements?.spacer == null || this.motion.foldActive() || this.motion.inputActive()) return;\n\t\t\t\tconst metrics = scrollMetrics(elements.scroller);\n\t\t\t\tconst previous = this.submissionGuard;\n\t\t\t\tthis.submissionGuard = { floor: metrics.floor, viewport: metrics.height, room: previous?.room ?? 0, shrank: previous?.shrank ?? false };\n\t\t\t}\n\t\t\t/** Consume reserved room as later Chat content replaces it. */\n\t\t\treconcileSubmissionGuard() {\n\t\t\t\tconst guard = this.submissionGuard, elements = this.elements;\n\t\t\t\tif (guard === null || elements?.spacer == null || this.motion.foldActive()) return;\n\t\t\t\tconst metrics = scrollMetrics(elements.scroller);\n\t\t\t\tif (Math.abs(metrics.height - guard.viewport) > 1) { this.submissionGuard = null; return; }\n\t\t\t\tconst next = submissionRoom(guard.floor, metrics.floor, guard.room);\n\t\t\t\tconst current = this.spacerHeight();\n\t\t\t\tguard.shrank ||= next > 0;\n\t\t\t\tconst adjusted = Math.max(0, current + next - guard.room);\n\t\t\t\tguard.room = next;\n\t\t\t\tthis.setSpacer(adjusted);\n\t\t\t\tif (guard.shrank && next === 0) this.submissionGuard = null;\n\t\t\t}\n\t\t\t/** Return control immediately to an explicit reader gesture. */\n\t\t\tendSubmissionGuard() {\n\t\t\t\tthis.submissionGuard = null;\n\t\t\t}`);
  out = replaceOnce(out, '\t\t\tresetBelow() {\n\t\t\t\tthis.setSpacer(0);', '\t\t\tresetBelow() {\n\t\t\t\tthis.endSubmissionGuard();\n\t\t\t\tthis.setSpacer(0);');
  out = replaceOnce(out, '\t\t\t\tthis.events?.intent?.();\n\t\t\t\tif (this.paging === null) return;', '\t\t\t\tthis.endSubmissionGuard();\n\t\t\t\tthis.events?.intent?.();\n\t\t\t\tif (this.paging === null) return;');
  out = replaceOnce(out, '\t\t\t\tcontent.current.applied = current;\n\t\t\t\tif (current.ready && !content.current.opened)', '\t\t\t\tcontent.current.applied = current;\n\t\t\t\tif (shouldEndSubmissionGuard(previous, current)) viewport.endSubmissionGuard();\n\t\t\t\tif (current.ready && !content.current.opened)');
  out = replaceOnce(out, '\t\t\t\tif (ownInput) {\n\t\t\t\t\tnavigation.cancel();', '\t\t\t\tif (ownInput) {\n\t\t\t\t\tif (current.submissionId !== null && current.submissionId !== previous?.submissionId) viewport.beginSubmissionGuard();\n\t\t\t\t\tnavigation.cancel();');
  // Reconcile at the same pre-paint commit as newly mounted response rows;
  // waiting only for ResizeObserver exposes a one-frame doubled scroll range.
  out = replaceOnce(out, '\t\t\t\tviewport.updateTurns(loadedTurns);\n\t\t\t\tconst layoutChanged', '\t\t\t\tviewport.updateTurns(loadedTurns);\n\t\t\t\tviewport.reconcileSubmissionGuard();\n\t\t\t\tconst layoutChanged');
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/dsh-web-scroll-patch.mjs <read-only-host-client.js> <new-candidate.js>');
  const destination = resolve(output);
  const artifacts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
  const inArtifacts = destination.startsWith(`${artifacts}${sep}`);
  const inPrivateMemory = destination.startsWith(`/dev/shm${sep}`);
  if ((!inArtifacts && !inPrivateMemory) || destination === resolve(input)) throw new Error('Output must be a new file in this project’s artifacts or /dev/shm');
  const parent = dirname(destination);
  if (await realpath(parent) !== parent) throw new Error('Refusing a symlinked output directory');
  const patched = patchHostChat(await readFile(resolve(input), 'utf8'));
  await writeFile(destination, patched, { flag: 'wx', mode: 0o600 });
  console.log(`Created version-checked Web Chat candidate: ${destination}`);
}

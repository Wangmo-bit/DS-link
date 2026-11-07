// Preserve the Host's root-entry order. Only a contiguous native process run
// and its immediately following same-Turn response may share one surface.
// A question or plan prompt still waiting on the user must stay discoverable even
// though bubble mode renders no process. Returns a primitive so the Host's
// snapshot cache stays stable across renders.
export function processNeedsInput(node) {
  if (node?.kind !== 'tool-call') return false;
  let pending = false;
  const visit = root => {
    if (pending || !root || typeof root !== 'object') return;
    if (root.kind === 'tool-result') return;
    const name = root.name ?? root.call?.name;
    if (name === 'ask_user_question' || name === 'exit_plan_mode') { pending = true; return; }
    for (const child of root.subCalls ?? []) visit(child);
  };
  visit(node.data?.root);
  return pending;
}
const turnOf = node => node?.location?.turn?.turn;
const nodeOf = (store, entry) => entry?.kind === 'node' ? store.get(entry.key) : undefined;
const processTurn = (entry, store) => entry?.kind === 'group' ? entry.slFlowTurn : entry?.groupPart === 'reasoning' && nodeOf(store,entry)?.kind === 'assistant-step' ? turnOf(nodeOf(store,entry)) : undefined;
export function planNativeFlow(entries, store) {
  const controllers = new Map(), represented = new Set();
  for (const entry of entries) {
    const node = nodeOf(store, entry), turn = turnOf(node);
    if (node?.kind === 'turn-process' && turn !== undefined) controllers.set(turn, entry);
    else if (processTurn(entry,store) !== undefined) represented.add(processTurn(entry,store));
    else if (node?.kind === 'assistant-step' && entry.groupPart !== 'reasoning' && turn !== undefined) represented.add(turn);
  }
  const plans = [], plain = [];
  const flush = () => { if (plain.length) plans.push({ kind: 'native', entries: plain.splice(0) }); };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], node = nodeOf(store, entry), turn = turnOf(node);
    if (node?.kind === 'turn-process' && turn !== undefined) {
      // The controller's visible summary is carried by the response/process
      // surface. Keep it as a distinct fallback if the loaded window contains
      // no other material for this turn.
      if (!represented.has(turn)) { flush(); plans.push({kind:'control',entry,turn}); }
      continue;
    }
    if (processTurn(entry,store) !== undefined) {
      flush();
      const groupTurn = processTurn(entry,store), groups = [entry];
      while (processTurn(entries[i+1],store) === groupTurn) groups.push(entries[++i]);
      const next = entries[i+1], nextNode = nodeOf(store,next);
      const response = nextNode?.kind === 'assistant-step' && next.groupPart === 'response' && turnOf(nextNode) === groupTurn ? entries[++i] : null;
      plans.push({kind:'message',turn:groupTurn,groups,response,control:controllers.get(groupTurn)});
      continue;
    }
    if (node?.kind === 'assistant-step' && entry.groupPart !== 'reasoning' && turn !== undefined) {
      flush(); plans.push({kind:'message',turn,groups:[],response:entry,control:controllers.get(turn)}); continue;
    }
    plain.push(entry);
  }
  flush();
  const first = new Map(), last = new Map();
  for (const plan of plans) if (plan.kind === 'message' || plan.kind === 'control') { if(!first.has(plan.turn)) first.set(plan.turn,plan); last.set(plan.turn,plan); }
  for (const plan of plans) if (plan.kind === 'message' || plan.kind === 'control') { plan.first=first.get(plan.turn)===plan; plan.last=last.get(plan.turn)===plan; }
  return plans;
}

// ---------------------------------------------------------------------------
// Subagent badges
//
// The Host records every direct child of a session as a `subagent/catalog`
// event, folded into the parent's `subagentCatalog` projection as
// `{id, createdAt, mode, label}`. Counting per turn therefore needs no guessing:
// a child belongs to the turn whose [start, end] window contains its
// `createdAt`, and `label` is the agent name the user picked.
//
// Status comes from two Host facts only:
//   running            — the session's own running flag
//   lastTurnCompleted  — whether the child's latest closed turn ended normally
// A child that is neither running nor "completed" is NOT reported as a failure:
// the Host folds `aborted`/`interrupted` into the same `false`, and calling a
// user-cancelled agent "failed" would be a lie. Those become `idle`.
// ---------------------------------------------------------------------------

/** One agent a turn dispatched, already deduplicated by label. */
export const AGENT_STATE = Object.freeze({ running: 'running', done: 'done', failed: 'failed', idle: 'idle' });

/**
 * Turn windows from the loaded transcript. A turn that never ended keeps its
 * open window so a still-running dispatch can still be attributed to it.
 * @param {Map<string, any>} nodes
 * @returns {Array<{turn:number, from:number, to:number}>}
 */
export function turnWindows(nodes) {
  const windows = new Map();
  for (const node of nodes.values()) {
    const turn = node?.location?.turn;
    if (!turn || typeof turn.turn !== 'number') continue;
    let window = windows.get(turn.turn);
    if (!window) { window = { turn: turn.turn, from: Infinity, to: -Infinity, open: false }; windows.set(turn.turn, window); }
    const start = turn.start?.time, end = turn.end?.time;
    if (Number.isFinite(start)) window.from = Math.min(window.from, start);
    if (Number.isFinite(end)) window.to = Math.max(window.to, end);
    // An open turn must absorb dispatches that happen after the last seen event,
    // so its window stays open-ended.
    if (turn.status === 'open') window.open = true;
  }
  const closed = [...windows.values()]
    .filter(window => Number.isFinite(window.from))
    .map(window => ({ turn: window.turn, from: window.from, to: window.open ? Infinity : window.to }))
    .sort((a, b) => a.from - b.from);
  // An open turn absorbs only what came after it. If an older turn never closed
  // (crash-orphaned), truncate it at the next turn's start so it cannot capture
  // every later dispatch.
  for (let index = 0; index < closed.length - 1; index++) {
    const window = closed[index], next = closed[index + 1];
    if (!Number.isFinite(window.to) && Number.isFinite(next.from)) window.to = next.from - 1;
  }
  return closed;
}

/**
 * Attribute catalog entries to turns and collapse them to one badge per agent
 * label. Calling the same agent repeatedly in one turn is still one agent.
 * @param {Array<{id:string, createdAt:number, label?:string, mode?:string}>} catalog
 * @param {Array<{turn:number, from:number, to:number}>} windows
 * @returns {Map<number, Array<{label:string, state:string, count:number}>>}
 */
export function agentsByTurn(catalog, windows) {
  const byTurn = new Map();
  if (!Array.isArray(catalog) || !catalog.length || !windows.length) return byTurn;
  // turn -> label -> every child id that ran under that label. Keeping all ids is
  // what makes the badge honest: dispatching the same agent three times and
  // having the third one fail must not read as "all done".
  const owners = new Map();
  for (const entry of catalog) {
    if (!entry || typeof entry.id !== 'string' || !Number.isFinite(entry.createdAt)) continue;
    const owner = windows.find(window => entry.createdAt >= window.from && entry.createdAt <= window.to);
    if (!owner) continue;
    const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : '子智能体';
    let labels = owners.get(owner.turn);
    if (!labels) { labels = new Map(); owners.set(owner.turn, labels); }
    const ids = labels.get(label);
    if (ids) ids.push(entry.id); else labels.set(label, [entry.id]);
  }
  for (const [turn, labels] of owners) {
    byTurn.set(turn, [...labels.entries()].map(([label, ids]) => ({ label, ids, count: 1 })));
  }
  return byTurn;
}

/**
 * Fold every instance of one agent label into a single badge state. The Host
 * cannot tell a real error from a user cancellation (both arrive as
 * `lastTurnCompleted === false`), so an unfinished instance makes the agent
 * "unconfirmed" rather than "failed" — reporting a cancelled agent as a failure
 * would be worse than admitting uncertainty.
 * @param {Array<{running?:boolean, lastTurnCompleted?:boolean}>} instances
 * @returns {string} one of AGENT_STATE
 */
export function agentStateOf(instances) {
  const list = Array.isArray(instances) ? instances : [];
  if (!list.length) return AGENT_STATE.idle;
  if (list.some(facts => facts?.running === true)) return AGENT_STATE.running;
  // `failed` is only reachable if a caller supplies a real failure fact. The Host
  // does not expose one today (it folds errors and cancellations into the same
  // `lastTurnCompleted: false`), so in production this branch stays unused and an
  // unfinished instance is reported as unconfirmed instead of failed.
  if (list.some(facts => facts?.failed === true)) return AGENT_STATE.failed;
  if (list.every(facts => facts?.lastTurnCompleted === true)) return AGENT_STATE.done;
  return AGENT_STATE.idle;
}

/**
 * Fold one agent's Host status facts into a badge state.
 * @param {{running?:boolean, lastTurnCompleted?:boolean, failed?:boolean}} facts
 * @returns {string} one of AGENT_STATE
 */
export function agentState(facts = {}) {
  if (facts.running === true) return AGENT_STATE.running;
  if (facts.failed === true) return AGENT_STATE.failed;
  if (facts.lastTurnCompleted === true) return AGENT_STATE.done;
  return AGENT_STATE.idle;
}

/**
 * Collapse a turn's agents to at most one badge per state, ordered running →
 * done → failed → idle so the live state always comes first. A single-agent
 * turn returns its one badge, which the renderer shows without a count.
 * @param {Array<{label:string, state:string}>} agents
 * @returns {Array<{state:string, count:number}>}
 */
export function agentBadges(agents) {
  const order = [AGENT_STATE.running, AGENT_STATE.done, AGENT_STATE.failed, AGENT_STATE.idle];
  const counts = new Map();
  for (const agent of agents ?? []) {
    const state = order.includes(agent?.state) ? agent.state : AGENT_STATE.idle;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return order.filter(state => counts.has(state)).map(state => ({ state, count: counts.get(state) }));
}

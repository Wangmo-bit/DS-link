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
// The Host's `subagentCatalog` records direct children as
// `{id, createdAt, mode, label}`; their creation is attributed to the parent
// turn containing `createdAt`. The label of a Team child is its description,
// so Team identity must instead come from the `agentTeam` roster. A successful
// Team send is attributed directly to its own tool-call turn.
//
// The Host provides the child's running flag, latest closed-turn outcome and
// optional timing/turn outline. A send acknowledgement is not completion, and
// an inactive Team member is not automatically done. Unknown stays `idle`:
// the Host folds `aborted`/`interrupted` into the same `false` as errors.
// ---------------------------------------------------------------------------

/** One agent a turn dispatched, already deduplicated by label. */
export const AGENT_STATE = Object.freeze({ running: 'running', done: 'done', failed: 'failed', idle: 'idle' });

/**
 * Select only confirmed Team sends from one turn's Host tool-call projection.
 * Read the top-level `target` field lazily: never read or parse the message body.
 * A send acknowledgement establishes admission, not execution or completion.
 * @param {readonly {root?: any}[]} toolRows
 * @returns {string} JSON-encoded, sorted distinct target names.
 */
export function teamDispatchSignature(toolRows) {
  const targets = new Set(), stack = [];
  for (const row of toolRows ?? []) if (row?.root) stack.push(row.root);
  while (stack.length) {
    const block = stack.pop();
    if (!block || typeof block !== 'object') continue;
    if (Array.isArray(block.subCalls)) stack.push(...block.subCalls);
    if (block.kind !== 'tool-result' || block.name !== 'send_message' || block.isError !== false || block.call?.name !== 'send_message') continue;
    let target;
    try { target = block.args?.text?.('target'); } catch { continue; }
    if (typeof target !== 'string' || !target.trim() || !Array.isArray(block.content)) continue;
    const accepted = block.content.some(part => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return false;
      try { return JSON.parse(part.text)?.sent === true; } catch { return false; }
    });
    if (accepted) targets.add(target.trim());
  }
  return JSON.stringify([...targets].sort());
}

/**
 * Select the parent Team roster and only the child status facts used by badges.
 * The primitive signature changes when a roster member or status changes but
 * does not subscribe the flow to unrelated session-list updates.
 */
export function teamRosterSignature(snapshot, sessionId) {
  const own = snapshot?.projectionsBySession?.[sessionId]?.values?.agentTeam?.members;
  const parentId = snapshot?.byId?.[sessionId]?.parentId;
  const parent = parentId ? snapshot?.projectionsBySession?.[parentId]?.values?.agentTeam?.members : undefined;
  // A teammate's roster is stored on the Lead, not on that teammate's own
  // Session. Only use the parent roster when it proves this exact membership;
  // ordinary subagents must never inherit an unrelated Team.
  const isTeammate = Array.isArray(parent) && parent.some(member => member?.id === sessionId && member.role === 'teammate' && member.phase === 'active');
  const members = isTeammate ? parent : own;
  if (!Array.isArray(members)) return '';
  const rows = [];
  for (const member of members) {
    if (member?.role !== 'teammate' || member.phase !== 'active' || typeof member.id !== 'string' || typeof member.name !== 'string') continue;
    const child = snapshot.byId?.[member.id], timing = child?.projectionValues?.subagentTiming;
    const outcome = timing?.lastTurnCompleted, activeSince = timing?.active?.since;
    const outline = child?.projectionValues?.turnOutline;
    rows.push([member.id, member.name, member.role, member.phase, child?.running === true,
      outcome === true ? 'c' : outcome === false ? 'f' : '', Number.isFinite(activeSince) ? activeSince : null,
      Array.isArray(outline) ? outline.length : null]);
  }
  return JSON.stringify(rows);
}

/**
 * Select only the turn-boundary facts that affect agent attribution. Unlike the
 * stable live ChatNodeStore, the Host publishes a new timeline when a boundary
 * changes or older history is loaded. Returning a primitive keeps unrelated
 * step/content changes from re-rendering the entire flow.
 * @param {{turns?: ReadonlyMap<number, any>} | undefined} timeline
 * @returns {string} JSON rows: [turn, start, end-or-null, open]
 */
export function turnWindowSignature(timeline) {
  if (!timeline?.turns || typeof timeline.turns.values !== 'function') return '';
  const rows = [];
  for (const turn of timeline.turns.values()) {
    if (typeof turn?.turn !== 'number' || !Number.isFinite(turn.start?.time)) continue;
    rows.push([turn.turn, turn.start.time, Number.isFinite(turn.end?.time) ? turn.end.time : null, turn.status === 'open']);
  }
  return JSON.stringify(rows);
}

/**
 * Turn windows from a boundary signature. An open turn remains open-ended,
 * except when a later turn bounds a stale, crash-orphaned open turn.
 * @param {string} signature
 * @returns {Array<{turn:number, from:number, to:number}>}
 */
export function turnWindows(signature) {
  if (!signature) return [];
  const windows = JSON.parse(signature)
    .map(([turn, from, end, open]) => ({ turn, from, to: open ? Infinity : end ?? -Infinity }))
    .sort((a, b) => a.from - b.from);
  // An open turn absorbs only what came after it. If an older turn never closed
  // (crash-orphaned), truncate it at the next turn's start so it cannot capture
  // every later dispatch.
  for (let index = 0; index < windows.length - 1; index++) {
    const window = windows[index], next = windows[index + 1];
    if (!Number.isFinite(window.to) && Number.isFinite(next.from)) window.to = next.from - 1;
  }
  return windows;
}

/**
 * Attribute newly created children and acknowledged Team sends to their turns.
 * Team members use the roster name, not the catalog's task-description label,
 * so creation plus later sends to the same member still count only once.
 * A sentIds entry records admission only; it is not evidence of completion.
 * @param {Array<{id:string, createdAt:number, label?:string, mode?:string}>} catalog
 * @param {Array<{turn:number, from:number, to:number}>} windows
 * @param {Array<{id:string, name:string, role:string, phase:string}>} teamMembers
 * @param {Map<number, string[]>} targetsByTurn
 * @returns {Map<number, Array<{label:string, ids:string[], sentIds?:string[], count:number}>>}
 */
export function agentsByTurn(catalog, windows, teamMembers = [], targetsByTurn = new Map()) {
  const byTurn = new Map();
  if (!Array.isArray(windows) || !windows.length) return byTurn;
  const teamById = new Map(), teamByName = new Map();
  for (const member of teamMembers ?? []) {
    if (member?.role !== 'teammate' || member.phase !== 'active' || typeof member.id !== 'string' || !member.id || typeof member.name !== 'string' || !member.name.trim()) continue;
    const name = member.name.trim(), prior = teamByName.get(name);
    teamById.set(member.id, name);
    // Host names are unique. If malformed data is ambiguous, never guess a target.
    teamByName.set(name, prior === undefined ? member : prior?.id === member.id ? prior : null);
  }
  // turn -> label -> every child id and the subset explicitly sent work.
  const owners = new Map();
  const add = (turn, label, id, sent) => {
    let labels = owners.get(turn);
    if (!labels) { labels = new Map(); owners.set(turn, labels); }
    let group = labels.get(label);
    if (!group) { group = { ids: [], sentIds: [] }; labels.set(label, group); }
    if (!group.ids.includes(id)) group.ids.push(id);
    if (sent && !group.sentIds.includes(id)) group.sentIds.push(id);
  };
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (!entry || typeof entry.id !== 'string' || !Number.isFinite(entry.createdAt)) continue;
    const owner = windows.find(window => entry.createdAt >= window.from && entry.createdAt <= window.to);
    if (!owner) continue;
    const label = teamById.get(entry.id) ?? (typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : '子智能体');
    add(owner.turn, label, entry.id, false);
  }
  const loadedTurns = new Set(windows.map(window => window.turn));
  for (const [turn, targets] of targetsByTurn ?? []) {
    if (!loadedTurns.has(turn) || !Array.isArray(targets)) continue;
    for (const name of targets) {
      const member = typeof name === 'string' ? teamByName.get(name.trim()) : undefined;
      if (member) add(turn, member.name.trim(), member.id, true);
    }
  }
  for (const [turn, labels] of owners) {
    byTurn.set(turn, [...labels.entries()].map(([label, group]) => ({
      label, ids: group.ids, count: 1, ...(group.sentIds.length ? { sentIds: group.sentIds } : {}),
    })));
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

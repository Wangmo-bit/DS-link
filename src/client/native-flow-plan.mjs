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

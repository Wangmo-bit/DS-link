// Preserve the Host's root-entry order. Only a contiguous native process run
// and its immediately following same-Turn response may share one surface.
export function formatRunningElapsed(start, now) {
  if (!Number.isFinite(start) || !Number.isFinite(now)) return '思考中…';
  const seconds=Math.max(0,Math.floor((now-start)/1000));
  return `思考中 · ${seconds>=60 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${seconds} 秒`}`;
}
export function processAttention(node) {
  if (node?.kind !== 'tool-call') return '';
  const visit = root => {
    if (!root || typeof root !== 'object') return '';
    if (root.kind === 'tool-result' && (root.isError === true || root.error)) return '工具执行失败';
    const name=root.name ?? root.call?.name;
    if (root.kind !== 'tool-result' && (name === 'ask_user_question' || name === 'exit_plan_mode')) return '需要你的操作';
    for (const child of root.subCalls ?? []) { const value=visit(child); if(value)return value; }
    return '';
  };
  return visit(node.data?.root);
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

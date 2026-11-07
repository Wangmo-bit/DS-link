// Live host-contract regression: the node store is stable while its contents and
// timeline change. Catalog and transcript are deliberately delivered separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';

const output = await build({entryPoints:['src/client/native-flow.jsx'], bundle:true, write:false, format:'cjs', platform:'browser', external:['react','@deepseek-ai/*'], logLevel:'silent'});
const mod = {exports:{}};
new Function('require','module','exports',output.outputFiles[0].text)(name => name === 'react' ? React : {MarkdownText:()=>null}, mod, mod.exports);

// One hook slot array per component instance, including dependency-aware memo
// caching across renders. Effects are irrelevant to these snapshot assertions.
function renderer() {
  const instances = new Map();
  const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const equal = (a,b) => a && b && a.length === b.length && a.every((x,i) => Object.is(x,b[i]));
  function render(element) {
    const prior = dispatcher.current;
    function walk(value, path) {
      if (value == null || typeof value === 'boolean') return null;
      if (Array.isArray(value)) return value.map((v,i) => walk(v, `${path}/${v?.key ?? i}`)).filter(v => v != null);
      if (typeof value === 'string' || typeof value === 'number') return value;
      if (value.type === React.Fragment) return walk(value.props.children, `${path}/fragment`);
      if (typeof value.type === 'function') {
        const key = `${path}/${value.type.name}:${value.key ?? ''}`;
        let slots = instances.get(key); if (!slots) instances.set(key, slots = []);
        let cursor = 0;
        const memo = (fn,deps) => { const i=cursor++; if (!slots[i] || !equal(slots[i].deps,deps)) slots[i]={deps, value:fn()}; return slots[i].value; };
        dispatcher.current = {
          useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial === 'function' ? initial() : initial; return [slots[i], next => {slots[i]=typeof next === 'function' ? next(slots[i]) : next;}]; },
          useMemo: memo, useCallback(fn,deps) {return memo(()=>fn,deps);},
          useRef(initial) {const i=cursor++; if (!(i in slots)) slots[i]={current:initial}; return slots[i];},
          useSyncExternalStore(_subscribe,get) {cursor++; return get();},
          useEffect() {cursor++;}, useLayoutEffect() {cursor++;},
        };
        return walk(value.type(value.props), `${key}/out`);
      }
      return {type:value.type, props:value.props, children:walk(value.props.children, `${path}/children`)};
    }
    try { return walk(element, 'root'); } finally { dispatcher.current = prior; }
  }
  return render;
}
function flatten(value, result=[]) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) { for (const item of value) flatten(item,result); return result; }
  result.push(value); flatten(value.children,result); return result;
}
function badgesByTurn(tree) {
  const rows = flatten(tree).filter(n => n.props?.['data-chat-turn'] !== undefined);
  const result = new Map();
  for (const row of rows) {
    const badges=flatten(row).filter(n=>n.props?.['data-sl-agent-badges'] !== undefined);
    assert.ok(badges.length <= 1, `turn ${row.props['data-chat-turn']} has duplicated badge containers`);
    if (badges.length) {
      const turn=row.props['data-chat-turn'];
      assert.ok(!result.has(turn), `turn ${turn} has badges on multiple bubbles`);
      const icons=flatten(badges[0]).filter(n=>n.type==='svg').map(n=>n.props.className);
      result.set(turn,{label:badges[0].props['aria-label'],icons});
    }
  }
  return result;
}
const turn = (number, start, end) => ({turn:number, status:end == null ? 'open':'closed', start:{time:start}, ...(end == null ? {} : {end:{time:end}}), steps:[], data:{}});
function fixture() {
  const render = renderer(), backing = new Map();
  // ChatNodeStore implements get/values but is not itself a Map. Its reference
  // remains stable as the host replaces individual projected nodes.
  const nodes = {get:key=>backing.get(key), values:()=>[...backing.values()]};
  let timeline={turns:new Map(), turnOrder:[]}, entries=[], sessionId='one';
  let chatSelectors=[];
  let sessions={byId:{one:{title:'One'},two:{title:'Two'}},projectionsBySession:{one:{values:{subagentCatalog:[]}},two:{values:{subagentCatalog:[]}}}};
  const flow={pendingInputs:[], lastInputTurn:0, NativeFlow:()=>null,
    useChat:selector=>{chatSelectors.push(selector); return selector({nodes,timeline});}, useSessions:selector=>selector(sessions),
    useChatNode:(key,selector=x=>x)=>selector(nodes.get(key)), useChatGroup:()=>undefined,
    usePresentation:selector=>selector({foldCompletedTurns:true,stepGrouping:'collapsed'})};
  return {
    catalog(id, list, children) {sessions={...sessions,byId:{...sessions.byId,...children},projectionsBySession:{...sessions.projectionsBySession,[id]:{values:{subagentCatalog:list}}}};},
    load(turns) {
      backing.clear(); entries=[];
      for (const t of turns) {
        const key=`${sessionId}-${t.turn}`;
        backing.set(key,{kind:'turn-process',location:{kind:'turn',turn:t},data:{turn:t.turn,toolCallCount:1}});
        entries.push({kind:'node',key});
      }
      timeline={turns:new Map(turns.map(t=>[t.turn,t])),turnOrder:turns.map(t=>t.turn)};
    },
    setTimeline(turns) {timeline={turns:new Map(turns.map(t=>[t.turn,t])),turnOrder:turns.map(t=>t.turn)};},
    switchTo(id) {sessionId=id; this.load([]);},
    selection() {return chatSelectors.map(selector=>({selector,value:selector({nodes,timeline})}));},
    selectionChanged(previous) {return previous.some(({selector,value})=>!Object.is(value,selector({nodes,timeline})));},
    view() {chatSelectors=[]; return badgesByTurn(render(React.createElement(mod.exports.NativeFlowAdapter,{...flow,sessionId,entries})));},
  };
}

test('catalog before live timeline, ending, historical prepend, and session switch',()=>{
  const f=fixture();
  f.catalog('one',[
    {id:'a',label:'worker',createdAt:2200},
    {id:'b',label:'worker',createdAt:2300}, // same agent, not a second badge
    {id:'c',label:'unknown',createdAt:2400},
    {id:'historic',label:'older',createdAt:1200},
  ],{a:{running:true},b:{running:true},c:{running:false},historic:{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true}}}});
  assert.equal(f.view().size,0,'catalog alone has no loaded turn');
  const emptySelection=f.selection();
  f.load([turn(2,2000)]);
  assert.ok(f.selectionChanged(emptySelection),'a useChat selector must change when the timeline loads even though the node store is stable');
  let badges=f.view();
  assert.deepEqual([...badges.keys()],[2]);
  assert.match(badges.get(2).label,/2 个 agent/);
  assert.match(badges.get(2).label,/运行中 1 个/);
  assert.match(badges.get(2).label,/未确认 1 个/);
  assert.ok(badges.get(2).icons.some(c=>c.includes('--running')));
  assert.ok(badges.get(2).icons.some(c=>c.includes('--idle')));
  f.catalog('one',[
    {id:'a',label:'worker',createdAt:2200},{id:'b',label:'worker',createdAt:2300},
    {id:'c',label:'unknown',createdAt:2400},{id:'historic',label:'older',createdAt:1200},
  ],{a:{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true}}},b:{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true}}}});
  f.load([turn(2,2000,3000),turn(3,4000,5000)]);
  badges=f.view();
  assert.deepEqual([...badges.keys()],[2],'no badge on a turn without agents');
  assert.match(badges.get(2).label,/已完成 1 个/);
  assert.match(badges.get(2).label,/未确认 1 个/);
  assert.ok(badges.get(2).icons.some(c=>c.includes('--done')));
  assert.ok(badges.get(2).icons.some(c=>c.includes('--idle')));
  const beforeHistory=f.selection();
  f.load([turn(1,1000,1500),turn(2,2000,3000),turn(3,4000,5000)]);
  assert.ok(f.selectionChanged(beforeHistory),'history prepend notifies a timeline selector');
  badges=f.view();
  assert.deepEqual([...badges.keys()],[1,2], 'history load attributes each agent to its own turn');
  assert.match(badges.get(1).label,/已完成/);
  assert.match(badges.get(2).label,/2 个 agent/);
  f.catalog('two',[{id:'other',label:'separate',createdAt:2200}],{other:{running:false}});
  f.switchTo('two');
  assert.equal(f.view().size,0,'switch must not retain previous badges');
  f.load([turn(2,2000,3000)]);
  badges=f.view();
  assert.deepEqual([...badges.keys()],[2]);
  assert.match(badges.get(2).label,/本轮 1 个 agent，未确认/);
  assert.ok(badges.get(2).icons[0].includes('--idle'));
});

test('a turn ending updates its attribution without a catalog change',()=>{
  const f=fixture();
  f.catalog('one',[{id:'later',label:'later',createdAt:3500}],{later:{running:false,projectionValues:{subagentTiming:{lastTurnCompleted:true}}}});
  f.load([turn(2,2000)]);
  assert.match(f.view().get(2).label,/已完成/);
  const beforeEnd=f.selection();
  // The host may publish a boundary without changing any node or entry.
  f.setTimeline([turn(2,2000,3000)]);
  assert.ok(f.selectionChanged(beforeEnd),'the changed end boundary notifies a useChat selector');
  assert.equal(f.view().size,0,'a dispatch outside the closed window is not retained');
});

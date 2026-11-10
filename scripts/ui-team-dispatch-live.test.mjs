// Component-level Team dispatch regression. The miniature renderer below models
// keyed component instances, memo dependencies, committed effects/cleanups,
// state updates and external-store notifications. No user data is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {build} from 'esbuild';

const bundle=await build({entryPoints:['src/client/native-flow.jsx'],bundle:true,write:false,format:'cjs',platform:'browser',external:['react','@deepseek-ai/*'],logLevel:'silent'});
const mod={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(name=>name==='react'?React:{MarkdownText:()=>null},mod,mod.exports);

function createRenderer(root) {
  const instances=new Map();
  const dispatcher=React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
  const same=(a,b)=>a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
  let dirty=true, tree, renders=0;
  function invalidate(){dirty=true;}
  function renderOnce() {
    dirty=false; renders++;
    const prior=dispatcher.current, visited=new Set(), effects=[];
    function walk(value,path) {
      if(value==null || typeof value==='boolean') return null;
      if(Array.isArray(value)) return value.map((v,i)=>walk(v,`${path}/${v?.key ?? i}`)).filter(v=>v!=null);
      if(typeof value==='string'||typeof value==='number') return value;
      if(value.type===React.Fragment) return walk(value.props.children,`${path}/fragment`);
      if(typeof value.type==='function') {
        const key=`${path}/${value.type.name}:${value.key ?? ''}`;
        visited.add(key);
        let slots=instances.get(key); if(!slots) instances.set(key,slots=[]);
        let cursor=0;
        const memo=(fn,deps)=>{const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)) slots[i]={deps,value:fn()};return slots[i].value;};
        const effect=(fn,deps)=>{
          const i=cursor++, old=slots[i];
          if(!old||!same(old.deps,deps)) {
            const slot={deps,cleanup:old?.cleanup}; slots[i]=slot;
            effects.push(()=>{slot.cleanup?.(); slot.cleanup=fn() || undefined;});
          }
        };
        dispatcher.current={
          useState(initial){const i=cursor++;if(!(i in slots)) slots[i]={value:typeof initial==='function'?initial():initial};const slot=slots[i];return [slot.value,next=>{const value=typeof next==='function'?next(slot.value):next;if(!Object.is(value,slot.value)){slot.value=value;invalidate();}}];},
          useMemo:memo, useCallback(fn,deps){return memo(()=>fn,deps);},
          useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},
          useEffect:effect, useLayoutEffect:effect,
          useSyncExternalStore(subscribe,getSnapshot){
            const i=cursor++, previous=slots[i];
            if(!previous || previous.subscribe!==subscribe || previous.getSnapshot!==getSnapshot){
              const slot={subscribe,getSnapshot,cleanup:previous?.cleanup}; slots[i]=slot;
              effects.push(()=>{slot.cleanup?.();slot.cleanup=subscribe(invalidate);});
            }
            return getSnapshot();
          },
        };
        return walk(value.type(value.props),`${key}/out`);
      }
      return {type:value.type,props:value.props,children:walk(value.props.children,`${path}/children`)};
    }
    try {tree=walk(root(),'root');} finally {dispatcher.current=prior;}
    for(const [key,slots] of instances) if(!visited.has(key)) {
      for(const slot of slots) slot?.cleanup?.();
      instances.delete(key);
    }
    for(const run of effects) run();
  }
  return {
    invalidate,
    flush(){let iterations=0;while(dirty){assert.ok(++iterations<50,'render/effect loop did not settle');renderOnce();}return tree;},
    get renders(){return renders;},
    unmount(){for(const slots of instances.values())for(const slot of slots)slot?.cleanup?.();instances.clear();dirty=false;},
  };
}
function source() {
  let rows=[];const listeners=new Set();
  return {getSnapshot:()=>rows,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    publish(next){rows=next;for(const listener of [...listeners])listener();},
    get listeners(){return listeners.size;}};
}
const closed=(turn,start,end)=>({turn,status:'closed',start:{time:start},end:{time:end},steps:[],data:{}});
const send=(target,isError=false,callTime=210)=>({root:{kind:'tool-result',name:'send_message',call:{name:'send_message',argsRaw:JSON.stringify({target})},callTime,args:{text:key=>key==='target'?target:undefined},isError,content:[{type:'text',text:'{"sent":true}'}],subCalls:[]}});
function flatten(value,out=[]) {
  if(!value||typeof value!=='object')return out;
  if(Array.isArray(value)){value.forEach(v=>flatten(v,out));return out;}
  out.push(value);flatten(value.children,out);return out;
}
function badges(tree) {
  const result=new Map();
  for(const row of flatten(tree).filter(node=>node.props?.['data-chat-turn']!==undefined)) {
    const turn=row.props['data-chat-turn'];
    const found=flatten(row).filter(node=>node.props?.['data-sl-agent-badges']!==undefined);
    assert.ok(found.length<=1,`duplicate badge container in turn ${turn}`);
    if(found.length){assert.ok(!result.has(turn),`duplicate badge carrier in turn ${turn}`);result.set(turn,{label:found[0].props['aria-label'],icons:flatten(found[0]).filter(node=>node.type==='svg').map(node=>node.props.className)});}
  }
  return result;
}
function fixture() {
  const members=[{id:'member-a',name:'worker',role:'teammate',phase:'active'}];
  const turns=[closed(1,100,190),closed(2,200,290)];
  function chat(id) {
    const backing=new Map(), sources=new Map(), entries=[];
    for(const t of turns){const key=`${id}-${t.turn}`;entries.push({kind:'node',key});backing.set(key,{kind:'turn-process',location:{kind:'turn',turn:t},data:{turn:t.turn,toolCallCount:1}});sources.set(t.turn,source());}
    const nodes={get:key=>backing.get(key),values:()=>[...backing.values()],turnDataSource:(n,kind)=>{assert.equal(kind,'tool-call');return sources.get(n);}};
    return {nodes,sources,entries,timeline:{turns:new Map(turns.map(t=>[t.turn,t])),turnOrder:turns.map(t=>t.turn)}};
  }
  const chats={one:chat('one'),two:chat('two')};let sessionId='one';
  let sessions={byId:{one:{title:'One'},two:{title:'Two'},'member-a':{running:false,projectionValues:{subagentTiming:{},turnOutline:[{turn:1}]}}},projectionsBySession:{one:{values:{subagentCatalog:[]}},two:{values:{subagentCatalog:[]}}}};
  const flow={NativeFlow:()=>null,pendingInputs:[],lastInputTurn:0,
    useChat:selector=>selector({nodes:chats[sessionId].nodes,timeline:chats[sessionId].timeline}),
    useSessions:selector=>selector(sessions),useChatNode:(key,selector=x=>x)=>selector(chats[sessionId].nodes.get(key)),
    useChatGroup:()=>undefined,usePresentation:selector=>selector({foldCompletedTurns:true,stepGrouping:'collapsed'})};
  const root=()=>React.createElement(mod.exports.NativeFlowAdapter,{...flow,sessionId,entries:chats[sessionId].entries});
  let renderer=createRenderer(root);
  return {
    chats,
    roster(id,items=members){const prev=sessions.projectionsBySession[id]?.values ?? {};sessions={...sessions,projectionsBySession:{...sessions.projectionsBySession,[id]:{values:{...prev,agentTeam:{members:items}}}}};renderer.invalidate();},
    catalog(id,items){const prev=sessions.projectionsBySession[id]?.values ?? {};sessions={...sessions,projectionsBySession:{...sessions.projectionsBySession,[id]:{values:{...prev,subagentCatalog:items}}}};renderer.invalidate();},
    open(id,turn){const prior=chats[id].timeline,updated={...prior.turns.get(turn),status:'open',end:undefined};chats[id].timeline={...prior,turns:new Map([...prior.turns].map(([n,value])=>[n,n===turn?updated:value]))};renderer.invalidate();},
    status(running,since=220,turnCount=1){sessions={...sessions,byId:{...sessions.byId,'member-a':{running,projectionValues:{subagentTiming:{lastTurnCompleted:true,...(running&&since!==null?{active:{since,through:since}}:{})},...(turnCount===null?{}:{turnOutline:Array.from({length:turnCount},(_,i)=>({turn:i+1}))})}}}};renderer.invalidate();},
    switchTo(id){sessionId=id;renderer.invalidate();},
    refresh(){renderer.unmount();renderer=createRenderer(root);},
    view(){return badges(renderer.flush());},
    get renders(){return renderer.renders;},
    close(){renderer.unmount();},
  };
}
function single(map,turn,state){
  const spoken={running:'运行中',done:'已完成',failed:'失败',idle:'未确认'}[state];
  assert.deepEqual([...map.keys()],[turn]);
  assert.match(map.get(turn).label,new RegExp(`本轮 1 个 agent，${spoken}`));
  assert.equal(map.get(turn).icons.length,1);
  assert.ok(map.get(turn).icons[0].includes(`--${state}`));
}

test('live source notifications, roster arrival, reuse state, dedupe and remount',()=>{
  const f=fixture();
  try {
    assert.equal(f.view().size,0);
    const one=f.chats.one, source1=one.sources.get(1), source2=one.sources.get(2);
    source2.publish([send('worker')]); // before roster and before subscriptions
    assert.equal(f.view().size,0,'without roster no agent is invented');
    f.roster('one');
    single(f.view(),2,'idle'); // stale successful prior child turn is not proof
    assert.equal(source1.listeners,1);assert.equal(source2.listeners,1);
    const renderCount=f.renders;
    source2.publish([send('worker'),send('worker')]);
    single(f.view(),2,'idle');
    assert.ok(f.renders>renderCount,'external-store notification schedules rendering');
    f.catalog('one',[{id:'member-a',label:'different task description',createdAt:220}]);
    single(f.view(),2,'idle'); // creation plus same-turn send remains one
    f.status(true);single(f.view(),2,'running');
    f.status(false);single(f.view(),2,'done'); // created this turn and its only turn completed
    f.refresh();single(f.view(),2,'done'); // effect reconstructs the same proven completion
    assert.equal(source2.listeners,1,'refresh removed the old subscription');
    source2.publish([send('worker',true)]);
    // A newly-created catalog agent still exists, but a failed send must not
    // suppress its genuinely completed creation-state evidence.
    const created=f.view();
    assert.deepEqual([...created.keys()],[2]);assert.match(created.get(2).label,/已完成/);
    f.catalog('one',[]);assert.equal(f.view().size,0,'failed call alone is not a dispatch');
  } finally {f.close();}
});

test('sources and reported state do not leak across turns or sessions',()=>{
  const f=fixture();
  try {
    f.roster('one');assert.equal(f.view().size,0);
    const first=f.chats.one.sources, second=f.chats.two.sources;
    first.get(1).publish([send('worker')]);single(f.view(),1,'idle');
    f.roster('two');f.switchTo('two');assert.equal(f.view().size,0,'same turn number in another session is independent');
    assert.equal(first.get(1).listeners,0,'old session source unsubscribed');
    second.get(2).publish([send('worker')]);single(f.view(),2,'idle');
    first.get(1).publish([]);single(f.view(),2,'idle');
    f.switchTo('one');assert.equal(f.view().size,0,'return reads updated first-session source');
    first.get(2).publish([send('worker')]);single(f.view(),2,'idle');
  } finally {f.close();}
});

test('later team reuse cannot make an earlier turn appear to be running',()=>{
  const f=fixture();
  try {
    f.roster('one');
    f.catalog('one',[{id:'member-a',label:'original task',createdAt:120}]);
    f.chats.one.sources.get(2).publish([send('worker')]);
    // The only currently active child turn began during parent turn 2.
    f.status(true,220,2);
    let result=f.view();
    assert.deepEqual([...result.keys()],[1,2]);
    assert.ok(result.get(1).icons[0].includes('--idle'),'later activation must not paint the earlier turn blue');
    assert.ok(result.get(2).icons[0].includes('--running'),'the current turn can show the matching activity');
    f.status(false,220,2);
    result=f.view();
    assert.ok(result.get(1).icons[0].includes('--idle'),'the latest child completion is not proof for the earlier turn');
    assert.ok(result.get(2).icons[0].includes('--done'),'a run observed in this turn plus its completion proves the work finished');
  } finally {f.close();}
});

test('a prior activation cannot prove a later accepted message has begun',()=>{
  const f=fixture();
  try {
    f.roster('one');
    f.chats.one.sources.get(2).publish([send('worker')]);
    f.status(true,150,1); // running since the previous parent turn
    single(f.view(),2,'idle');
    f.open('one',2);
    single(f.view(),2,'idle'); // the same uncertainty applies to an open parent turn
    f.status(true,null,1);
    single(f.view(),2,'idle'); // running without a start time is also unproven
    f.status(true,200,1);
    single(f.view(),2,'idle'); // same-millisecond boundary cannot establish ordering
    f.status(true,205,1);
    single(f.view(),2,'idle'); // started within parent turn, but before the send at 210
    f.status(true,210,1);
    single(f.view(),2,'idle'); // same-millisecond send/start cannot establish order
    f.status(true,220,2);
    single(f.view(),2,'running'); // a child turn demonstrably started after the send
    f.chats.one.sources.get(2).publish([send('worker',false,null)]);
    single(f.view(),2,'idle'); // accepted and counted, but no call time to associate the run
    f.chats.one.sources.get(2).publish([send('worker',false,210)]);
    single(f.view(),2,'running'); // history backfill restores the timestamp evidence
  } finally {f.close();}
});

test('a running teammate listed in the catalog still needs this turn start proof',()=>{
  const f=fixture();
  try {
    f.roster('one');
    // A teammate can also appear as a direct catalog child; the live-running
    // override must not turn an older run into this message's run.
    f.catalog('one',[{id:'member-a',label:'worker',createdAt:120,mode:'continuable'}]);
    f.chats.one.sources.get(2).publish([send('worker')]);
    f.status(true,150,1); // running since the previous parent turn
    f.open('one',2);
    let view=f.view();
    assert.ok(view.get(2).icons[0].includes('--idle'),'an older run is not this message\'s run');
    f.status(true,220,2);
    view=f.view();
    assert.ok(view.get(2).icons[0].includes('--running'),'a start after the send is provable');
  } finally {f.close();}
});

test('a child start at or after a closed parent end cannot prove in-turn activity',()=>{
  const f=fixture();
  try {
    f.roster('one');f.chats.one.sources.get(2).publish([send('worker')]);
    f.status(true,289,2);single(f.view(),2,'running');
    f.status(true,290,2);single(f.view(),2,'idle');
    f.status(true,300,2);single(f.view(),2,'idle');
  } finally {f.close();}
});

test('a previous child turn may still run while a later accepted send is unconfirmed',()=>{
  const f=fixture();
  try {
    f.roster('one');
    f.catalog('one',[{id:'member-a',label:'original task',createdAt:120}]);
    f.chats.one.sources.get(2).publish([send('worker')]);
    f.status(true,150,1);
    const result=f.view();
    assert.deepEqual([...result.keys()],[1,2]);
    assert.ok(result.get(1).icons[0].includes('--running'),'the active child turn started within the earlier parent turn');
    assert.ok(result.get(2).icons[0].includes('--idle'),'the later message has no proven matching activation');
  } finally {f.close();}
});

test('a later activation cannot paint an older turn blue when the later call is not loaded',()=>{
  const f=fixture();
  try {
    f.roster('one');
    f.catalog('one',[{id:'member-a',label:'original task',createdAt:120}]);
    f.status(true,220,2);
    let result=f.view();
    assert.deepEqual([...result.keys()],[1]);
    assert.ok(result.get(1).icons[0].includes('--idle'));
    f.status(true,null,2); // running, but the Host has not supplied active.since
    result=f.view();
    assert.ok(result.get(1).icons[0].includes('--idle'),'unknown activation timing cannot be assigned to a closed historical turn');
    f.status(false,220,2);
    result=f.view();
    assert.ok(result.get(1).icons[0].includes('--idle'),'later completion must not be attributed to an older turn when later calls are unloaded');
    f.status(false,220,null);
    result=f.view();
    assert.ok(result.get(1).icons[0].includes('--idle'),'an absent turn outline cannot prove an old completion');
  } finally {f.close();}
});
